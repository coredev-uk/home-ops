using System.Globalization;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// The web client's window onto Seerr (discover, search, requests) and Maintainerr (what is
/// leaving). Every call runs as the signed-in Jellyfin user: library matches respect their access,
/// and requests are made as their linked Seerr user, never as the API key's owner.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public class DiscoverController(UpstreamClient upstream, LibraryLookup library, IUserManager userManager) : ControllerBase
{
    private static readonly Dictionary<string, string> Lists = new(StringComparer.OrdinalIgnoreCase)
    {
        ["trending"] = "api/v1/discover/trending",
        ["movies"] = "api/v1/discover/movies",
        ["tv"] = "api/v1/discover/tv",
        ["upcoming-movies"] = "api/v1/discover/movies/upcoming",
        ["upcoming-tv"] = "api/v1/discover/tv/upcoming",
    };

    [HttpGet("integrations")]
    public IActionResult GetIntegrations()
    {
        var settings = IntegrationSettings.Current;
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var user = CurrentUser();
        return Ok(new
        {
            seerr = settings.SeerrEnabled,
            seerrLinked = settings.SeerrEnabled && user is not null && settings.SeerrUserFor(user.Username) is not null,
            seerrUrl = settings.SeerrPublicUrl,
            maintainerr = settings.MaintainerrEnabled,
            sonarr = settings.Enabled(ArrService.Sonarr),
            radarr = settings.Enabled(ArrService.Radarr),
            sabnzbd = settings.Enabled(ArrService.Sabnzbd),
            activity = settings.ActivityEnabled,
            admin = User.IsInRole("Administrator"),
            features = IntegrationSettings.Features(config),
        });
    }

    [HttpGet("discover/lists/{list}")]
    public async Task<IActionResult> GetList([FromRoute] string list, [FromQuery] int page = 1)
    {
        if (!Lists.TryGetValue(list, out var path))
        {
            return NotFound();
        }

        return await Page($"{path}?page={Math.Clamp(page, 1, 20)}&language=en").ConfigureAwait(false);
    }

    [HttpGet("discover/search")]
    public async Task<IActionResult> Search([FromQuery] string query, [FromQuery] int page = 1)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return Ok(new { page = 1, totalPages = 0, results = Array.Empty<object>() });
        }

        // Seerr's search wants RFC 3986 escaping, including the characters EscapeDataString leaves.
        var escaped = Uri.EscapeDataString(query.Trim()).Replace("!", "%21", StringComparison.Ordinal)
            .Replace("'", "%27", StringComparison.Ordinal).Replace("(", "%28", StringComparison.Ordinal)
            .Replace(")", "%29", StringComparison.Ordinal).Replace("*", "%2A", StringComparison.Ordinal);
        return await Page($"api/v1/search?query={escaped}&page={Math.Clamp(page, 1, 20)}&language=en").ConfigureAwait(false);
    }

    [HttpGet("discover/titles/{mediaType}/{tmdbId:int}")]
    public async Task<IActionResult> GetTitle([FromRoute] string mediaType, [FromRoute] int tmdbId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var type = mediaType == "tv" ? "tv" : "movie";
        var node = await upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}?language=en", TimeSpan.FromMinutes(5)).ConfigureAwait(false);
        if (node is null)
        {
            return NotFound();
        }

        node["mediaType"] = type;
        var item = SeerrMapper.Item(node, user, library);
        var seasons = node["seasons"]?.AsArray()
            .Where(s => (s?["seasonNumber"]?.GetValue<int>() ?? 0) > 0)
            .Select(s => new
            {
                seasonNumber = s!["seasonNumber"]!.GetValue<int>(),
                name = (string?)s["name"],
                episodeCount = s["episodeCount"]?.GetValue<int>() ?? 0,
                status = SeerrMapper.SeasonStatus(node, s["seasonNumber"]!.GetValue<int>()),
            })
            .ToArray();
        var trailer = node["relatedVideos"]?.AsArray()
            .FirstOrDefault(v => (string?)v?["type"] == "Trailer" && (string?)v?["site"] == "YouTube");
        var cast = node["credits"]?["cast"]?.AsArray().Take(10).Select(c => new
        {
            name = (string?)c?["name"],
            character = (string?)c?["character"],
            id = c?["id"]?.GetValue<int?>(),
            photo = SeerrMapper.Image((string?)c?["profilePath"], "w185"),
        }).ToArray();

        return Ok(new
        {
            item,
            tagline = (string?)node["tagline"],
            runtime = node["runtime"]?.GetValue<int?>() ?? node["episodeRunTime"]?.AsArray().FirstOrDefault()?.GetValue<int?>(),
            genres = node["genres"]?.AsArray().Select(g => (string?)g?["name"]).Where(g => g is not null).ToArray() ?? [],
            certification = Certification(node, type),
            seasons = seasons ?? [],
            trailer = (string?)trailer?["url"],
            cast = cast ?? [],
        });
    }

    [HttpPost("discover/requests")]
    public async Task<IActionResult> CreateRequest([FromBody] RequestBody body)
    {
        var settings = IntegrationSettings.Current;
        var user = CurrentUser();
        var seerrUser = user is null ? null : settings.SeerrUserFor(user.Username);
        if (!settings.SeerrEnabled || seerrUser is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { message = "Your account is not linked to Seerr." });
        }

        var type = body.MediaType == "tv" ? "tv" : "movie";
        var payload = new JsonObject
        {
            ["mediaType"] = type,
            ["mediaId"] = body.TmdbId,
            ["is4k"] = false,
        };
        if (type == "tv")
        {
            payload["seasons"] = body.Seasons is { Length: > 0 } seasons
                ? new JsonArray(seasons.Select(s => (JsonNode)s).ToArray())
                : JsonValue.Create("all");
        }

        var (status, response) = await upstream.SeerrPostAsync("api/v1/request", payload, seerrUser.Value).ConfigureAwait(false);
        if (status is >= 200 and < 300)
        {
            return Ok(new { requestStatus = SeerrMapper.RequestStatus(response?["status"]?.GetValue<int>() ?? 1) });
        }

        return StatusCode(status >= 400 && status < 500 ? status : StatusCodes.Status502BadGateway, new
        {
            message = (string?)response?["message"] ?? "Seerr did not accept the request.",
        });
    }

    [HttpGet("leaving")]
    public async Task<IActionResult> GetLeaving()
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (Plugin.Instance?.Configuration.LeavingSoonEnabled == false)
        {
            return Ok(Array.Empty<object>());
        }

        var collections = await upstream.MaintainerrGetAsync("api/collections", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        var leaving = new List<object>();
        foreach (var collection in collections?.AsArray() ?? [])
        {
            if (collection?["isActive"]?.GetValue<bool>() != true)
            {
                continue;
            }

            var days = collection["deleteAfterDays"]?.GetValue<int?>() ?? 0;
            var type = (string?)collection["type"] == "show" ? "tv" : "movie";
            foreach (var media in collection["media"]?.AsArray() ?? [])
            {
                var tmdbId = media?["tmdbId"]?.ToString();
                var item = library.Find(user, type, tmdbId);
                if (item is null
                    || !DateTime.TryParse((string?)media!["addDate"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var added))
                {
                    continue;
                }

                leaving.Add(new
                {
                    jellyfinId = item.Id.ToString("N", CultureInfo.InvariantCulture),
                    name = item.Name,
                    type,
                    leavesOn = added.AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                });
            }
        }

        return Ok(leaving);
    }

    private async Task<IActionResult> Page(string pathAndQuery)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return NotFound();
        }

        var node = await upstream.SeerrGetAsync(pathAndQuery, TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        var results = node?["results"]?.AsArray()
            .Where(r => (string?)r?["mediaType"] is "movie" or "tv")
            .Select(r => SeerrMapper.Item(r!, user, library))
            .ToArray() ?? [];
        return Ok(new
        {
            page = node?["page"]?.GetValue<int>() ?? 1,
            totalPages = node?["totalPages"]?.GetValue<int>() ?? 0,
            results,
        });
    }

    private static string? Certification(JsonNode title, string type)
    {
        if (type == "movie")
        {
            var gb = title["releases"]?["results"]?.AsArray().FirstOrDefault(r => (string?)r?["iso_3166_1"] == "GB");
            return gb?["release_dates"]?.AsArray().Select(d => (string?)d?["certification"]).FirstOrDefault(c => !string.IsNullOrEmpty(c));
        }

        var rating = title["contentRatings"]?["results"]?.AsArray().FirstOrDefault(r => (string?)r?["iso_3166_1"] == "GB");
        return (string?)rating?["rating"];
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    public sealed class RequestBody
    {
        public string MediaType { get; set; } = "movie";

        public int TmdbId { get; set; }

        public int[]? Seasons { get; set; }
    }
}
