/*
 * Hera TV: home module. Registers with window.HeraTV (hera-tv.js).
 *  - Up Next: Continue Watching and Next Up merged into one row, one entry per series.
 *  - Top Picks: "Because You Watched ..." and "More Like ..." rows from the server's own taste data.
 *  - Leaving Soon (Maintainerr), Your Requests and Trending to Request (Seerr), when connected.
 *  - A "Leaving 9 Dec" chip on the detail page of a title that is leaving.
 * Jellyfin's own Recently Added rows stay. Every other stock section (Continue Watching, Next Up,
 * My Media, ...) is hidden here, whatever the person's home settings say, because Up Next and
 * the rows below stand in for them. Titles the person hid (hera-extras.js) stay out of the rows.
 */
(() => {
  "use strict";

  const heraTv = window.HeraTV;
  if (!heraTv) return;
  const { kit } = heraTv;

  const UP_NEXT_LIMIT = 16;
  const SHELF_LIMIT = 20;
  const LONG_PRESS_MS = 450;
  const MINUTE = 600000000;

  // Rows sit in this order inside the home sections: Up Next first, the stock Recently Added
  // rows after it, then everything else.
  const RANK = { upnext: 0, "picks-1": 10, "picks-2": 11, "picks-tv": 12, leaving: 20, requests: 30, trending: 40 };

  const state = {
    user: null,
    run: 0,
    cache: new Map(),
    shown: new Map(), // row id -> { sig, row }
    container: null,
    observer: null,
    detailObserver: null,
    kept: null, // slots of Jellyfin's own sections to keep: a Set, "all", or null while unknown
  };

  // ---------- data ------------------------------------------------------------------------

  /** One fetch per key, remembered for `ttl` ms; a failure is forgotten at once. */
  const load = (key, ttl, fetcher) => {
    const entry = state.cache.get(key);
    if (entry && Date.now() - entry.at < ttl) return entry.promise;
    const promise = Promise.resolve()
      .then(fetcher)
      .catch((error) => {
        if (state.cache.get(key)?.promise === promise) state.cache.delete(key);
        console.warn(`[Hera TV:home] ${key}`, error);
        return null;
      });
    state.cache.set(key, { at: Date.now(), promise });
    return promise;
  };

  const plainId = (id) => String(id || "").replace(/-/g, "").toLowerCase();

  const leavingList = () =>
    load("leaving", 5 * 60 * 1000, async () => {
      const { maintainerr, features } = await kit.integrations();
      if (!maintainerr || features?.leavingSoon === false) return [];
      const list = (await kit.hera("leaving")) || [];
      return list.filter((entry) => entry.jellyfinId && entry.leavesOn).sort((a, b) => a.leavesOn.localeCompare(b.leavesOn));
    });

  const lastPlayedMs = (item) => {
    const date = item.UserData?.LastPlayedDate;
    return date ? Date.parse(date) || 0 : 0;
  };

  // Episodes watched most recently, newest first: when each series was last watched, and which was.
  const recentlyWatched = () =>
    load("watched", 5 * 1000, async () => {
      const result = await kit.getJSON(`Users/${kit.userId()}/Items`, {
        IncludeItemTypes: "Episode",
        Recursive: true,
        Filters: "IsPlayed",
        SortBy: "DatePlayed",
        SortOrder: "Descending",
        Limit: 60,
        EnableImages: false,
        EnableTotalRecordCount: false,
      });
      const series = new Map();
      for (const episode of result?.Items ?? []) {
        if (episode.SeriesId && !series.has(episode.SeriesId)) {
          series.set(episode.SeriesId, { id: episode.SeriesId, name: episode.SeriesName, at: lastPlayedMs(episode) });
        }
      }
      return [...series.values()];
    });

  // ---------- Up Next ------------------------------------------------------------------------

  const stillOf = (item) => {
    const tag = (type, id, t, maxWidth = 640) => (t ? kit.imageUrl(id, type, { maxWidth, tag: t }) : null);
    if (item.Type === "Episode") {
      return (
        tag("Primary", item.Id, item.ImageTags?.Primary) ||
        tag("Thumb", item.ParentThumbItemId, item.ParentThumbImageTag) ||
        tag("Backdrop", item.ParentBackdropItemId, item.ParentBackdropImageTags?.[0])
      );
    }
    return (
      tag("Thumb", item.Id, item.ImageTags?.Thumb) ||
      tag("Backdrop", item.Id, item.BackdropImageTags?.[0]) ||
      tag("Primary", item.Id, item.ImageTags?.Primary)
    );
  };

  const episodeCode = (item) =>
    item.ParentIndexNumber != null && item.IndexNumber != null ? `S${item.ParentIndexNumber}, E${item.IndexNumber}` : item.Name;

  const timeLeft = (item) => {
    const ticks = (item.RunTimeTicks || 0) - (item.UserData?.PlaybackPositionTicks || 0);
    if (ticks <= 0) return null;
    return `${kit.runtime(Math.max(ticks, MINUTE))} left`;
  };

  const upNextEntries = () =>
    load("upnext", 5 * 1000, async () => {
      const user = kit.userId();
      const fields = "PrimaryImageAspectRatio,BasicSyncInfo";
      const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
      const [resume, next, watched] = await Promise.all([
        kit.getJSON(`Users/${user}/Items/Resume`, {
          Limit: 24,
          MediaTypes: "Video",
          Fields: fields,
          EnableImageTypes: "Primary,Backdrop,Thumb",
          EnableTotalRecordCount: false,
        }),
        kit.getJSON("Shows/NextUp", {
          userId: user,
          limit: 24,
          Fields: fields,
          EnableImageTypes: "Primary,Backdrop,Thumb",
          EnableResumable: false,
          NextUpDateCutoff: cutoff,
          EnableTotalRecordCount: false,
        }),
        recentlyWatched(),
      ]);
      const seriesWatchedAt = new Map((watched ?? []).map((s) => [s.id, s.at]));
      const byKey = new Map();
      for (const item of resume?.Items ?? []) {
        const key = item.SeriesId || item.Id;
        const at = lastPlayedMs(item);
        const held = byKey.get(key);
        if (held && held.at >= at) continue;
        byKey.set(key, { key, item, resumable: true, at });
      }
      (next?.Items ?? []).forEach((item, index) => {
        const key = item.SeriesId || item.Id;
        if (byKey.has(key)) return;
        // Next Up is already ordered by when each series was last watched; that order stands in
        // for a date when the watch history doesn't reach back far enough.
        byKey.set(key, { key, item, resumable: false, at: seriesWatchedAt.get(item.SeriesId) ?? -index - 1 });
      });
      return [...byKey.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, UP_NEXT_LIMIT)
        .map(({ key, item, resumable, at }) => {
          const isEpisode = item.Type === "Episode";
          const left = resumable ? timeLeft(item) : null;
          return {
            id: item.Id,
            type: item.Type,
            title: (isEpisode ? item.SeriesName : item.Name) || item.Name,
            subtitle: resumable
              ? [isEpisode ? episodeCode(item) : null, left].filter(Boolean).join(" · ") || null
              : `Next · ${episodeCode(item)}`,
            detailId: isEpisode && item.SeriesId ? item.SeriesId : item.Id,
            image: stillOf(item),
            progress: resumable ? item.UserData?.PlayedPercentage || 0 : 0,
            position: item.UserData?.PlaybackPositionTicks || 0,
            hideKeys: [plainId(key)],
            at,
          };
        });
    });

  const openDetails = (id) => kit.go(`#/details?id=${id}`);

  const upNextCard = (entry) => {
    const play = () => {
      main.setAttribute("aria-busy", "true");
      // The server's play command takes the item as the core reads it: id, type, resume point.
      Promise.resolve(kit.play({ Id: entry.id, Type: entry.type, UserData: { PlaybackPositionTicks: entry.position } }))
        .catch((error) => {
          console.error("[Hera TV:home]", error);
          openDetails(entry.detailId);
        })
        .finally(() => main.removeAttribute("aria-busy"));
    };
    const main = kit.card({
      onClick: play,
      image: entry.image,
      shape: "wide",
      title: entry.title,
      subtitle: entry.subtitle,
      progress: entry.progress,
      label: `Play ${entry.title}${entry.subtitle ? `, ${entry.subtitle}` : ""}`,
    });
    // hera-extras.js reads this: the card's "more" button, right click and (on a remote) a long press.
    main.heraId = entry.id;
    main.heraHide = {
      scope: "upnext",
      keys: entry.hideKeys,
      title: entry.title,
      kind: entry.type === "Episode" ? "TV Show" : "Film",
      image: entry.image,
      extra: [{ label: "Open Page", icon: "info_outline", onSelect: () => openDetails(entry.detailId) }],
    };
    const openMenu = () => (heraTv.hidden?.menu?.(main) ? true : (openDetails(entry.detailId), false));
    const info = kit.el(
      "button",
      {
        type: "button",
        class: "hera-card__info",
        "aria-label": `About ${entry.title}`,
        title: "Open page",
        onclick: () => openDetails(entry.detailId),
      },
      kit.icon("info_outline"),
    );
    // On a remote there is no pointer for the info button: a long press on OK, or the remote's
    // context-menu key, opens the card's menu; its Info key opens the page.
    let pressTimer = 0;
    let handled = false;
    main.addEventListener("keydown", (event) => {
      if (!kit.isTv()) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.repeat || pressTimer) return;
        handled = false;
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          handled = true;
          openMenu();
        }, LONG_PRESS_MS);
      } else if (event.key === "ContextMenu") {
        event.preventDefault();
        openMenu();
      } else if (event.key === "Info" || event.keyCode === 457 || event.key === "i") {
        event.preventDefault();
        openDetails(entry.detailId);
      }
    });
    main.addEventListener("keyup", (event) => {
      if (!kit.isTv() || event.key !== "Enter") return;
      event.preventDefault();
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = 0;
        if (!handled) play();
      }
    });
    main.addEventListener("blur", () => {
      clearTimeout(pressTimer);
      pressTimer = 0;
    });
    return kit.el("div", { class: "hera-upnext" }, [main, info]);
  };

  // ---------- poster rows ------------------------------------------------------------------

  const posterOf = (item) =>
    item.ImageTags?.Primary ? kit.imageUrl(item.Id, "Primary", { maxWidth: 400, tag: item.ImageTags.Primary }) : null;

  const posterEntry = (item) => ({
    id: item.Id,
    title: item.Name,
    subtitle: item.ProductionYear ? String(item.ProductionYear) : null,
    image: posterOf(item),
    kind: item.Type === "Series" ? "TV Show" : "Film",
  });

  // A title from a taste row can be marked Not Interested: hera-extras.js reads this off the card.
  const posterCard = (entry) => {
    const card = kit.card({ href: `#/details?id=${entry.id}`, image: entry.image, title: entry.title, subtitle: entry.subtitle });
    card.heraHide = { scope: "interest", keys: [plainId(entry.id)], title: entry.title, year: entry.subtitle, kind: entry.kind, image: entry.image };
    return card;
  };

  const RECOMMENDATION_TITLE = {
    SimilarToRecentlyPlayed: (name) => `Because You Watched ${name}`,
    SimilarToLikedItem: (name) => `Because You Liked ${name}`,
    HasDirectorFromRecentlyPlayed: (name) => `Directed by ${name}`,
    HasLikedDirector: (name) => `Directed by ${name}`,
    HasActorFromRecentlyPlayed: (name) => `Starring ${name}`,
    HasLikedActor: (name) => `Starring ${name}`,
  };

  const picksForMovies = () =>
    load("recommendations", 10 * 60 * 1000, async () => {
      const categories = await kit.getJSON("Movies/Recommendations", {
        userId: kit.userId(),
        categoryLimit: 6,
        itemLimit: 16,
        fields: "ProductionYear",
      });
      // "Because you watched" outranks director and cast rows; the server's order breaks ties.
      const similar = (c) => (c.RecommendationType?.startsWith("Similar") ? 0 : 1);
      const seen = new Set();
      const rows = [];
      for (const category of [...(categories ?? [])].sort((a, b) => similar(a) - similar(b))) {
        const title = RECOMMENDATION_TITLE[category.RecommendationType]?.(category.BaselineItemName);
        const items = (category.Items ?? []).filter((item) => !seen.has(item.Id) && !item.UserData?.Played);
        if (!title || !items.length) continue;
        items.forEach((item) => seen.add(item.Id));
        rows.push({ title, entries: items.map(posterEntry) });
        if (rows.length === 2) break;
      }
      return rows;
    });

  const picksForSeries = () =>
    load("similar-series", 10 * 60 * 1000, async () => {
      const [watched, upNext] = await Promise.all([recentlyWatched(), upNextEntries()]);
      const seed = watched?.[0] ?? null;
      if (!seed) return null;
      const result = await kit.getJSON(`Items/${seed.id}/Similar`, { userId: kit.userId(), limit: 16, fields: "ProductionYear" });
      const skip = new Set([seed.id, ...(upNext ?? []).map((e) => e.detailId)]);
      const items = (result?.Items ?? []).filter((item) => !skip.has(item.Id) && !item.UserData?.Played);
      return items.length ? { title: `More Like ${seed.name}`, entries: items.map(posterEntry) } : null;
    });

  const leavingRow = async () => {
    const list = await leavingList();
    if (!list?.length) return null;
    const entries = await load("leaving-items", 5 * 60 * 1000, async () => {
      const result = await kit.getJSON(`Users/${kit.userId()}/Items`, {
        Ids: list.map((entry) => entry.jellyfinId).join(","),
        Fields: "ProductionYear",
      });
      const items = new Map((result?.Items ?? []).map((item) => [plainId(item.Id), item]));
      return list
        .filter((entry) => items.has(plainId(entry.jellyfinId)))
        .map((entry) => ({
          ...posterEntry(items.get(plainId(entry.jellyfinId))),
          badge: `Leaving ${kit.shortDate(entry.leavesOn)}`,
        }));
    });
    return entries?.length ? { title: "Leaving Soon", entries, card: (e) => kit.card({ href: `#/details?id=${e.id}`, image: e.image, title: e.title, subtitle: e.subtitle, badge: e.badge }) } : null;
  };

  // ---------- Seerr rows -------------------------------------------------------------------

  const openSeerrTitle = (item) => {
    if (heraTv.discover?.openTitle) heraTv.discover.openTitle(item);
    else kit.go("#/home?hera=discover");
  };

  // The row's cards show where each request really stands (hera-activity.js): the download
  // stack's state, and a progress bar while it downloads. They update in place while the page shows.
  let requestsBusy = false;

  const requestsRow = async () => {
    const { seerrLinked, features } = await kit.integrations();
    const activity = heraTv.activity;
    if (!seerrLinked || features?.requests === false || !activity) return null;
    const requests = await activity.fetchRequests(20);
    const entries = (requests ?? [])
      .filter((request) => request.item?.title)
      .map((request) => ({ request, item: request.item, d: activity.describeRequest(request) }))
      // What is moving comes first, then what waits, then what has arrived; newest first within each.
      .sort((a, b) => activity.rankOf(a.d) - activity.rankOf(b.d) || String(b.request.requestedAt).localeCompare(String(a.request.requestedAt)))
      .slice(0, SHELF_LIMIT);
    requestsBusy = entries.some((entry) => !entry.d.final);
    if (!entries.length) return null;
    return {
      title: "Your Requests",
      href: activity.hash,
      entries,
      // The saved shape of the row. Progress and times change under it without a rebuild.
      sig: entries.map((entry) => `${activity.keyOf(entry.request)}|${entry.item.jellyfinId ? "lib" : "req"}`),
      card: (entry) => activity.requestCard(entry.request, { onOpen: (item) => openSeerrTitle(item) }),
      update: (row, next) => {
        for (const entry of next) {
          const card = row.querySelector(`[data-hera-request="${CSS.escape(activity.keyOf(entry.request))}"]`);
          if (card) activity.updateCard(card, entry.request);
        }
      },
    };
  };

  // While the home page shows, a request in motion refreshes every few seconds, a quiet list every half minute.
  let requestsTimer = 0;
  const stopRequestsPoll = () => {
    clearTimeout(requestsTimer);
    requestsTimer = 0;
  };
  const pollRequests = (page) => {
    stopRequestsPoll();
    const run = state.run;
    const tick = async () => {
      if (run !== state.run || !page.isConnected || page.classList.contains("hide")) return;
      const onDiscover = new URLSearchParams(window.location.hash.split("?")[1] || "").get("hera");
      if (!document.hidden && !onDiscover && state.shown.has("requests")) {
        try {
          const spec = await requestsRow();
          if (run === state.run && page.isConnected) show("requests", spec);
        } catch (error) {
          console.warn("[Hera TV:home] requests", error);
        }
      }
      requestsTimer = setTimeout(tick, requestsBusy ? 8000 : 30000);
    };
    requestsTimer = setTimeout(tick, 8000);
  };

  const trendingRow = async () => {
    const { seerr, features } = await kit.integrations();
    if (!seerr || features?.trending === false) return null;
    const items = await load("trending", 10 * 60 * 1000, async () => {
      const pages = await Promise.all([1, 2].map((page) => kit.hera("discover/lists/trending", { query: { page } }).catch(() => null)));
      const seen = new Set();
      return pages
        .flatMap((p) => p?.results ?? [])
        .filter((item) => item.status === "none" && item.poster && !seen.has(`${item.mediaType}${item.tmdbId}`) && seen.add(`${item.mediaType}${item.tmdbId}`))
        .slice(0, SHELF_LIMIT);
    });
    const entries = (items ?? []).map((item) => ({
      item,
      title: item.title,
      subtitle: [item.mediaType === "tv" ? "TV Show" : "Film", item.year].filter(Boolean).join(" · "),
      image: item.poster,
    }));
    return entries.length
      ? {
          title: "Trending to Request",
          href: "#/home?hera=discover",
          entries,
          card: (e) => {
            const card = kit.card({ onClick: () => openSeerrTitle(e.item), image: e.image, title: e.title, subtitle: e.subtitle });
            card.heraItem = e.item;
            return card;
          },
        }
      : null;
  };

  // ---------- mounting -----------------------------------------------------------------------

  const homeContainer = () => document.querySelector("#indexPage #homeTab .homeSectionsContainer");

  /** Where a row goes among its siblings: by rank, after Jellyfin's own sections. */
  const place = (row) => {
    const container = homeContainer();
    if (!container) return;
    const rank = RANK[row.dataset.heraRow];
    if (rank === 0) {
      container.prepend(row);
      return;
    }
    const later = [...container.children].find((child) => RANK[child.dataset?.heraRow] > rank);
    container.insertBefore(row, later || null);
  };

  const removeRow = (id) => {
    state.shown.get(id)?.row.remove();
    state.shown.delete(id);
  };

  const setHidden = (hidden) => {
    for (const { row } of state.shown.values()) row.hidden = hidden;
  };

  // What the person hid (hera-extras.js). Up Next drops a removed title until it is watched again;
  // the taste and Seerr rows drop what was marked Not Interested, by library id or TMDB id.
  const isHidden = (id, entry) => {
    const store = heraTv.hidden;
    if (!store) return false;
    if (id === "upnext") {
      const held = store.match("upnext", entry.hideKeys);
      return !!held && !(entry.at > Date.parse(held.at));
    }
    if (id === "trending") {
      return !!store.match("interest", [`tmdb:${entry.item.mediaType}:${entry.item.tmdbId}`, entry.item.jellyfinId ? plainId(entry.item.jellyfinId) : null]);
    }
    return id.startsWith("picks") && !!store.match("interest", [plainId(entry.id)]);
  };

  /** Shows a row, or removes it when it has nothing. Unchanged data leaves the row alone. */
  const show = (id, shown) => {
    const entries = (shown?.entries ?? []).filter((entry) => !isHidden(id, entry));
    if (!entries.length) return removeRow(id);
    const spec = { ...shown, entries };
    const sig = JSON.stringify([spec.title, spec.sig ?? spec.entries]);
    const held = state.shown.get(id);
    if (held?.sig === sig) {
      if (!held.row.isConnected) kit.mountRow(held.row, place);
      spec.update?.(held.row, spec.entries);
      return;
    }
    const row = kit.shelf({
      id,
      title: spec.title,
      href: spec.href,
      shape: spec.shape || "poster",
      cards: spec.entries.map(spec.card || posterCard),
    });
    // On a remote, Left and Right stop at the ends of a row; Jellyfin's spatial navigation would
    // otherwise jump to whatever lies nearest, such as the hero's controls above the first row.
    row.addEventListener("keydown", (event) => {
      if (!kit.isTv() || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const cell = event.target.closest?.(".hera-upnext") || event.target.closest?.(".hera-card");
      if (!cell) return;
      const edge = event.key === "ArrowLeft" ? cell.previousElementSibling : cell.nextElementSibling;
      if (!edge) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    state.shown.set(id, { sig, row });
    kit.mountRow(row, place);
  };

  // Jellyfin paints its own sections into the container after the page shows, which can drop
  // rows that were mounted first; put them back.
  const watch = (container) => {
    if (state.container === container) return;
    state.observer?.disconnect();
    state.container = container;
    let queued = false;
    state.observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!container.isConnected) return;
        for (const { row } of state.shown.values()) {
          if (row.parentNode !== container) kit.mountRow(row, place);
        }
        tidyStock(container);
      });
    });
    state.observer.observe(container, { childList: true, subtree: true });
    tidyStock(container);
  };

  // ---------- Jellyfin's own sections -------------------------------------------------------
  // Home is built from Hera's rows plus Jellyfin's Recently Added. The container holds one
  // element per home-settings slot (class "section<N>"); the person's `homesection<N>` setting
  // (display preferences, client "emby") says which slot holds Recently Added. Every other slot
  // is hidden, by a class of ours that Jellyfin's own show/hide never touches. An account that
  // never changed its home settings has jellyfin-web's own layout, below. Until the settings are
  // known a stylesheet rule holds the stock sections back, so nothing flashes.

  const STOCK_LAYOUT = ["smalllibrarytiles", "resume", "resumeaudio", "resumebook", "livetv", "nextup", "latestmedia"];

  const homeSettings = () =>
    load("home-settings", 30 * 1000, async () => {
      const prefs = await kit.getJSON("DisplayPreferences/usersettings", { userId: kit.userId(), client: "emby" });
      return prefs?.CustomPrefs || {};
    });

  const keptSlots = (prefs) => {
    const kept = new Set();
    for (let slot = 0; slot < 10; slot++) {
      if ((prefs[`homesection${slot}`] ?? STOCK_LAYOUT[slot] ?? "none") === "latestmedia") kept.add(slot);
    }
    return kept;
  };

  const slotOf = (node) => {
    const match = /(?:^|\s)section(\d+)(?:\s|$)/.exec(node.className);
    return match ? Number(match[1]) : null;
  };

  const tidyStock = (container) => {
    if (state.kept) {
      for (const section of container.children) {
        const slot = slotOf(section);
        if (slot === null || section.classList.contains("hera-row")) continue;
        const keep = state.kept === "all" || state.kept.has(slot);
        const was = section.classList.contains("hera-stock-hidden");
        section.classList.toggle("hera-keep", keep);
        section.classList.toggle("hera-stock-hidden", !keep);
        if (!keep) section.classList.add("hide");
        else if (was) section.classList.remove("hide");
      }
    }
    tidyLibraryTiles(container);
  };

  // Jellyfin's TV layout always puts a "My Media" row of library tiles first, whatever the home
  // settings say. The header tabs already open each library, so it steps aside for our rows.
  // `hide` is Jellyfin's own class, which the focus handoff from the hero also respects.
  const tidyLibraryTiles = (container) => {
    if (!kit.isTv()) return;
    for (const section of container.querySelectorAll(":scope > .verticalSection:not(.hera-row)")) {
      if (section.querySelector(':scope .itemsContainer > [data-type="CollectionFolder"], :scope .itemsContainer > [data-type="UserView"]')) {
        section.classList.add("hide", "hera-library-tiles");
      }
    }
  };

  const jobs = [
    ["upnext", async () => {
      const entries = await upNextEntries();
      return entries?.length ? { title: "Up Next", shape: "wide", entries, card: upNextCard } : null;
    }],
    ["picks-1", async () => ((await picksForMovies())?.[0] ?? null)],
    ["picks-2", async () => ((await picksForMovies())?.[1] ?? null)],
    ["picks-tv", picksForSeries],
    ["leaving", leavingRow],
    ["requests", requestsRow],
    ["trending", trendingRow],
  ];

  const hiddenReady = () => (heraTv.hidden ? heraTv.hidden.ready() : Promise.resolve([]));

  const refreshHome = (page) => {
    const user = kit.userId();
    if (state.user !== user) {
      for (const id of [...state.shown.keys()]) removeRow(id);
      state.cache.clear();
      state.kept = null;
      state.user = user;
    }
    const container = homeContainer();
    if (!container) return;
    watch(container);
    const run = ++state.run;
    document.documentElement.classList.add("hera-owns-home");
    state.cache.delete("home-settings");
    homeSettings()
      .then((prefs) => {
        state.kept = keptSlots(prefs);
      })
      .catch(() => {
        // Unknown settings: show Jellyfin's sections rather than risk hiding Recently Added.
        state.kept = "all";
      })
      .finally(() => {
        if (run === state.run && container.isConnected) tidyStock(container);
      });
    for (const [id, job] of jobs) {
      job()
        .then(async (spec) => {
          await hiddenReady();
          // A newer visit, a different profile or another page showing makes this answer stale.
          if (run !== state.run || state.user !== kit.userId() || !page.isConnected) return;
          show(id, spec);
        })
        .catch((error) => console.error(`[Hera TV:home] ${id}`, error));
    }
    pollRequests(page);
  };

  // ---------- leaving chip on detail pages ---------------------------------------------------

  const clearChips = () => {
    state.detailObserver?.disconnect();
    state.detailObserver = null;
    document.querySelectorAll(".hera-leaving").forEach((chip) => chip.remove());
  };

  const markLeaving = async (page, itemId) => {
    clearChips();
    if (!itemId) return;
    const list = await leavingList();
    const entry = list?.find((e) => plainId(e.jellyfinId) === plainId(itemId));
    if (!entry || !page.isConnected || kit.itemIdFromHash() !== itemId) return;
    const text = `Leaving ${kit.shortDate(entry.leavesOn)}`;
    const apply = () => {
      const meta = page.querySelector(".itemMiscInfo-primary");
      if (!meta || meta.querySelector(".hera-leaving") || !meta.children.length) return;
      const chip = kit.el("span", { class: "hera-leaving", text });
      const rating = meta.querySelector(".mediaInfoOfficialRating");
      if (rating) rating.after(chip);
      else meta.append(chip);
    };
    apply();
    // The meta line is redrawn when the item finishes loading; keep the chip on it.
    const target = page.querySelector(".itemMiscInfo-primary")?.parentElement || page;
    state.detailObserver = new MutationObserver(apply);
    state.detailObserver.observe(target, { childList: true, subtree: true });
  };

  // ---------- module -------------------------------------------------------------------------

  heraTv.register({
    name: "home",
    onView(page, { itemId, params }) {
      if (page.id === "indexPage") {
        clearChips();
        // Discover's view shares the home page; its rows stay out of the way.
        if (params.get("hera")) {
          setHidden(true);
          return;
        }
        setHidden(false);
        refreshHome(page);
      } else if (page.id === "itemDetailPage") {
        markLeaving(page, itemId).catch((error) => console.error("[Hera TV:home]", error));
      } else {
        clearChips();
      }
    },
    teardown() {
      state.run++;
      state.observer?.disconnect();
      state.observer = null;
      state.container = null;
      state.cache.clear();
      for (const id of [...state.shown.keys()]) removeRow(id);
      document.querySelectorAll(".hera-library-tiles").forEach((n) => n.classList.remove("hide", "hera-library-tiles"));
      document.querySelectorAll(".hera-stock-hidden").forEach((n) => n.classList.remove("hide", "hera-stock-hidden"));
      document.querySelectorAll(".hera-keep").forEach((n) => n.classList.remove("hera-keep"));
      document.documentElement.classList.remove("hera-owns-home");
      state.kept = null;
      clearChips();
      stopRequestsPoll();
    },
  });
})();
