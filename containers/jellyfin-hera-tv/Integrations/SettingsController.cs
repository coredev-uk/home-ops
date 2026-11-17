using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What the dashboard's Hera TV page reads and writes. Admin only. HERATV_* environment variables
/// win over saved values, so each field reports where its effective value comes from and a save
/// leaves the fields the environment owns alone. The Seerr API key is write-only: it is accepted
/// here, never sent back.
/// </summary>
[ApiController]
[Authorize(Policy = "RequiresElevation")]
[Route("HeraTV/settings")]
public class SettingsController(UpstreamClient upstream) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(Describe());

    [HttpPost]
    public IActionResult Save([FromBody] SettingsBody body)
    {
        var plugin = Plugin.Instance;
        if (plugin is null)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "The plugin is not loaded." });
        }

        var config = plugin.Configuration;
        var seerrUrl = Writable(IntegrationSettings.SeerrUrlVariable, body.SeerrUrl);
        var seerrPublicUrl = Writable(IntegrationSettings.SeerrPublicUrlVariable, body.SeerrPublicUrl);
        var maintainerrUrl = Writable(IntegrationSettings.MaintainerrUrlVariable, body.MaintainerrUrl);
        foreach (var (label, value) in new[] { ("Seerr URL", seerrUrl), ("Seerr public URL", seerrPublicUrl), ("Maintainerr URL", maintainerrUrl) })
        {
            if (!string.IsNullOrWhiteSpace(value) && !IsWebAddress(value))
            {
                return BadRequest(new { message = $"{label} must be a full web address, such as http://seerr:5055." });
            }
        }

        if (seerrUrl is not null)
        {
            config.SeerrUrl = Clean(seerrUrl);
        }

        if (seerrPublicUrl is not null)
        {
            config.SeerrPublicUrl = Clean(seerrPublicUrl);
        }

        if (maintainerrUrl is not null)
        {
            config.MaintainerrUrl = Clean(maintainerrUrl);
        }

        if (!Locked(IntegrationSettings.SeerrApiKeyVariable))
        {
            if (body.ClearSeerrApiKey == true)
            {
                config.SeerrApiKey = null;
            }
            else if (!string.IsNullOrWhiteSpace(body.SeerrApiKey))
            {
                config.SeerrApiKey = body.SeerrApiKey.Trim();
            }
        }

        var users = Writable(IntegrationSettings.SeerrUsersVariable, body.SeerrUsers);
        if (users is not null)
        {
            var pairs = IntegrationSettings.ParseUsers(users).OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase);
            config.SeerrUsers = Clean(string.Join(",", pairs.Select(p => $"{p.Key}={p.Value}")));
        }

        config.HeroItemCount = Math.Clamp(body.HeroItemCount ?? config.HeroItemCount, 1, 20);
        config.HeroIntervalSeconds = Math.Clamp(body.HeroIntervalSeconds ?? config.HeroIntervalSeconds, 4, 60);
        config.DiscoverEnabled = body.DiscoverEnabled ?? config.DiscoverEnabled;
        config.LeavingSoonEnabled = body.LeavingSoonEnabled ?? config.LeavingSoonEnabled;
        config.RequestsRowEnabled = body.RequestsRowEnabled ?? config.RequestsRowEnabled;
        config.TrendingRowEnabled = body.TrendingRowEnabled ?? config.TrendingRowEnabled;

        plugin.SaveConfiguration();
        upstream.ClearCache();
        return Ok(Describe());
    }

    /// <summary>Tries Seerr with the form's values (or the saved ones): reachable, is Seerr, accepts the key.</summary>
    [HttpPost("test/seerr")]
    public async Task<IActionResult> TestSeerr([FromBody] ConnectionBody? body)
        => Ok(await CheckSeerr(body).ConfigureAwait(false));

    [HttpPost("test/maintainerr")]
    public async Task<IActionResult> TestMaintainerr([FromBody] ConnectionBody? body)
    {
        var field = IntegrationSettings.Inspect(IntegrationSettings.MaintainerrUrlVariable, Plugin.Instance?.Configuration.MaintainerrUrl);
        var raw = field.Locked ? field.Value : body?.Url ?? field.Value;
        var url = IntegrationSettings.ParseUri(raw);
        if (url is null)
        {
            return Ok(new { ok = false, message = "Enter the Maintainerr URL first." });
        }

        var host = url.GetLeftPart(UriPartial.Authority);
        var status = await upstream.ProbeAsync(url, "api/app/status", null).ConfigureAwait(false);
        if (status.Failure is not null)
        {
            return Ok(new { ok = false, message = $"Could not reach {host}: {status.Failure}" });
        }

        if (status.Status == 200 && status.Body?["version"] is { } version)
        {
            return Ok(new { ok = true, version = version.ToString(), message = $"Connected to Maintainerr {version}." });
        }

        // Older builds have no status route; their collections list says the same thing.
        var collections = await upstream.ProbeAsync(url, "api/collections", null).ConfigureAwait(false);
        if (collections.Status == 200 && collections.Body is System.Text.Json.Nodes.JsonArray list)
        {
            return Ok(new { ok = true, message = $"Connected to Maintainerr ({list.Count} collections)." });
        }

        return Ok(new { ok = false, message = $"{host} answered HTTP {status.Status} but does not look like Maintainerr. Check the URL." });
    }

    /// <summary>The Seerr accounts a Jellyfin user can be linked to.</summary>
    [HttpPost("seerr/users")]
    public async Task<IActionResult> SeerrUsers([FromBody] ConnectionBody? body)
    {
        var (url, key, problem) = ResolveSeerr(body);
        if (url is null || problem is not null)
        {
            return Ok(new { ok = false, message = problem, users = Array.Empty<object>() });
        }

        var reply = await upstream.ProbeAsync(url, "api/v1/user?take=100&sort=displayname", key).ConfigureAwait(false);
        if (reply.Status != 200 || reply.Body?["results"] is not System.Text.Json.Nodes.JsonArray results)
        {
            return Ok(new
            {
                ok = false,
                message = reply.Failure ?? (reply.Status is 401 or 403 ? "Seerr rejected the API key." : $"Seerr answered HTTP {reply.Status}."),
                users = Array.Empty<object>(),
            });
        }

        var users = results
            .Where(r => r?["id"] is not null)
            .Select(r => new
            {
                id = r!["id"]!.GetValue<int>(),
                displayName = (string?)r["displayName"] ?? (string?)r["username"] ?? $"User {r["id"]}",
                email = (string?)r["email"],
                username = (string?)r["jellyfinUsername"] ?? (string?)r["plexUsername"] ?? (string?)r["username"],
            })
            .OrderBy(u => u.displayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return Ok(new { ok = true, message = (string?)null, users });
    }

    private static object Describe()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var key = IntegrationSettings.Inspect(IntegrationSettings.SeerrApiKeyVariable, config.SeerrApiKey);
        var users = IntegrationSettings.Inspect(IntegrationSettings.SeerrUsersVariable, config.SeerrUsers);
        return new
        {
            seerr = new
            {
                url = Show(IntegrationSettings.Inspect(IntegrationSettings.SeerrUrlVariable, config.SeerrUrl)),
                publicUrl = Show(IntegrationSettings.Inspect(IntegrationSettings.SeerrPublicUrlVariable, config.SeerrPublicUrl)),
                apiKey = new { set = key.Value is not null, source = key.Source, variable = key.Variable },
                users = new
                {
                    value = users.Value,
                    source = users.Source,
                    variable = users.Variable,
                    links = IntegrationSettings.ParseUsers(users.Value).Select(p => new { username = p.Key, seerrId = p.Value }).ToArray(),
                },
            },
            maintainerr = new
            {
                url = Show(IntegrationSettings.Inspect(IntegrationSettings.MaintainerrUrlVariable, config.MaintainerrUrl)),
            },
            hero = new
            {
                count = Math.Clamp(config.HeroItemCount, 1, 20),
                intervalSeconds = Math.Clamp(config.HeroIntervalSeconds, 4, 60),
            },
            features = new
            {
                discover = config.DiscoverEnabled,
                leavingSoon = config.LeavingSoonEnabled,
                requests = config.RequestsRowEnabled,
                trending = config.TrendingRowEnabled,
            },
        };
    }

    private static object Show(IntegrationSettings.Field field) => new { value = field.Value, source = field.Source, variable = field.Variable };

    private static bool Locked(string variable) => IntegrationSettings.Inspect(variable, null).Locked;

    /// <summary>The submitted value, or null when it was not sent or the environment owns the field.</summary>
    private static string? Writable(string variable, string? submitted) => Locked(variable) ? null : submitted?.Trim();

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/');

    private static bool IsWebAddress(string value)
        => Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static (Uri? Url, string? Key, string? Problem) ResolveSeerr(ConnectionBody? body)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var urlField = IntegrationSettings.Inspect(IntegrationSettings.SeerrUrlVariable, config.SeerrUrl);
        var keyField = IntegrationSettings.Inspect(IntegrationSettings.SeerrApiKeyVariable, config.SeerrApiKey);
        var url = IntegrationSettings.ParseUri(urlField.Locked ? urlField.Value : body?.Url ?? urlField.Value);
        var key = keyField.Locked || string.IsNullOrWhiteSpace(body?.ApiKey) ? keyField.Value : body.ApiKey.Trim();
        if (url is null)
        {
            return (null, key, "Enter the Seerr URL first.");
        }

        return string.IsNullOrEmpty(key) ? (url, null, "Enter the Seerr API key first.") : (url, key, null);
    }

    private async Task<object> CheckSeerr(ConnectionBody? body)
    {
        var (url, key, problem) = ResolveSeerr(body);
        if (url is null)
        {
            return new { ok = false, message = problem };
        }

        var host = url.GetLeftPart(UriPartial.Authority);
        var status = await upstream.ProbeAsync(url, "api/v1/status", null).ConfigureAwait(false);
        if (status.Failure is not null)
        {
            return new { ok = false, message = $"Could not reach {host}: {status.Failure}" };
        }

        if (status.Status != 200 || status.Body?["version"] is not { } version)
        {
            return new { ok = false, message = $"{host} answered HTTP {status.Status} but does not look like Seerr. Check the URL." };
        }

        if (problem is not null)
        {
            return new { ok = false, version = version.ToString(), message = $"Reached Seerr {version}. {problem}" };
        }

        // /status is public; the settings route needs a valid key, which is the thing worth testing.
        var auth = await upstream.ProbeAsync(url, "api/v1/settings/main", key).ConfigureAwait(false);
        return auth.Status switch
        {
            200 => new { ok = true, version = version.ToString(), message = $"Connected to Seerr {version}. The API key works." },
            401 or 403 => new { ok = false, version = version.ToString(), message = $"Reached Seerr {version}, but it rejected the API key." },
            _ => new { ok = false, version = version.ToString(), message = $"Reached Seerr {version}, but the key check answered {(auth.Failure ?? $"HTTP {auth.Status}")}." },
        };
    }

    public sealed class ConnectionBody
    {
        public string? Url { get; set; }

        public string? ApiKey { get; set; }
    }

    public sealed class SettingsBody
    {
        public string? SeerrUrl { get; set; }

        public string? SeerrPublicUrl { get; set; }

        /// <summary>Gets or sets a new key; empty or absent keeps the saved one.</summary>
        public string? SeerrApiKey { get; set; }

        public bool? ClearSeerrApiKey { get; set; }

        public string? SeerrUsers { get; set; }

        public string? MaintainerrUrl { get; set; }

        public int? HeroItemCount { get; set; }

        public int? HeroIntervalSeconds { get; set; }

        public bool? DiscoverEnabled { get; set; }

        public bool? LeavingSoonEnabled { get; set; }

        public bool? RequestsRowEnabled { get; set; }

        public bool? TrendingRowEnabled { get; set; }
    }
}
