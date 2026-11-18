using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>Calls Seerr and Maintainerr from the server, with a short shared cache for reads.</summary>
public sealed class UpstreamClient(ILogger<UpstreamClient> logger)
{
    private static readonly HttpClient Http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(15),
    };

    private readonly ConcurrentDictionary<string, (DateTime Expires, Task<JsonNode?> Value)> _cache = new();

    /// <summary>Reads JSON from Seerr. <paramref name="asUser"/> sets <c>X-Api-User</c> for per-user reads.</summary>
    public Task<JsonNode?> SeerrGetAsync(string pathAndQuery, TimeSpan cacheFor, int? asUser = null)
    {
        var settings = IntegrationSettings.Current;
        if (!settings.SeerrEnabled)
        {
            return Task.FromResult<JsonNode?>(null);
        }

        var key = $"seerr|{asUser}|{pathAndQuery}";
        return Cached(key, cacheFor, () => SendAsync(HttpMethod.Get, new Uri(settings.SeerrUrl!, pathAndQuery), settings, asUser, null));
    }

    /// <summary>Sends a write to Seerr as <paramref name="asUser"/>; never cached.</summary>
    public async Task<(int Status, JsonNode? Body)> SeerrPostAsync(string path, JsonNode body, int asUser)
    {
        var settings = IntegrationSettings.Current;
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(settings.SeerrUrl!, path))
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Add("X-Api-Key", settings.SeerrApiKey);
        request.Headers.Add("X-Api-User", asUser.ToString(System.Globalization.CultureInfo.InvariantCulture));
        using var response = await Http.SendAsync(request).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        // A write changes request and availability state: drop cached reads.
        _cache.Clear();
        return ((int)response.StatusCode, string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text));
    }

    /// <summary>Reads JSON from Maintainerr, which this cluster serves without auth inside the cluster.</summary>
    public Task<JsonNode?> MaintainerrGetAsync(string path, TimeSpan cacheFor)
    {
        var settings = IntegrationSettings.Current;
        if (!settings.MaintainerrEnabled)
        {
            return Task.FromResult<JsonNode?>(null);
        }

        return Cached($"maintainerr|{path}", cacheFor, () => SendAsync(HttpMethod.Get, new Uri(settings.MaintainerrUrl!, path), settings, null, null));
    }

    private static readonly TimeSpan ArrTimeout = TimeSpan.FromSeconds(6);
    private static readonly TimeSpan ArrBackoff = TimeSpan.FromSeconds(15);
    private readonly ConcurrentDictionary<ArrService, DateTime> _arrDownUntil = new();

    /// <summary>
    /// Reads JSON from Sonarr, Radarr (<c>api/v3/...</c>) or SABnzbd (<c>api?mode=...</c>). Fails
    /// soft: a missing setting, an error or a service that stopped answering gives null, and a
    /// service that failed is left alone for a few seconds instead of stalling every page on it.
    /// </summary>
    public Task<JsonNode?> ArrGetAsync(ArrService service, string pathAndQuery, TimeSpan cacheFor)
    {
        var (url, key) = IntegrationSettings.Current.Endpoint(service);
        if (url is null || string.IsNullOrEmpty(key) || (_arrDownUntil.TryGetValue(service, out var until) && until > DateTime.UtcNow))
        {
            return Task.FromResult<JsonNode?>(null);
        }

        var cacheKey = $"{service}|{pathAndQuery}";
        return Cached(cacheKey, cacheFor, () => SendArrAsync(service, url, key, pathAndQuery, cacheKey));
    }

    private async Task<JsonNode?> SendArrAsync(ArrService service, Uri baseUri, string key, string pathAndQuery, string cacheKey)
    {
        // SABnzbd takes its key and the JSON switch in the query; Sonarr and Radarr in a header.
        var target = service == ArrService.Sabnzbd
            ? $"{pathAndQuery}&output=json&apikey={Uri.EscapeDataString(key)}"
            : pathAndQuery;
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, target));
        if (service != ArrService.Sabnzbd)
        {
            request.Headers.Add("X-Api-Key", key);
        }

        using var timeout = new CancellationTokenSource(ArrTimeout);
        try
        {
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            _arrDownUntil.TryRemove(service, out _);
            if (!response.IsSuccessStatusCode)
            {
                if (response.StatusCode != System.Net.HttpStatusCode.NotFound)
                {
                    logger.LogWarning("Hera TV: {Service} {Path} returned {Status}", service, pathAndQuery.Split('?')[0], (int)response.StatusCode);
                }

                return null;
            }

            var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            // SABnzbd answers a wrong key or a bad mode with HTTP 200 and an error object.
            return service == ArrService.Sabnzbd && body?["error"] is not null ? null : body;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or System.Text.Json.JsonException)
        {
            _arrDownUntil[service] = DateTime.UtcNow + ArrBackoff;
            _cache.TryRemove(cacheKey, out _);
            logger.LogWarning("Hera TV: {Service} {Path} failed: {Reason}", service, pathAndQuery.Split('?')[0], ex.GetType().Name);
            return null;
        }
    }

    private Task<JsonNode?> Cached(string key, TimeSpan cacheFor, Func<Task<JsonNode?>> load)
    {
        var now = DateTime.UtcNow;
        if (_cache.TryGetValue(key, out var hit) && hit.Expires > now && !hit.Value.IsFaulted)
        {
            return hit.Value;
        }

        var task = load();
        // Searches make keys without bound; a small household never needs more than this.
        if (_cache.Count > 500)
        {
            _cache.Clear();
        }

        _cache[key] = (now + cacheFor, task);
        return task;
    }

    private async Task<JsonNode?> SendAsync(HttpMethod method, Uri uri, IntegrationSettings settings, int? asUser, JsonNode? body)
    {
        using var request = new HttpRequestMessage(method, uri);
        if (settings.SeerrUrl is not null && uri.Host == settings.SeerrUrl.Host)
        {
            request.Headers.Add("X-Api-Key", settings.SeerrApiKey);
            if (asUser is int user)
            {
                request.Headers.Add("X-Api-User", user.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        try
        {
            using var response = await Http.SendAsync(request).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Hera TV: {Method} {Path} returned {Status}", method, uri.AbsolutePath, (int)response.StatusCode);
                return null;
            }

            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Hera TV: {Method} {Path} failed", method, uri.AbsolutePath);
            return null;
        }
    }

    /// <summary>What a connection test saw: the HTTP status and JSON body, or why nothing answered.</summary>
    public sealed record Probe(int? Status, JsonNode? Body, string? Failure);

    /// <summary>Drops cached reads, so a changed URL or key never serves the old server's answers.</summary>
    public void ClearCache()
    {
        _cache.Clear();
        _arrDownUntil.Clear();
    }

    /// <summary>One uncached GET against a base URL that may not be saved yet: the settings page's Test connection.</summary>
    public async Task<Probe> ProbeAsync(Uri baseUri, string path, string? apiKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, path));
        if (!string.IsNullOrEmpty(apiKey))
        {
            request.Headers.Add("X-Api-Key", apiKey);
        }

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        try
        {
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            JsonNode? body = null;
            try
            {
                body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            }
            catch (System.Text.Json.JsonException)
            {
                // An HTML page or plain text: the status alone says what it was.
            }

            return new Probe((int)response.StatusCode, body, null);
        }
        catch (OperationCanceledException)
        {
            return new Probe(null, null, "No answer within 8 seconds.");
        }
        catch (HttpRequestException ex)
        {
            return new Probe(null, null, ex.InnerException?.Message ?? ex.Message);
        }
    }
}
