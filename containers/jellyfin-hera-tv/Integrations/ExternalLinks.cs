namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Where "Open in Seerr / Radarr / Sonarr / SABnzbd" buttons point, from each service's public
/// address. Seerr's link is for everyone; the download stack's are administrators' only, so a
/// non-admin response never names those services at all.
/// </summary>
public static class ExternalLinks
{
    /// <summary>
    /// Links for one title. Null properties drop out of the JSON, and so does the whole object when
    /// nothing applies. <paramref name="slug"/> is the *arr's own title slug.
    /// </summary>
    public static object? For(IntegrationSettings settings, bool admin, string mediaType, int? tmdbId, ArrService? service, string? slug)
    {
        var tv = mediaType == "tv";
        var seerr = tmdbId is int id && settings.SeerrEnabled && !string.IsNullOrEmpty(settings.SeerrPublicUrl)
            ? $"{settings.SeerrPublicUrl}/{(tv ? "tv" : "movie")}/{id}"
            : null;
        string? arr = null;
        if (admin && service is ArrService which && which != ArrService.Sabnzbd && !string.IsNullOrEmpty(slug) && settings.PublicUrl(which) is { Length: > 0 } baseUrl)
        {
            arr = $"{baseUrl}/{(which == ArrService.Radarr ? "movie" : "series")}/{Uri.EscapeDataString(slug)}";
        }

        if (seerr is null && arr is null)
        {
            return null;
        }

        return new
        {
            seerr,
            radarr = service == ArrService.Radarr ? arr : null,
            sonarr = service == ArrService.Sonarr ? arr : null,
        };
    }

    /// <summary>The SABnzbd queue's address for an administrator; null otherwise.</summary>
    public static object? Sabnzbd(IntegrationSettings settings, bool admin)
        => admin && settings.PublicUrl(ArrService.Sabnzbd) is { Length: > 0 } baseUrl ? new { sabnzbd = $"{baseUrl}/" } : null;
}
