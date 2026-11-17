using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Seerr as an extension of the library: a person's whole filmography, what to watch or request
/// next to a title, and a collection's missing films. Reads run as the signed-in Jellyfin user, so
/// library matches follow their access; requests are made as their linked Seerr account.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public partial class SeerrExtensionController(
    UpstreamClient upstream,
    LibraryLookup library,
    ILibraryManager libraryManager,
    IUserManager userManager) : ControllerBase
{
    private const int RelatedLimit = 30;

    // Credits that are the person turning up as themselves: talk shows, archive footage, award nights.
    [GeneratedRegex(@"^\s*(self|himself|herself|themselves|archive footage)\b|archive footage", RegexOptions.IgnoreCase)]
    private static partial Regex SelfRole();

    /// <summary>A person: who they are and everything TMDB credits them with, as the viewer's library and Seerr see it.</summary>
    [HttpGet("discover/person/{tmdbId:int}")]
    public async Task<IActionResult> GetPerson([FromRoute] int tmdbId)
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

        var personTask = upstream.SeerrGetAsync($"api/v1/person/{tmdbId}?language=en", TimeSpan.FromMinutes(30));
        var creditsTask = upstream.SeerrGetAsync($"api/v1/person/{tmdbId}/combined_credits?language=en", TimeSpan.FromMinutes(10));
        var person = await personTask.ConfigureAwait(false);
        if (person is null)
        {
            return NotFound();
        }

        var credits = await creditsTask.ConfigureAwait(false);
        var knownFor = (string?)person["knownForDepartment"];
        return Ok(new
        {
            tmdbId,
            name = (string?)person["name"],
            role = RoleOf(knownFor),
            knownFor,
            biography = (string?)person["biography"],
            birthday = (string?)person["birthday"],
            deathday = (string?)person["deathday"],
            placeOfBirth = (string?)person["placeOfBirth"],
            profile = SeerrMapper.Image((string?)person["profilePath"], "w500"),
            jellyfinId = FindPerson(tmdbId),
            cast = Collect(credits?["cast"], crew: false, user),
            crew = Collect(credits?["crew"], crew: true, user),
        });
    }

    /// <summary>Recommendations, then similar titles, for the film or show a page is about.</summary>
    [HttpGet("discover/titles/{mediaType}/{tmdbId:int}/related")]
    public async Task<IActionResult> GetRelated([FromRoute] string mediaType, [FromRoute] int tmdbId)
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

        var type = mediaType == "tv" ? "tv" : "movie";
        var recommendedTask = upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}/recommendations?language=en", TimeSpan.FromMinutes(30));
        var similarTask = upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}/similar?language=en", TimeSpan.FromMinutes(30));
        var recommended = await recommendedTask.ConfigureAwait(false);
        var similar = await similarTask.ConfigureAwait(false);

        // TMDB's "similar" is keyword matching and noisy; only well-known titles are worth showing from it.
        var candidates = (recommended?["results"]?.AsArray() ?? [])
            .Concat((similar?["results"]?.AsArray() ?? []).Where(r => (r?["voteCount"]?.GetValue<int?>() ?? 0) >= 200));
        var seen = new HashSet<int> { tmdbId };
        var results = new List<object>();
        foreach (var node in candidates)
        {
            var id = node?["id"]?.GetValue<int?>();
            if (node is null || id is null || string.IsNullOrEmpty((string?)node["posterPath"]) || !seen.Add(id.Value))
            {
                continue;
            }

            results.Add(SeerrMapper.Item(node, user, library));
            if (results.Count >= RelatedLimit)
            {
                break;
            }
        }

        return Ok(new { results });
    }

    /// <summary>A TMDB collection: its films with the viewer's library and Seerr state, and which of them can be requested.</summary>
    [HttpGet("discover/collections/{id:int}")]
    public async Task<IActionResult> GetCollection([FromRoute] int id)
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

        var node = await upstream.SeerrGetAsync($"api/v1/collection/{id}?language=en", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        if (node is null)
        {
            return NotFound();
        }

        var parts = Parts(node);
        return Ok(new
        {
            id,
            name = (string?)node["name"],
            overview = (string?)node["overview"],
            poster = SeerrMapper.Image((string?)node["posterPath"], "w342"),
            backdrop = SeerrMapper.Image((string?)node["backdropPath"], "w1280"),
            parts = parts.Select(p => SeerrMapper.Item(p, user, library)).ToArray(),
            requestable = parts.Where(p => Requestable(p, user)).Select(p => p["id"]!.GetValue<int>()).ToArray(),
        });
    }

    /// <summary>Requests every film of a collection that is released and neither in the library nor already asked for.</summary>
    [HttpPost("discover/collections/{id:int}/request")]
    public async Task<IActionResult> RequestCollection([FromRoute] int id)
    {
        var settings = IntegrationSettings.Current;
        var user = CurrentUser();
        var seerrUser = user is null ? null : settings.SeerrUserFor(user.Username);
        if (user is null || !settings.SeerrEnabled || seerrUser is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { message = "Your account is not linked to Seerr." });
        }

        var node = await upstream.SeerrGetAsync($"api/v1/collection/{id}?language=en", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        if (node is null)
        {
            return NotFound();
        }

        var requested = 0;
        var failed = 0;
        foreach (var part in Parts(node).Where(p => Requestable(p, user)))
        {
            var payload = new JsonObject
            {
                ["mediaType"] = "movie",
                ["mediaId"] = part["id"]!.GetValue<int>(),
                ["is4k"] = false,
            };
            var (status, _) = await upstream.SeerrPostAsync("api/v1/request", payload, seerrUser.Value).ConfigureAwait(false);
            if (status is >= 200 and < 300)
            {
                requested++;
            }
            else
            {
                failed++;
            }
        }

        return Ok(new { requested, failed });
    }

    private static string? RoleOf(string? department) => department switch
    {
        "Acting" => "Actor",
        "Directing" => "Director",
        "Writing" => "Writer",
        "Production" => "Producer",
        "Sound" => "Composer",
        "Camera" => "Cinematographer",
        "Editing" => "Editor",
        "Creator" => "Creator",
        _ => department,
    };

    private static List<JsonNode> Parts(JsonNode collection)
    {
        var parts = new List<JsonNode>();
        foreach (var part in collection["parts"]?.AsArray() ?? [])
        {
            if (part is not null && part["id"] is not null)
            {
                parts.Add(part);
            }
        }

        // Release order; films with no date yet (announced, untitled) go last.
        return [.. parts.OrderBy(p => string.IsNullOrEmpty((string?)p["releaseDate"])).ThenBy(p => (string?)p["releaseDate"], StringComparer.Ordinal)];
    }

    private bool Requestable(JsonNode part, User user)
    {
        var released = DateTime.TryParse((string?)part["releaseDate"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)
            && date <= DateTime.UtcNow;
        return released
            && library.Find(user, "movie", part["id"]?.ToString()) is null
            && SeerrMapper.MediaStatus(part["mediaInfo"]?["status"]?.GetValue<int>() ?? 0) == "none";
    }

    // One entry per title: a person is credited once per role, so the roles gather under it.
    private List<object> Collect(JsonNode? list, bool crew, User user)
    {
        var byKey = new Dictionary<string, Credit>(StringComparer.Ordinal);
        var ordered = new List<Credit>();
        foreach (var node in list?.AsArray() ?? [])
        {
            var type = (string?)node?["mediaType"];
            var id = node?["id"]?.GetValue<int?>();
            var title = (string?)node?["title"] ?? (string?)node?["name"];
            if (node is null || type is not ("movie" or "tv") || id is null || string.IsNullOrEmpty(title))
            {
                continue;
            }

            var key = $"{type}:{id}";
            if (!byKey.TryGetValue(key, out var credit))
            {
                credit = new Credit(node, type, id.Value, title);
                byKey[key] = credit;
                ordered.Add(credit);
            }

            var role = (string?)node[crew ? "job" : "character"];
            if (!string.IsNullOrWhiteSpace(role) && !credit.Roles.Contains(role))
            {
                credit.Roles.Add(role);
            }

            credit.Episodes = Math.Max(credit.Episodes, node["episodeCount"]?.GetValue<int?>() ?? 0);
        }

        return ordered
            .Select(c => (Credit: c, Match: library.Find(user, c.MediaType, c.TmdbId.ToString(CultureInfo.InvariantCulture))))
            // A title with no artwork has nothing to show, unless the library holds it.
            .Where(c => c.Match is not null || !string.IsNullOrEmpty((string?)c.Credit.Node["posterPath"]))
            .OrderByDescending(c => c.Credit.Node["popularity"]?.GetValue<double?>() ?? 0)
            .Select(c =>
            {
                var date = (string?)c.Credit.Node["releaseDate"] ?? (string?)c.Credit.Node["firstAirDate"];
                return (object)new
                {
                    tmdbId = c.Credit.TmdbId,
                    mediaType = c.Credit.MediaType,
                    title = c.Credit.Title,
                    year = SeerrMapper.Year(date),
                    releaseDate = date,
                    poster = SeerrMapper.Image((string?)c.Credit.Node["posterPath"], "w342"),
                    popularity = c.Credit.Node["popularity"]?.GetValue<double?>() ?? 0,
                    status = SeerrMapper.Status(c.Credit.Node, c.Match),
                    jellyfinId = SeerrMapper.JellyfinId(c.Match),
                    roles = c.Credit.Roles,
                    episodes = c.Credit.Episodes,
                    appearance = !crew && c.Credit.IsAppearance(),
                };
            })
            .ToList();
    }

    // Persons are library items too, found by the TMDB id their metadata carries.
    private string? FindPerson(int tmdbId)
    {
        var found = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.Person],
            HasAnyProviderId = new Dictionary<string, string>
            {
                [nameof(MediaBrowser.Model.Entities.MetadataProvider.Tmdb)] = tmdbId.ToString(CultureInfo.InvariantCulture),
            },
            Limit = 1,
        });
        return found.Count > 0 ? found[0].Id.ToString("N", CultureInfo.InvariantCulture) : null;
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    private sealed class Credit(JsonNode node, string mediaType, int tmdbId, string title)
    {
        public JsonNode Node { get; } = node;

        public string MediaType { get; } = mediaType;

        public int TmdbId { get; } = tmdbId;

        public string Title { get; } = title;

        public List<string> Roles { get; } = [];

        public int Episodes { get; set; }

        // "Self" on a talk show is a guest slot; "Self" across a season of a show is a cast member.
        public bool IsAppearance()
            => Roles.Count > 0
                ? Roles.All(r => SelfRole().IsMatch(r)) && (MediaType == "movie" || Episodes < 8)
                : MediaType == "tv" && Episodes <= 3;
    }
}
