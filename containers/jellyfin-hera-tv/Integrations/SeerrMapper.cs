using System.Globalization;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Turns Seerr's TMDB-shaped records into what the web client draws: one title shape for every
/// list, search, person and collection, with the viewer's own library match and Seerr's state.
/// </summary>
public static class SeerrMapper
{
    private const string TmdbImage = "https://image.tmdb.org/t/p/";

    /// <summary>Maps a movie or TV record (<c>mediaType</c> set) to the client's title shape.</summary>
    public static object Item(JsonNode node, User user, LibraryLookup library)
    {
        var type = (string?)node["mediaType"] == "tv" ? "tv" : "movie";
        var tmdbId = node["id"]?.ToString();
        var inLibrary = library.Find(user, type, tmdbId);
        var date = (string?)node["releaseDate"] ?? (string?)node["firstAirDate"];
        return new
        {
            tmdbId = node["id"]?.GetValue<int>(),
            mediaType = type,
            title = (string?)node["title"] ?? (string?)node["name"],
            year = Year(date),
            releaseDate = date,
            overview = (string?)node["overview"],
            poster = Image((string?)node["posterPath"], "w342"),
            backdrop = Image((string?)node["backdropPath"], "w1280"),
            rating = node["voteAverage"]?.GetValue<double?>(),
            status = Status(node, inLibrary),
            jellyfinId = JellyfinId(inLibrary),
        };
    }

    /// <summary>Gets the four-digit year of an ISO date, or null.</summary>
    public static string? Year(string? date) => date is { Length: >= 4 } ? date[..4] : null;

    /// <summary>Gets the Jellyfin id of a library match in the form the client links with, or null.</summary>
    public static string? JellyfinId(BaseItem? inLibrary) => inLibrary?.Id.ToString("N", CultureInfo.InvariantCulture);

    /// <summary>Gets "available" for what the viewer's library holds, else Seerr's own state for the title.</summary>
    public static string Status(JsonNode node, BaseItem? inLibrary)
        => inLibrary is not null ? "available" : MediaStatus(node["mediaInfo"]?["status"]?.GetValue<int>() ?? 0);

    public static string? Image(string? path, string size) => string.IsNullOrEmpty(path) ? null : TmdbImage + size + path;

    // Seerr media status: 2 pending, 3 processing, 4 partly available, 5 available.
    public static string MediaStatus(int status) => status switch
    {
        2 => "pending",
        3 => "processing",
        4 => "partial",
        5 => "available",
        _ => "none",
    };

    // Seerr request status: 1 pending approval, 2 approved, 3 declined, 4 failed, 5 completed.
    public static string RequestStatus(int status) => status switch
    {
        1 => "pending",
        2 => "approved",
        3 => "declined",
        4 => "failed",
        5 => "available",
        _ => "pending",
    };

    public static string SeasonStatus(JsonNode title, int seasonNumber)
    {
        var season = title["mediaInfo"]?["seasons"]?.AsArray()
            .FirstOrDefault(s => s?["seasonNumber"]?.GetValue<int>() == seasonNumber);
        if (season is not null)
        {
            return MediaStatus(season["status"]?.GetValue<int>() ?? 0);
        }

        var requested = title["mediaInfo"]?["requests"]?.AsArray()
            .Where(r => r?["status"]?.GetValue<int>() is 1 or 2)
            .SelectMany(r => r?["seasons"]?.AsArray() ?? [])
            .Any(s => s?["seasonNumber"]?.GetValue<int>() == seasonNumber) ?? false;
        return requested ? "pending" : "none";
    }
}
