namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Where Seerr and Maintainerr live and how Jellyfin users map to Seerr users. Environment
/// variables (set from the cluster's secrets) win over the plugin's saved configuration, so the
/// API key never has to be typed into the dashboard.
/// </summary>
public sealed class IntegrationSettings
{
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

    public static IntegrationSettings Current
    {
        get
        {
            var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
            return new IntegrationSettings(
                ParseUri(Pick("HERATV_SEERR_URL", config.SeerrUrl)),
                Pick("HERATV_SEERR_PUBLIC_URL", config.SeerrPublicUrl)?.TrimEnd('/'),
                Pick("HERATV_SEERR_API_KEY", config.SeerrApiKey),
                ParseUsers(Pick("HERATV_SEERR_USERS", config.SeerrUsers)),
                ParseUri(Pick("HERATV_MAINTAINERR_URL", config.MaintainerrUrl)));
        }
    }

    public int? SeerrUserFor(string username) => SeerrUsers.TryGetValue(username, out var id) ? id : null;

    private static string? Pick(string variable, string? fallback)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        if (!string.IsNullOrWhiteSpace(value))
        {
            return value.Trim();
        }

        return string.IsNullOrWhiteSpace(fallback) ? null : fallback.Trim();
    }

    private static Uri? ParseUri(string? value)
        => Uri.TryCreate(value?.TrimEnd('/') + "/", UriKind.Absolute, out var uri) ? uri : null;

    /// <summary>Parses <c>alice=1,bob=3</c> (commas, semicolons or whitespace between pairs).</summary>
    private static Dictionary<string, int> ParseUsers(string? value)
    {
        var users = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        if (value is null)
        {
            return users;
        }

        foreach (var pair in value.Split([',', ';', ' ', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && int.TryParse(parts[1], out var id))
            {
                users[parts[0].Trim()] = id;
            }
        }

        return users;
    }
}
