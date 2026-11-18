using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What Hera TV adds to a title that Jellyfin has no page for: where else it streams, how critics
/// rate it, what quality the file is, and the titles a person asked not to see again. Reads run as
/// the signed-in Jellyfin user. Seerr's API key stays here.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public partial class ExtrasController(
    UpstreamClient upstream,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IMediaSourceManager mediaSources) : ControllerBase
{
    private const int MaxProviders = 6;
    private const int MaxBadgeIds = 60;

    private static readonly TimeSpan BadgeTtl = TimeSpan.FromMinutes(30);
    private static readonly ConcurrentDictionary<Guid, (DateTime Expires, string[] Badges)> BadgeCache = new();

    // A provider offered again as an ad tier or as a channel inside another service adds nothing.
    [GeneratedRegex(@"\s+(Standard )?with Ads$|\s+(Amazon|Apple TV|Roku Premium|Prime Video) Channel$", RegexOptions.IgnoreCase)]
    private static partial Regex Variant();

    /// <summary>Quality badges, ratings and streaming providers for the film or series a page is about.</summary>
    [HttpGet("extras/{itemId:guid}")]
    public async Task<IActionResult> GetExtras([FromRoute] Guid itemId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var item = libraryManager.GetItemById(itemId);
        if (item is null || !item.IsVisible(user))
        {
            return NotFound();
        }

        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var type = item switch
        {
            Movie => "movie",
            Series => "tv",
            _ => null,
        };
        var seerr = IntegrationSettings.Current.SeerrEnabled;
        item.TryGetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb, out var tmdbId);
        var lookup = type is not null && seerr && !string.IsNullOrEmpty(tmdbId);

        var ratingsTask = lookup && config.RatingsEnabled ? Ratings(type!, tmdbId!) : Task.FromResult<object?>(null);
        var providersTask = lookup && config.ElsewhereEnabled ? Providers(type!, tmdbId!, config.WatchRegion) : Task.FromResult<object?>(null);
        var badges = config.QualityBadgesEnabled ? BadgesOf(item, user) : [];

        return Ok(new
        {
            badges,
            ratings = await ratingsTask.ConfigureAwait(false),
            providers = await providersTask.ConfigureAwait(false),
        });
    }

    /// <summary>Quality badges for many items at once, for the cards a page has on screen.</summary>
    [HttpGet("extras/badges")]
    public IActionResult GetBadges([FromQuery] string ids)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
        if (Plugin.Instance?.Configuration.QualityBadgesEnabled == false)
        {
            return Ok(result);
        }

        foreach (var raw in (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(MaxBadgeIds))
        {
            if (!Guid.TryParse(raw, out var id))
            {
                continue;
            }

            var item = libraryManager.GetItemById(id);
            if (item is not null && item.IsVisible(user))
            {
                result[id.ToString("N", CultureInfo.InvariantCulture)] = BadgesOf(item, user);
            }
        }

        Response.Headers.CacheControl = "private, max-age=300";
        return Ok(result);
    }

    /// <summary>The viewer's hidden titles: Up Next removals and "Not Interested", newest first.</summary>
    [HttpGet("hidden")]
    public IActionResult GetHidden()
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        return Ok(Describe(HiddenStore.Read(user.Id)));
    }

    [HttpPost("hidden")]
    public IActionResult Hide([FromBody] HideBody body)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (body.Scope is not (HiddenStore.UpNext or HiddenStore.Interest)
            || string.IsNullOrWhiteSpace(body.Key) || body.Key.Length > 100
            || string.IsNullOrWhiteSpace(body.Title))
        {
            return BadRequest(new { message = "Nothing to hide." });
        }

        var entry = new HiddenTitle
        {
            Scope = body.Scope,
            Key = body.Key.Trim(),
            Title = Clip(body.Title, 200)!,
            Year = Clip(body.Year, 12),
            Kind = Clip(body.Kind, 20),
            Image = body.Image is { } image && Uri.TryCreate(image, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && image.Length <= 500 ? image : null,
            Aliases = (body.Aliases ?? []).Where(a => !string.IsNullOrWhiteSpace(a) && a.Length <= 100).Select(a => a.Trim()).Distinct().Take(4).ToList(),
            At = DateTime.UtcNow,
        };
        return Ok(Describe(HiddenStore.Add(user.Id, entry)));
    }

    [HttpDelete("hidden")]
    public IActionResult Unhide([FromQuery] string scope, [FromQuery] string key)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        return Ok(Describe(HiddenStore.Remove(user.Id, scope, key)));
    }

    private static string? Clip(string? value, int length)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed.Length > length ? trimmed[..length] : trimmed;
    }

    private static object[] Describe(IEnumerable<HiddenTitle> list)
        => list.OrderByDescending(t => t.At).Select(t => (object)new
        {
            scope = t.Scope,
            key = t.Key,
            title = t.Title,
            year = t.Year,
            kind = t.Kind,
            image = t.Image,
            aliases = t.Aliases,
            at = t.At,
        }).ToArray();

    // ---------- Seerr ---------------------------------------------------------------------------

    private async Task<object?> Ratings(string type, string tmdbId)
    {
        var path = type == "tv" ? $"api/v1/tv/{tmdbId}/ratings" : $"api/v1/movie/{tmdbId}/ratingscombined";
        var node = await upstream.SeerrGetAsync(path, TimeSpan.FromHours(2)).ConfigureAwait(false);
        if (node is null)
        {
            return null;
        }

        // A series answers with the Rotten Tomatoes record itself; a film nests it beside IMDb's.
        var rt = type == "tv" ? node : node["rt"];
        var imdb = type == "tv" ? null : node["imdb"];
        var critics = Score(rt?["criticsScore"], (string?)rt?["criticsRating"]);
        var audience = Score(rt?["audienceScore"], (string?)rt?["audienceRating"]);
        var imdbScore = imdb?["criticsScore"]?.GetValue<double?>();
        if (critics is null && audience is null && imdbScore is null)
        {
            return null;
        }

        return new
        {
            imdb = imdbScore is null ? null : new { score = imdbScore, votes = imdb?["criticsScoreCount"]?.GetValue<int?>(), url = (string?)imdb?["url"] },
            rt = critics is null && audience is null ? null : new { url = (string?)rt?["url"], critics, audience },
        };
    }

    // Rotten Tomatoes' own words for a score's state: Certified Fresh and Fresh, Rotten; Upright, Spilled.
    private static object? Score(JsonNode? score, string? rating)
    {
        var value = score?.GetValue<int?>();
        if (value is null)
        {
            return null;
        }

        var good = rating is not null && (rating.Contains("Fresh", StringComparison.OrdinalIgnoreCase) || rating.Equals("Upright", StringComparison.OrdinalIgnoreCase));
        return new { score = value, fresh = good };
    }

    private async Task<object?> Providers(string type, string tmdbId, string region)
    {
        var node = await upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}?language=en", TimeSpan.FromMinutes(30)).ConfigureAwait(false);
        var here = node?["watchProviders"]?.AsArray()
            .FirstOrDefault(p => string.Equals((string?)p?["iso_3166_1"], region, StringComparison.OrdinalIgnoreCase));
        var streaming = here?["flatrate"]?.AsArray()
            .Where(p => p is not null && !string.IsNullOrEmpty((string?)p["logoPath"]))
            .OrderBy(p => p!["displayPriority"]?.GetValue<int?>() ?? int.MaxValue)
            .ToList();
        if (streaming is null || streaming.Count == 0)
        {
            return null;
        }

        var names = streaming.Select(p => (string?)p!["name"] ?? string.Empty).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var shown = streaming
            .Where(p =>
            {
                var name = (string?)p!["name"] ?? string.Empty;
                var bare = Variant().Replace(name, string.Empty);
                return bare == name || !names.Contains(bare);
            })
            .Take(MaxProviders)
            .Select(p => new
            {
                id = p!["id"]?.GetValue<int?>(),
                name = (string?)p["name"],
                logo = SeerrMapper.Image((string?)p["logoPath"], "w154"),
            })
            .ToArray();
        return new { region = region.ToUpperInvariant(), link = (string?)here?["link"], streaming = shown };
    }

    // ---------- quality -------------------------------------------------------------------------

    private string[] BadgesOf(BaseItem item, User user)
    {
        var now = DateTime.UtcNow;
        if (BadgeCache.TryGetValue(item.Id, out var hit) && hit.Expires > now)
        {
            return hit.Badges;
        }

        // A show has no file of its own: its first few episodes say what it is shot and mastered in.
        IEnumerable<BaseItem> sources = item is Series
            ? libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                AncestorIds = [item.Id],
                IncludeItemTypes = [BaseItemKind.Episode],
                Recursive = true,
                IsVirtualItem = false,
                Limit = 3,
            })
            : [item];

        var found = new HashSet<string>(StringComparer.Ordinal);
        foreach (var source in sources)
        {
            foreach (var badge in Quality(mediaSources.GetMediaStreams(source.Id)))
            {
                found.Add(badge);
            }
        }

        var badges = new[] { "4k", "dv", "hdr", "atmos", "7.1", "5.1" }.Where(found.Contains).ToArray();
        if (BadgeCache.Count > 4000)
        {
            BadgeCache.Clear();
        }

        BadgeCache[item.Id] = (now + BadgeTtl, badges);
        return badges;
    }

    private static IEnumerable<string> Quality(IReadOnlyList<MediaStream> streams)
    {
        foreach (var stream in streams)
        {
            if (stream.Type == MediaStreamType.Video && !stream.IsExternal)
            {
                if ((stream.Width ?? 0) >= 3600 || (stream.Height ?? 0) >= 2000)
                {
                    yield return "4k";
                }

                var range = stream.VideoRangeType.ToString();
                if (range.StartsWith("DOVI", StringComparison.Ordinal) && range != "DOVIInvalid")
                {
                    yield return "dv";
                }
                else if (range is "HDR10" or "HDR10Plus" or "HLG")
                {
                    yield return "hdr";
                }
            }
            else if (stream.Type == MediaStreamType.Audio)
            {
                if (stream.AudioSpatialFormat.ToString() == "DolbyAtmos" || (stream.Profile ?? string.Empty).Contains("Atmos", StringComparison.OrdinalIgnoreCase))
                {
                    yield return "atmos";
                }
                else if ((stream.Channels ?? 0) >= 8)
                {
                    yield return "7.1";
                }
                else if ((stream.Channels ?? 0) >= 6)
                {
                    yield return "5.1";
                }
            }
        }
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    public sealed class HideBody
    {
        public string? Scope { get; set; }

        public string? Key { get; set; }

        public string? Title { get; set; }

        public string? Year { get; set; }

        public string? Kind { get; set; }

        public string? Image { get; set; }

        public List<string>? Aliases { get; set; }
    }
}

