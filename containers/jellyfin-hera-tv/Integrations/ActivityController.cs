using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Where requests really stand. Seerr says "processing" for everything from "not looked at" to
/// "importing"; Sonarr, Radarr and SABnzbd know whether it is searching, queued, downloading (how
/// far, how long left) or how many episodes of a series have arrived. These endpoints join the two
/// by TMDB and TVDB id, as the signed-in user, and fail soft: with the download stack down or not
/// set up, every title simply has no activity.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV/activity")]
public class ActivityController(UpstreamClient upstream, LibraryLookup library, IUserManager userManager) : ControllerBase
{
    private const int MaxRequests = 60;

    // Seerr's own request rank: what still needs looking at comes first when several requests share a title.
    private static readonly string[] StatusRank = ["pending", "approved", "failed", "available", "declined"];

    /// <summary>
    /// The signed-in user's own Seerr requests, one per title, each with its state in the download
    /// stack. An administrator may read another user's with <c>?user=name</c>.
    /// </summary>
    [HttpGet("requests")]
    public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] string? user = null)
    {
        var viewer = CurrentUser();
        if (viewer is null)
        {
            return Unauthorized();
        }

        var target = viewer;
        if (!string.IsNullOrWhiteSpace(user))
        {
            if (!IsAdmin())
            {
                return StatusCode(403);
            }

            target = userManager.GetUserByName(user.Trim());
            if (target is null)
            {
                return NotFound();
            }
        }

        var seerrUser = IntegrationSettings.Current.SeerrUserFor(target.Username);
        if (seerrUser is null)
        {
            return Ok(Array.Empty<object>());
        }

        var live = ActivityOn();
        var queueTask = live ? ArrActivity.QueueAsync(upstream) : Task.FromResult<IReadOnlyList<ArrActivity.QueueItem>>([]);
        var sabTask = live ? ArrActivity.SabAsync(upstream) : Task.FromResult<ArrActivity.SabQueue?>(null);
        var node = await upstream.SeerrGetAsync($"api/v1/user/{seerrUser}/requests?take={Math.Clamp(take, 1, MaxRequests)}&skip=0", TimeSpan.FromSeconds(20), seerrUser).ConfigureAwait(false);
        var queue = await queueTask.ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);

        // A title requested more than once (a series, then its next series) is one entry.
        var merged = new List<Merged>();
        foreach (var request in node?["results"]?.AsArray() ?? [])
        {
            var media = request?["media"];
            var type = (string?)media?["mediaType"] ?? (string?)request?["type"];
            var tmdbId = media?["tmdbId"]?.GetValue<int?>();
            if (request is null || type is null || tmdbId is null)
            {
                continue;
            }

            var status = SeerrMapper.RequestStatus(request["status"]?.GetValue<int>() ?? 0);
            var seasons = (request["seasons"]?.AsArray() ?? []).Select(s => s?["seasonNumber"]?.GetValue<int?>()).OfType<int>().ToList();
            var existing = merged.Find(m => m.Type == type && m.TmdbId == tmdbId);
            if (existing is null)
            {
                merged.Add(new Merged(type, tmdbId.Value, media?["externalServiceId"]?.GetValue<int?>(), media?["tvdbId"]?.GetValue<int?>(), status, (string?)request["createdAt"], seasons));
                continue;
            }

            existing.Seasons.AddRange(seasons.Except(existing.Seasons));
            if (Array.IndexOf(StatusRank, status) < Array.IndexOf(StatusRank, existing.Status))
            {
                existing.Status = status;
            }

            if (string.CompareOrdinal((string?)request["createdAt"], existing.RequestedAt) > 0)
            {
                existing.RequestedAt = (string?)request["createdAt"];
            }
        }

        var rows = await Task.WhenAll(merged.Select(async m =>
        {
            // Request records carry ids only; the title's own record (cached) supplies the rest.
            var title = await upstream.SeerrGetAsync($"api/v1/{m.Type}/{m.TmdbId}?language=en", TimeSpan.FromHours(6)).ConfigureAwait(false);
            if (title is null)
            {
                return null;
            }

            title["mediaType"] = m.Type;
            ArrActivity.Activity? activity = null;
            // Only an approved request can be in the download stack.
            if (live && m.Status is "approved" or "available")
            {
                activity = await LookUp(m.Type, m.TmdbId, m.ArrId, m.TvdbId ?? title["externalIds"]?["tvdbId"]?.GetValue<int?>(), m.Seasons, queue).ConfigureAwait(false);
            }

            return new
            {
                item = SeerrMapper.Item(title, target, library),
                requestStatus = m.Status,
                requestedAt = m.RequestedAt,
                seasons = m.Seasons.Order().ToArray(),
                activity = activity?.ToJson(sab),
            };
        })).ConfigureAwait(false);

        return Ok(rows.Where(r => r is not null));
    }

    /// <summary>A film's or show's state in the download stack, for its sheet or detail page.</summary>
    [HttpGet("title/{mediaType}/{tmdbId:int}")]
    public async Task<IActionResult> GetTitle([FromRoute] string mediaType, [FromRoute] int tmdbId, [FromQuery] int? tvdb = null, [FromQuery] string? seasons = null)
    {
        if (CurrentUser() is null)
        {
            return Unauthorized();
        }

        var type = mediaType == "tv" ? "tv" : "movie";
        var settings = IntegrationSettings.Current;
        if (!ActivityOn())
        {
            return Ok(new { activity = (object?)null });
        }

        int? arrId = null;
        // Seerr keeps the *arr id and the TVDB id of what it has requested; the title's own record is cached.
        var record = settings.SeerrEnabled
            ? await upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}?language=en", TimeSpan.FromMinutes(5)).ConfigureAwait(false)
            : null;
        arrId = record?["mediaInfo"]?["externalServiceId"]?.GetValue<int?>();
        tvdb ??= record?["externalIds"]?["tvdbId"]?.GetValue<int?>() ?? record?["mediaInfo"]?["tvdbId"]?.GetValue<int?>();

        var numbers = (seasons ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, out var n) ? n : (int?)null)
            .OfType<int>()
            .ToList();
        var queueTask = ArrActivity.QueueAsync(upstream);
        var sabTask = ArrActivity.SabAsync(upstream);
        var queue = await queueTask.ConfigureAwait(false);
        var activity = await LookUp(type, tmdbId, arrId, tvdb, numbers, queue).ConfigureAwait(false);
        return Ok(new { activity = activity?.ToJson(await sabTask.ConfigureAwait(false)) });
    }

    /// <summary>Everything in Sonarr's and Radarr's queues, with SABnzbd's overall speed. Administrators only.</summary>
    [HttpGet("downloads")]
    [Authorize(Policy = "RequiresElevation")]
    public async Task<IActionResult> GetDownloads()
        => Ok(await ArrActivity.DownloadsAsync(upstream).ConfigureAwait(false));

    private Task<ArrActivity.Activity?> LookUp(string type, int tmdbId, int? arrId, int? tvdbId, IReadOnlyCollection<int> seasons, IReadOnlyList<ArrActivity.QueueItem> queue)
        => type == "tv"
            ? ArrActivity.SeriesAsync(upstream, tmdbId, tvdbId, arrId, seasons, queue)
            : ArrActivity.MovieAsync(upstream, tmdbId, arrId, queue);

    private bool IsAdmin() => User.IsInRole("Administrator");

    // Sonarr or Radarr connected, and the dashboard's "Request progress" switch on.
    private static bool ActivityOn() => IntegrationSettings.Current.ActivityEnabled && Plugin.Instance?.Configuration.ActivityEnabled != false;

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    private sealed class Merged(string type, int tmdbId, int? arrId, int? tvdbId, string status, string? requestedAt, List<int> seasons)
    {
        public string Type { get; } = type;

        public int TmdbId { get; } = tmdbId;

        public int? ArrId { get; } = arrId;

        public int? TvdbId { get; } = tvdbId;

        public string Status { get; set; } = status;

        public string? RequestedAt { get; set; } = requestedAt;

        public List<int> Seasons { get; } = seasons;
    }
}
