namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>The download stack Hera TV reads: Sonarr and Radarr for what is wanted and queued, SABnzbd for speed.</summary>
public enum ArrService
{
    Sonarr,
    Radarr,
    Sabnzbd,
}

/// <summary>Where one arr service's settings live: the variables that override them and the saved fields.</summary>
public sealed record ArrDefinition(
    ArrService Service,
    string Id,
    string Name,
    string UrlVariable,
    string KeyVariable,
    string PublicUrlVariable,
    Func<PluginConfiguration, string?> SavedUrl,
    Func<PluginConfiguration, string?> SavedKey,
    Func<PluginConfiguration, string?> SavedPublic,
    Action<PluginConfiguration, string?> SetUrl,
    Action<PluginConfiguration, string?> SetKey,
    Action<PluginConfiguration, string?> SetPublic);

/// <summary>
/// Where Seerr, Maintainerr and the download stack live and how Jellyfin users map to Seerr users.
/// Environment variables (set from the cluster's secrets) win over the plugin's saved
/// configuration, so an API key never has to be typed into the dashboard.
/// </summary>
public sealed class IntegrationSettings
{
    public const string SeerrUrlVariable = "HERATV_SEERR_URL";
    public const string SeerrPublicUrlVariable = "HERATV_SEERR_PUBLIC_URL";
    public const string SeerrApiKeyVariable = "HERATV_SEERR_API_KEY";
    public const string SeerrUsersVariable = "HERATV_SEERR_USERS";
    public const string MaintainerrUrlVariable = "HERATV_MAINTAINERR_URL";

    /// <summary>The download stack's settings, in the order the dashboard lists them.</summary>
    public static readonly IReadOnlyList<ArrDefinition> Arr =
    [
        new(ArrService.Sonarr, "sonarr", "Sonarr", "HERATV_SONARR_URL", "HERATV_SONARR_API_KEY", "HERATV_SONARR_PUBLIC_URL", c => c.SonarrUrl, c => c.SonarrApiKey, c => c.SonarrPublicUrl, (c, v) => c.SonarrUrl = v, (c, v) => c.SonarrApiKey = v, (c, v) => c.SonarrPublicUrl = v),
        new(ArrService.Radarr, "radarr", "Radarr", "HERATV_RADARR_URL", "HERATV_RADARR_API_KEY", "HERATV_RADARR_PUBLIC_URL", c => c.RadarrUrl, c => c.RadarrApiKey, c => c.RadarrPublicUrl, (c, v) => c.RadarrUrl = v, (c, v) => c.RadarrApiKey = v, (c, v) => c.RadarrPublicUrl = v),
        new(ArrService.Sabnzbd, "sabnzbd", "SABnzbd", "HERATV_SABNZBD_URL", "HERATV_SABNZBD_API_KEY", "HERATV_SABNZBD_PUBLIC_URL", c => c.SabnzbdUrl, c => c.SabnzbdApiKey, c => c.SabnzbdPublicUrl, (c, v) => c.SabnzbdUrl = v, (c, v) => c.SabnzbdApiKey = v, (c, v) => c.SabnzbdPublicUrl = v),
    ];

    private readonly IReadOnlyDictionary<ArrService, (Uri? Url, string? Key)> _arr;
    private readonly IReadOnlyDictionary<ArrService, string?> _public;

    private IntegrationSettings(
        Uri? seerrUrl,
        string? seerrPublicUrl,
        string? seerrApiKey,
        IReadOnlyDictionary<string, int> seerrUsers,
        Uri? maintainerrUrl,
        IReadOnlyDictionary<ArrService, (Uri? Url, string? Key)> arr,
        IReadOnlyDictionary<ArrService, string?> publicUrls)
    {
        SeerrUrl = seerrUrl;
        SeerrPublicUrl = seerrPublicUrl;
        SeerrApiKey = seerrApiKey;
        SeerrUsers = seerrUsers;
        MaintainerrUrl = maintainerrUrl;
        _arr = arr;
        _public = publicUrls;
    }

    /// <summary>Gets the Seerr base URL the server calls (cluster-internal).</summary>
    public Uri? SeerrUrl { get; }

    /// <summary>Gets the Seerr URL people open in a browser.</summary>
    public string? SeerrPublicUrl { get; }

    /// <summary>Gets the Seerr API key; it never leaves the server.</summary>
    public string? SeerrApiKey { get; }

    /// <summary>Gets the Jellyfin username to Seerr user id map; requests are made as that user.</summary>
    public IReadOnlyDictionary<string, int> SeerrUsers { get; }

