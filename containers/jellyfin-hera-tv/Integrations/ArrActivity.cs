using System.Globalization;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What Sonarr, Radarr and SABnzbd know about a title: not Seerr's "processing", but whether it is
/// monitored, searching, queued, downloading (how far, how long left), importing or here, and for a
/// show how many episodes of each series have arrived. Joined to Seerr by TMDB and TVDB id, or by
/// the *arr id Seerr stores on the request. Every lookup fails soft: a service that is not set up
/// or not answering contributes nothing.
/// </summary>
public static class ArrActivity
{
    private static readonly TimeSpan QueueTtl = TimeSpan.FromSeconds(5);
    // Short: when a download leaves the queue, the title must read "available" within seconds, not "searching" until a minute-old lookup expires.
    private static readonly TimeSpan LibraryTtl = TimeSpan.FromSeconds(10);

    // Which of several downloads speaks for a title: the one furthest along.
    private static readonly string[] StatePriority = ["downloading", "importing", "queued", "attention", "failed"];

    /// <summary>One download the *arr queue tracks, with SABnzbd's own numbers where it has them.</summary>
    public sealed record QueueItem(
        ArrService Source,
        int? MediaId,
        int? SeasonNumber,
        int? EpisodeNumber,
        string? EpisodeTitle,
        string? MediaTitle,
        int? MediaYear,
        string Release,
        string State,
        bool Paused,
        long Size,
        long SizeLeft,
        int? EtaSeconds,
        string? Client,
        string? Protocol,
        string DownloadId,
        string? Message,
        string? Slug,
        int? TmdbId)
    {
        public double? Percent => Size > 0 ? Math.Round(Math.Clamp((Size - SizeLeft) * 100.0 / Size, 0, 100), 1) : null;
    }

    /// <summary>SABnzbd's queue: the overall speed and what each download is doing.</summary>
    public sealed record SabQueue(string Status, bool Paused, long SpeedBps, long SizeLeft, int? EtaSeconds, int Slots, IReadOnlyDictionary<string, SabSlot> ById);

    public sealed record SabSlot(string Status, long Size, long SizeLeft, int? EtaSeconds);

    /// <summary>One series of a show: episodes held against episodes wanted so far.</summary>
    public sealed record SeasonRow(int Number, string State, int Have, int Want, int Total, int Items, string? NextAiring);

    /// <summary>A title's state in the download stack.</summary>
    public sealed record Activity(
        string Service,
        int ArrId,
        string State,
        bool Monitored,
        double? Percent,
        int? EtaSeconds,
        long? SizeBytes,
        long? SizeLeftBytes,
        int Items,
        bool Paused,
        string? ReleaseDate,
        string? NextAiring,
        int? Have,
        int? Want,
        IReadOnlyList<SeasonRow>? Seasons)
    {
        /// <summary>Gets the *arr's slug for the title, for an administrator's "open in" link; never sent as is.</summary>
        public string? Slug { get; init; }

        /// <summary>The shape the web client reads: a title's state, never a release name, client or path.</summary>
        public object ToJson(SabQueue? sab) => new
        {
            service = Service,
            arrId = ArrId,
            state = State,
            monitored = Monitored,
            progress = Percent,
            etaSeconds = EtaSeconds,
            sizeBytes = SizeBytes,
            sizeLeftBytes = SizeLeftBytes,
            speedBps = State == "downloading" && sab is { Paused: false } ? (long?)sab.SpeedBps : null,
            items = Items,
            paused = Paused,
            releaseDate = ReleaseDate,
            nextAiring = NextAiring,
            have = Have,
            want = Want,
            seasons = Seasons?.Select(s => new
            {
                seasonNumber = s.Number,
                state = s.State,
                have = s.Have,
                want = s.Want,
                total = s.Total,
                items = s.Items,
                nextAiring = s.NextAiring,
            }).ToArray(),
        };
    }

    // ---------- queue --------------------------------------------------------------------------