/// <summary>One title a person hid, as saved.</summary>
public sealed class HiddenTitle
{
    public string Scope { get; set; } = string.Empty;

    public string Key { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string? Year { get; set; }

    public string? Kind { get; set; }

    public string? Image { get; set; }

    public List<string> Aliases { get; set; } = [];

    public DateTime At { get; set; }
}

/// <summary>
/// Hidden titles, one JSON file per user in the plugin's own data folder. "upnext" removes a
/// series or film from Up Next until it is watched again; "interest" keeps it out of every
/// suggestion row.
/// </summary>
public static class HiddenStore
{
    public const string UpNext = "upnext";
    public const string Interest = "interest";

    private const int Limit = 500;
    private static readonly object Gate = new();
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static List<HiddenTitle> Read(Guid user)
    {
        lock (Gate)
        {
            return Load(user);
        }
    }

    public static List<HiddenTitle> Add(Guid user, HiddenTitle entry)
    {
        lock (Gate)
        {
            var list = Load(user);
            list.RemoveAll(t => t.Scope == entry.Scope && t.Key == entry.Key);
            list.Add(entry);
            if (list.Count > Limit)
            {
                list = [.. list.OrderByDescending(t => t.At).Take(Limit)];
            }

            Save(user, list);
            return list;
        }
    }

    public static List<HiddenTitle> Remove(Guid user, string scope, string key)
    {
        lock (Gate)
        {
            var list = Load(user);
            if (list.RemoveAll(t => t.Scope == scope && (t.Key == key || t.Aliases.Contains(key))) > 0)
            {
                Save(user, list);
            }

            return list;
        }
    }

    private static string FileOf(Guid user)
    {
        var folder = Path.Combine(Plugin.Instance?.DataFolderPath ?? throw new InvalidOperationException("The plugin is not loaded."), "hidden");
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, user.ToString("N", CultureInfo.InvariantCulture) + ".json");
    }

    private static List<HiddenTitle> Load(Guid user)
    {
        var file = FileOf(user);
        if (!File.Exists(file))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<HiddenTitle>>(File.ReadAllText(file), Json) ?? [];
        }
        catch (JsonException)
        {
            // A damaged file starts the list again; the next save replaces it.
            return [];
        }
    }

    private static void Save(Guid user, List<HiddenTitle> list)
    {
        var file = FileOf(user);
        var temporary = file + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(list, Json));
        File.Move(temporary, file, overwrite: true);
    }
}