    /// <summary>Gets the Maintainerr base URL the server calls (cluster-internal).</summary>
    public Uri? MaintainerrUrl { get; }

    public bool SeerrEnabled => SeerrUrl is not null && !string.IsNullOrEmpty(SeerrApiKey);

    public bool MaintainerrEnabled => MaintainerrUrl is not null;

    /// <summary>Gets the address and key of one arr service; either is null when not set.</summary>
    public (Uri? Url, string? Key) Endpoint(ArrService service) => _arr.GetValueOrDefault(service);

    /// <summary>Gets the address people open a service at in a browser, without a trailing slash; null when not set.</summary>
    public string? PublicUrl(ArrService service) => _public.GetValueOrDefault(service);

    /// <summary>Gets a value indicating whether a service has both its address and its key.</summary>
    public bool Enabled(ArrService service) => Endpoint(service) is { Url: not null, Key: { Length: > 0 } };

    /// <summary>Gets a value indicating whether Sonarr or Radarr is connected: what request state is read from.</summary>
    public bool ActivityEnabled => Enabled(ArrService.Sonarr) || Enabled(ArrService.Radarr);

    /// <summary>The server-wide switches the web client and the dashboard read.</summary>
    public static object Features(PluginConfiguration config) => new
    {
        discover = config.DiscoverEnabled,
        leavingSoon = config.LeavingSoonEnabled,
        requests = config.RequestsRowEnabled,
        trending = config.TrendingRowEnabled,
        elsewhere = config.ElsewhereEnabled,
        ratings = config.RatingsEnabled,
        qualityBadges = config.QualityBadgesEnabled,
        activity = config.ActivityEnabled,
    };

    public static IntegrationSettings Current
    {
        get
        {
            var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
            return new IntegrationSettings(
                ParseUri(Inspect(SeerrUrlVariable, config.SeerrUrl).Value),
                Inspect(SeerrPublicUrlVariable, config.SeerrPublicUrl).Value?.TrimEnd('/'),
                Inspect(SeerrApiKeyVariable, config.SeerrApiKey).Value,
                ParseUsers(Inspect(SeerrUsersVariable, config.SeerrUsers).Value),
                ParseUri(Inspect(MaintainerrUrlVariable, config.MaintainerrUrl).Value),
                Arr.ToDictionary(
                    d => d.Service,
                    d => (ParseUri(Inspect(d.UrlVariable, d.SavedUrl(config)).Value), Inspect(d.KeyVariable, d.SavedKey(config)).Value)),
                Arr.ToDictionary(
                    d => d.Service,
                    d => Inspect(d.PublicUrlVariable, d.SavedPublic(config)).Value?.TrimEnd('/')));
        }
    }

    /// <summary>
    /// Where a setting's effective value comes from: the server's environment (which always
    /// wins), the plugin's saved configuration, or nowhere.
    /// </summary>
    /// <param name="Value">The effective value, trimmed; null when unset.</param>
    /// <param name="Source">"env", "config" or "unset".</param>
    /// <param name="Variable">The environment variable that would override the saved value.</param>
    public readonly record struct Field(string? Value, string Source, string Variable)
    {
        public bool Locked => Source == "env";
    }

    public static Field Inspect(string variable, string? saved)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        if (!string.IsNullOrWhiteSpace(value))
        {
            return new Field(value.Trim(), "env", variable);
        }

        return string.IsNullOrWhiteSpace(saved)
            ? new Field(null, "unset", variable)
            : new Field(saved.Trim(), "config", variable);
    }

    // A name runs up to its "=", so Jellyfin names with spaces work; a pair ends at its digits, so
    // commas, semicolons, new lines or plain spaces may separate pairs.
    private static readonly System.Text.RegularExpressions.Regex UserPair = new(@"\s*([^=,;\n]+?)\s*=\s*(\d+)");

    /// <summary>Parses <c>alice=1,bob=3</c> (commas, semicolons or whitespace between pairs).</summary>
    public static Dictionary<string, int> ParseUsers(string? value)
    {
        var users = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Text.RegularExpressions.Match pair in UserPair.Matches(value ?? string.Empty))
        {
            if (int.TryParse(pair.Groups[2].Value, out var id))
            {
                users[pair.Groups[1].Value] = id;
            }
        }

        return users;
    }

    public int? SeerrUserFor(string username) => SeerrUsers.TryGetValue(username, out var id) ? id : null;

    /// <summary>Parses an http(s) base URL, always ending in a slash so relative paths append to it.</summary>
    public static Uri? ParseUri(string? value)
        => !string.IsNullOrWhiteSpace(value)
            && Uri.TryCreate(value.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            ? uri
            : null;
}