    /// <summary>Gets SABnzbd's queue, or null when it is not set up or not answering.</summary>
    public static async Task<SabQueue?> SabAsync(UpstreamClient upstream)
    {
        var body = await upstream.ArrGetAsync(ArrService.Sabnzbd, "api?mode=queue", QueueTtl).ConfigureAwait(false);
        if (body?["queue"] is not JsonObject queue)
        {
            return null;
        }

        var slots = new Dictionary<string, SabSlot>(StringComparer.OrdinalIgnoreCase);
        foreach (var slot in queue["slots"] as JsonArray ?? [])
        {
            var id = (string?)slot?["nzo_id"];
            if (slot is null || string.IsNullOrEmpty(id))
            {
                continue;
            }

            slots[id] = new SabSlot(
                (string?)slot["status"] ?? string.Empty,
                Megabytes(slot["mb"]),
                Megabytes(slot["mbleft"]),
                Seconds((string?)slot["timeleft"]));
        }

        var kbPerSecond = Number(queue["kbpersec"]) ?? 0;
        return new SabQueue(
            (string?)queue["status"] ?? string.Empty,
            queue["paused"]?.GetValue<bool?>() ?? false,
            (long)(kbPerSecond * 1024),
            Megabytes(queue["mbleft"]),
            Seconds((string?)queue["timeleft"]),
            (int)(Number(queue["noofslots"]) ?? slots.Count),
            slots);
    }

    /// <summary>Gets every download Sonarr and Radarr track, SABnzbd's numbers laid over theirs.</summary>
    public static async Task<IReadOnlyList<QueueItem>> QueueAsync(UpstreamClient upstream)
    {
        var sonarr = upstream.ArrGetAsync(ArrService.Sonarr, "api/v3/queue/details?includeSeries=true&includeEpisode=true", QueueTtl);
        var radarr = upstream.ArrGetAsync(ArrService.Radarr, "api/v3/queue/details?includeMovie=true", QueueTtl);
        var sabTask = SabAsync(upstream);
        await Task.WhenAll(sonarr, radarr, sabTask).ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);

        var items = new List<QueueItem>();
        foreach (var node in await sonarr.ConfigureAwait(false) as JsonArray ?? [])
        {
            if (node is not null && Item(ArrService.Sonarr, node, sab) is { } item)
            {
                items.Add(item);
            }
        }

        foreach (var node in await radarr.ConfigureAwait(false) as JsonArray ?? [])
        {
            if (node is not null && Item(ArrService.Radarr, node, sab) is { } item)
            {
                items.Add(item);
            }
        }

