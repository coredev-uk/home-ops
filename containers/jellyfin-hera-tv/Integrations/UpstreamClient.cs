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
}
