using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Hera TV: an Apple TV-style look and home hero for Jellyfin's web client.</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Hera TV";

    public override Guid Id => Guid.Parse("9718b214-55d6-4828-84c8-677f2a4a131b");

    /// <summary>The name the dashboard page is addressed by: <c>#/configurationpage?name=HeraTV</c>.</summary>
    public const string SettingsPage = "HeraTV";

    /// <summary>Gets the dashboard's settings page (HTML plus its script) and its place in the sidebar.</summary>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = SettingsPage,
            DisplayName = "Hera TV",
            EmbeddedResourcePath = "heratv-settings.html",
            EnableInMainMenu = true,
            MenuSection = "server",
            MenuIcon = "tv",
        };
        yield return new PluginPageInfo
        {
            Name = "heratv-settings.js",
            EmbeddedResourcePath = "heratv-settings.js",
        };
    }

    public override string Description => "Apple TV-style theme, personalised home, Discover with Seerr requests and Maintainerr's Leaving Soon for the web client.";
}

/// <summary>Settings read by the web client through <c>/HeraTV/config</c>.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets a value indicating whether the stylesheet and script are injected.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets or sets how many titles the home hero rotates through.</summary>
    public int HeroItemCount { get; set; } = 8;

    /// <summary>Gets or sets how long each hero title stays before the next, in seconds.</summary>
    public int HeroIntervalSeconds { get; set; } = 8;

    /// <summary>Gets or sets a value indicating whether the Discover tab shows.</summary>
    public bool DiscoverEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether Maintainerr's Leaving Soon row and chip show.</summary>
    public bool LeavingSoonEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the Your Requests row shows on the home page.</summary>
    public bool RequestsRowEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether title pages list the streaming services that carry the title.</summary>
    public bool ElsewhereEnabled { get; set; } = true;

    /// <summary>Gets or sets the ISO 3166-1 country whose streaming services "Also on" lists.</summary>
    public string WatchRegion { get; set; } = "GB";

    /// <summary>Gets or sets a value indicating whether title pages show IMDb and Rotten Tomatoes scores.</summary>
    public bool RatingsEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether 4K, HDR, Dolby Vision and Atmos badges show.</summary>
    public bool QualityBadgesEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the Trending to Request row shows on the home page.</summary>
    public bool TrendingRowEnabled { get; set; } = true;

    // Integrations. HERATV_* environment variables take precedence over these.

    /// <summary>Gets or sets the Seerr URL the server calls.</summary>
    public string? SeerrUrl { get; set; }

    /// <summary>Gets or sets the Seerr URL people open in a browser.</summary>
    public string? SeerrPublicUrl { get; set; }

    /// <summary>Gets or sets the Seerr API key.</summary>
    public string? SeerrApiKey { get; set; }

    /// <summary>Gets or sets Jellyfin username to Seerr user id pairs, as <c>alice=1,bob=3</c>.</summary>
    public string? SeerrUsers { get; set; }

    /// <summary>Gets or sets the Maintainerr URL the server calls.</summary>
    public string? MaintainerrUrl { get; set; }
}