        return items;
    }

    private static QueueItem? Item(ArrService source, JsonNode node, SabQueue? sab)
    {
        var state = StateOf(node);
        if (state == "ignored")
        {
            return null;
        }

        var downloadId = (string?)node["downloadId"];
        var key = string.IsNullOrEmpty(downloadId) ? $"{source}:{node["id"]}" : downloadId;
        SabSlot? slot = null;
        if (!string.IsNullOrEmpty(downloadId))
        {
            sab?.ById.TryGetValue(downloadId, out slot);
        }

        var size = (long)(Number(node["size"]) ?? 0);
        var left = (long)(Number(node["sizeleft"]) ?? 0);
        var eta = Seconds((string?)node["timeleft"]) ?? SecondsUntil((string?)node["estimatedCompletionTime"]);
        var paused = false;
        if (slot is not null && state is "downloading" or "queued")
        {
            // Between the *arr's polls SABnzbd is the one that knows.
            (state, paused) = slot.Status.ToLowerInvariant() switch
            {
                "paused" => ("queued", true),
                "queued" or "propagating" => ("queued", false),
                "verifying" or "repairing" or "extracting" or "moving" or "running" => ("importing", false),
                _ => ("downloading", false),
            };
            if (slot.Size > 0)
            {
                size = slot.Size;
                left = slot.SizeLeft;
            }

            eta = state == "downloading" ? slot.EtaSeconds ?? eta : null;
        }

        if (state != "downloading")
        {
            eta = null;
        }

        var series = node["series"];
        var movie = node["movie"];
        var episode = node["episode"];
        return new QueueItem(
            source,
            node["seriesId"]?.GetValue<int?>() ?? node["movieId"]?.GetValue<int?>(),
            node["seasonNumber"]?.GetValue<int?>() ?? episode?["seasonNumber"]?.GetValue<int?>(),
            episode?["episodeNumber"]?.GetValue<int?>(),
            (string?)episode?["title"],
            (string?)series?["title"] ?? (string?)movie?["title"],
            series?["year"]?.GetValue<int?>() ?? movie?["year"]?.GetValue<int?>(),
            (string?)node["title"] ?? string.Empty,
            state,
            paused,
            size,
            left,
            eta,
            (string?)node["downloadClient"],
            (string?)node["protocol"],
            key,
            Message(node),
            (string?)series?["titleSlug"] ?? (string?)movie?["titleSlug"],
            series?["tmdbId"]?.GetValue<int?>() ?? movie?["tmdbId"]?.GetValue<int?>());
    }

    // The *arr's own words, two layers: a download's state, then its status.
    private static string StateOf(JsonNode node)
    {
        var tracked = (string?)node["trackedDownloadState"];
        var status = ((string?)node["status"] ?? string.Empty).ToLowerInvariant();
        return tracked switch
        {
            "importBlocked" => "attention",
            "importPending" or "importing" or "imported" => "importing",
            "failed" or "failedPending" => "failed",
            "ignored" => "ignored",
            _ => status switch
            {
                "downloading" => "downloading",
                "completed" => "importing",
                "failed" => "failed",
                "warning" or "downloadclientunavailable" => "attention",
                _ => "queued",
            },
        };
    }

    private static string? Message(JsonNode node)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace((string?)node["errorMessage"]))
        {
            parts.Add(((string?)node["errorMessage"])!.Trim());
        }

        foreach (var entry in node["statusMessages"] as JsonArray ?? [])
        {
            foreach (var message in entry?["messages"] as JsonArray ?? [])
            {
                var text = ((string?)message)?.Trim();
                if (!string.IsNullOrEmpty(text) && !parts.Contains(text))
                {
                    parts.Add(text);
                }
            }
        }

        return parts.Count == 0 ? null : string.Join(" ", parts.Take(2));
    }

    private sealed record Summary(string State, long Size, long SizeLeft, int? EtaSeconds, int Count, bool Paused);

    /// <summary>One state for a title's downloads: a season pack is one download however many episodes it holds.</summary>
    private static Summary? Summarise(IReadOnlyCollection<QueueItem> items)
    {
        if (items.Count == 0)
        {
            return null;
        }

        var state = StatePriority.First(s => items.Any(i => i.State == s));
        var downloads = items.GroupBy(i => i.DownloadId).Select(g => g.First()).ToList();
        var moving = downloads.Where(d => d.State is "downloading" or "queued").ToList();
        var etas = downloads.Where(d => d.State == "downloading" && d.EtaSeconds is not null).Select(d => d.EtaSeconds!.Value).ToList();
        return new Summary(
            state,
            moving.Sum(d => d.Size),
            moving.Sum(d => d.SizeLeft),
            etas.Count == 0 ? null : etas.Max(),
            items.Count,
            state == "queued" && moving.All(d => d.Paused));
    }

    // ---------- titles -------------------------------------------------------------------------

    /// <summary>A film's state in Radarr; null when Radarr is not set up, not answering, or does not know it.</summary>
    public static async Task<Activity?> MovieAsync(UpstreamClient upstream, int tmdbId, int? arrId, IReadOnlyList<QueueItem> queue)
    {
        string? slug = null;
        var activity = await MovieCoreAsync(upstream, tmdbId, arrId, queue, s => slug = s).ConfigureAwait(false);
        return activity is null ? null : activity with { Slug = slug };
    }

    private static async Task<Activity?> MovieCoreAsync(UpstreamClient upstream, int tmdbId, int? arrId, IReadOnlyList<QueueItem> queue, Action<string?> slugSink)
    {
        JsonNode? movie = null;
        if (arrId is int id)
        {
            movie = await upstream.ArrGetAsync(ArrService.Radarr, $"api/v3/movie/{id}", LibraryTtl).ConfigureAwait(false);
            if (movie?["tmdbId"]?.GetValue<int?>() is int known && known != tmdbId)
            {
                movie = null;
            }
        }

        movie ??= (await upstream.ArrGetAsync(ArrService.Radarr, $"api/v3/movie?tmdbId={tmdbId}", LibraryTtl).ConfigureAwait(false) as JsonArray)?.FirstOrDefault();
        if (movie?["id"]?.GetValue<int?>() is not int movieId)
        {
            return null;
        }

        slugSink((string?)movie["titleSlug"]);

        var monitored = movie["monitored"]?.GetValue<bool?>() ?? false;
        var hasFile = movie["hasFile"]?.GetValue<bool?>() ?? false;
        long? onDisk = (long?)Number(movie["sizeOnDisk"]);
        var items = queue.Where(q => q.Source == ArrService.Radarr && q.MediaId == movieId).ToList();
        if (hasFile)
        {
            return new Activity("radarr", movieId, "available", monitored, null, null, onDisk, null, 0, false, null, null, null, null, null);
        }

        if (Summarise(items) is { } summary)
        {
            return FromSummary("radarr", movieId, monitored, summary, null, null, null, null);
        }

        if (!monitored)
        {
            return new Activity("radarr", movieId, "unmonitored", false, null, null, null, null, 0, false, null, null, null, null, null);
        }

        if (movie["isAvailable"]?.GetValue<bool?>() ?? false)
        {
            return new Activity("radarr", movieId, "searching", true, null, null, null, null, 0, false, null, null, null, null, null);
        }

        // Not out yet by the profile's rules. The digital or physical release is when it can arrive.
        var release = Date((string?)movie["digitalRelease"]) ?? Date((string?)movie["physicalRelease"])
            ?? ((string?)movie["minimumAvailability"] == "inCinemas" ? Date((string?)movie["inCinemas"]) : null);
        return new Activity("radarr", movieId, "waiting", true, null, null, null, null, 0, false, release, null, null, null, null);
    }

    /// <summary>
    /// A show's state in Sonarr. <paramref name="seasons"/> narrows it to the series a request asked
    /// for; null or empty means every series Sonarr is watching.
    /// </summary>
    public static async Task<Activity?> SeriesAsync(
        UpstreamClient upstream,
        int tmdbId,
        int? tvdbId,
        int? arrId,
        IReadOnlyCollection<int>? seasons,
        IReadOnlyList<QueueItem> queue)
    {
        string? slug = null;
        var activity = await SeriesCoreAsync(upstream, tmdbId, tvdbId, arrId, seasons, queue, s => slug = s).ConfigureAwait(false);
        return activity is null ? null : activity with { Slug = slug };
    }

    private static async Task<Activity?> SeriesCoreAsync(
        UpstreamClient upstream,
        int tmdbId,
        int? tvdbId,
        int? arrId,
        IReadOnlyCollection<int>? seasons,
        IReadOnlyList<QueueItem> queue,
        Action<string?> slugSink)
    {
        JsonNode? series = null;
        if (arrId is int id)
        {
            series = await upstream.ArrGetAsync(ArrService.Sonarr, $"api/v3/series/{id}", LibraryTtl).ConfigureAwait(false);
            // A stale id from Seerr: the show it names must be the show asked about.
            if ((series?["tmdbId"]?.GetValue<int?>() is int known && known > 0 && known != tmdbId)
                || (tvdbId is int tvdb && series?["tvdbId"]?.GetValue<int?>() is int knownTvdb && knownTvdb > 0 && knownTvdb != tvdb))
            {
                series = null;
            }
        }

        if (series is null && tvdbId is int lookup)
        {
            series = (await upstream.ArrGetAsync(ArrService.Sonarr, $"api/v3/series?tvdbId={lookup}", LibraryTtl).ConfigureAwait(false) as JsonArray)?.FirstOrDefault();
        }

        if (series?["id"]?.GetValue<int?>() is not int seriesId)
        {
            return null;
        }

        slugSink((string?)series["titleSlug"]);

        var monitored = series["monitored"]?.GetValue<bool?>() ?? false;
        var mine = queue.Where(q => q.Source == ArrService.Sonarr && q.MediaId == seriesId).ToList();
        var wanted = seasons is { Count: > 0 } ? seasons.ToHashSet() : null;
        var rows = new List<SeasonRow>();
        foreach (var node in series["seasons"] as JsonArray ?? [])
        {
            var number = node?["seasonNumber"]?.GetValue<int?>();
            if (node is null || number is null || (wanted is null ? number == 0 : !wanted.Contains(number.Value)))
            {
                continue;
            }

            var stats = node["statistics"];
            var have = (int)(Number(stats?["episodeFileCount"]) ?? 0);
            var want = Math.Max((int)(Number(stats?["episodeCount"]) ?? 0), have);
            var total = Math.Max((int)(Number(stats?["totalEpisodeCount"]) ?? 0), want);
            var seasonItems = mine.Where(q => q.SeasonNumber == number).ToList();
            var next = Date((string?)stats?["nextAiring"], future: true);
            var seasonMonitored = node["monitored"]?.GetValue<bool?>() ?? false;
            string state;
            if (want > 0 && have >= want)
            {
                state = "available";
            }
            else if (Summarise(seasonItems) is { } running)
            {
                state = running.State;
            }
            else if (have > 0)
            {
                state = "partial";
            }
            else if (!seasonMonitored)
            {
                state = "unmonitored";
            }
            else
            {
                state = want == 0 && total > 0 ? "waiting" : "searching";
            }

            rows.Add(new SeasonRow(number.Value, state, have, want, total, seasonItems.Count, next));
        }

        // Asked for everything: series Sonarr is not watching and holds nothing of are not part of the picture.
        if (wanted is null)
        {
            rows.RemoveAll(r => r.State == "unmonitored");
        }

        rows.Sort((a, b) => a.Number.CompareTo(b.Number));
        var haveTotal = rows.Sum(r => r.Have);
        var wantTotal = rows.Sum(r => r.Want);
        var nextAiring = rows.Select(r => r.NextAiring).Where(d => d is not null).Min();
        // A series that has not aired anything yet is not owed: only the rest counts as missing.
        var open = rows.Where(r => r.State is not ("available" or "waiting")).ToList();
        var openNumbers = open.Select(r => r.Number).ToHashSet();
        var downloading = Summarise(mine.Where(q => q.SeasonNumber is null || openNumbers.Contains(q.SeasonNumber.Value)).ToList());

        if (rows.Count == 0)
        {
            return new Activity("sonarr", seriesId, "unmonitored", monitored, null, null, null, null, 0, false, null, null, 0, 0, rows);
        }

        if (rows.All(r => r.State == "waiting"))
        {
            return new Activity("sonarr", seriesId, "waiting", monitored, null, null, null, null, 0, false, null, nextAiring, haveTotal, wantTotal, rows);
        }

        if (open.Count == 0)
        {
            return new Activity("sonarr", seriesId, "available", monitored, null, null, null, null, 0, false, null, nextAiring, haveTotal, wantTotal, rows);
        }

        if (downloading is not null)
        {
            return FromSummary("sonarr", seriesId, monitored, downloading, nextAiring, haveTotal, wantTotal, rows);
        }

        var overall = rows.Any(r => r.Have > 0) ? "partial"
            : open.All(r => r.State == "unmonitored") ? "unmonitored"
            : "searching";
        return new Activity("sonarr", seriesId, overall, monitored, null, null, null, null, 0, false, null, nextAiring, haveTotal, wantTotal, rows);
    }

    private static Activity FromSummary(string service, int arrId, bool monitored, Summary s, string? nextAiring, int? have, int? want, IReadOnlyList<SeasonRow>? rows)
    {
        var percent = s.State is "downloading" or "queued" && s.Size > 0
            ? Math.Round(Math.Clamp((s.Size - s.SizeLeft) * 100.0 / s.Size, 0, 100), 1)
            : (double?)null;
        return new Activity(service, arrId, s.State, monitored, percent, s.EtaSeconds, s.Size > 0 ? s.Size : null, s.Size > 0 ? s.SizeLeft : null, s.Count, s.Paused, null, nextAiring, have, want, rows);
    }

    // ---------- the admin's downloads ----------------------------------------------------------

    /// <summary>Every download in Sonarr's and Radarr's queues with SABnzbd's overall state.</summary>
    public static async Task<object> DownloadsAsync(UpstreamClient upstream)
    {
        var queueTask = QueueAsync(upstream);
        var sabTask = SabAsync(upstream);
        var queue = await queueTask.ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);
        var settings = IntegrationSettings.Current;

        var rows = queue
            .GroupBy(i => (i.Source, i.DownloadId))
            .Select(g =>
            {
                var first = g.First();
                var episodes = g.Where(i => i.EpisodeNumber is not null).OrderBy(i => i.SeasonNumber).ThenBy(i => i.EpisodeNumber).ToList();
                return new
                {
                    id = $"{first.Source}:{first.DownloadId}".ToLowerInvariant(),
                    source = first.Source.ToString().ToLowerInvariant(),
                    kind = first.Source == ArrService.Radarr ? "movie" : "tv",
                    title = first.MediaTitle ?? first.Release,
                    year = first.MediaYear,
                    season = first.SeasonNumber,
                    episodes = g.Count(i => i.Source == ArrService.Sonarr),
                    episode = episodes.Count == 1 ? episodes[0].EpisodeNumber : null,
                    episodeTitle = episodes.Count == 1 ? episodes[0].EpisodeTitle : null,
                    release = first.Release,
                    state = first.State,
                    paused = first.Paused,
                    progress = first.Percent,
                    etaSeconds = first.EtaSeconds,
                    sizeBytes = first.Size > 0 ? (long?)first.Size : null,
                    sizeLeftBytes = first.Size > 0 ? (long?)first.SizeLeft : null,
                    client = first.Client,
                    protocol = first.Protocol,
                    message = first.Message,
                    links = ExternalLinks.For(settings, true, first.Source == ArrService.Radarr ? "movie" : "tv", first.TmdbId, first.Source, first.Slug),
                };
            })
            .OrderBy(r => Array.IndexOf(StatePriority, r.state))
            .ThenByDescending(r => r.progress ?? 0)
            .ToArray();

        return new
        {
            items = rows,
            sab = sab is null
                ? null
                : new
                {
                    status = sab.Paused ? "paused" : sab.Slots == 0 ? "idle" : "downloading",
                    paused = sab.Paused,
                    speedBps = sab.SpeedBps,
                    sizeLeftBytes = sab.SizeLeft,
                    etaSeconds = sab.EtaSeconds,
                    queued = sab.Slots,
                },
            links = ExternalLinks.Sabnzbd(settings, true),
            services = new
            {
                sonarr = settings.Enabled(ArrService.Sonarr),
                radarr = settings.Enabled(ArrService.Radarr),
                sabnzbd = settings.Enabled(ArrService.Sabnzbd),
            },
        };
    }

    // ---------- parsing ------------------------------------------------------------------------

    private static double? Number(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue(out double number))
        {
            return number;
        }

        return value.TryGetValue(out string? text) && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    private static long Megabytes(JsonNode? node) => (long)((Number(node) ?? 0) * 1048576);

    /// <summary>Reads "0:12:34" or "1.02:03:04"; a download with no time left or no estimate gives null.</summary>
    private static int? Seconds(string? text)
        => TimeSpan.TryParse(text, CultureInfo.InvariantCulture, out var span) && span > TimeSpan.Zero ? (int)span.TotalSeconds : null;

    private static int? SecondsUntil(string? iso)
        => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) && at > DateTimeOffset.UtcNow
            ? (int)(at - DateTimeOffset.UtcNow).TotalSeconds
            : null;

    /// <summary>The date part of an ISO timestamp; with <paramref name="future"/>, only a date still to come.</summary>
    private static string? Date(string? iso, bool future = false)
        => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) && (!future || at > DateTimeOffset.UtcNow)
            ? at.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;
}
