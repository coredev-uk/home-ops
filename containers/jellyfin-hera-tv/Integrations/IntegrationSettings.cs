namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Where Seerr and Maintainerr live and how Jellyfin users map to Seerr users. Environment
/// variables (set from the cluster's secrets) win over the plugin's saved configuration, so the
/// API key never has to be typed into the dashboard.
/// </summary>
public sealed class IntegrationSettings
{
    public const string SeerrUrlVariable = "HERATV_SEERR_URL";
    public const string SeerrPublicUrlVariable = "HERATV_SEERR_PUBLIC_URL";
    public const string SeerrApiKeyVariable = "HERATV_SEERR_API_KEY";
    public const string SeerrUsersVariable = "HERATV_SEERR_USERS";
    public const string MaintainerrUrlVariable = "HERATV_MAINTAINERR_URL";

    private IntegrationSettings(
        Uri? seerrUrl,
        string? seerrPublicUrl,
        string? seerrApiKey,
        IReadOnlyDictionary<string, int> seerrUsers,
        Uri? maintainerrUrl)
    {
        SeerrUrl = seerrUrl;
        SeerrPublicUrl = seerrPublicUrl;
        SeerrApiKey = seerrApiKey;
        SeerrUsers = seerrUsers;
        MaintainerrUrl = maintainerrUrl;
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
                ParseUri(Inspect(MaintainerrUrlVariable, config.MaintainerrUrl).Value));
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
