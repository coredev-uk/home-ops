/*
 * Hera TV: search. Registers with window.HeraTV (hera-tv.js).
 *  - The header's search button opens a glass field in the header with a dropdown of suggestions
 *    that updates on every key; Enter opens the full results.
 *  - Jellyfin's search page (#/search) is replaced by the Apple TV app's search: one field,
 *    results on every key, category chips, Seerr titles that are not in the library, and an
 *    on-screen keyboard in the TV layout.
 * Both share one engine: per kind Jellyfin API queries, ranking, caches, and cancellation of the
 * request a newer key supersedes. Jellyfin's own page and route stay; its markup is only hidden.
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const MIN_LIBRARY = 1; // the library answers from the first letter
  const MIN_SEERR = 2; // Seerr is an external call; one letter is noise
  const SEERR_SETTLE = 220; // Seerr waits for a pause in typing; the library never does
  const LIBRARY_TTL = 60 * 1000;
  const SEERR_TTL = 20 * 1000;
  const SHELF_LIMIT = 20;
  const TOP_LIMIT = 12;
  const RECENT_LIMIT = 8;
  const MENU_LIBRARY_ROWS = 6;
  const MENU_SEERR_ROWS = 3;

  // Library categories, in the order their shelves appear. `path` is the API route; `types` the
  // item types it asks for; `limit` how many the server may return.
  const CATEGORIES = [
    { id: "film", label: "Films", types: "Movie", shape: "poster", limit: 60 },
    { id: "show", label: "TV Shows", types: "Series", shape: "poster", limit: 60 },
    { id: "episode", label: "Episodes", types: "Episode", shape: "wide", limit: 40 },
    { id: "person", label: "People", path: "Persons", shape: "person", limit: 40 },
    { id: "collection", label: "Collections", types: "BoxSet", shape: "poster", limit: 30 },
  ];
  const INDEX = { episode: 2, person: 3 };
  const REQUEST_CATEGORY = { id: "request", label: "Not in Your Library", shape: "poster" };
  const ALL = { id: "all", label: "All" };
  const KIND = { Movie: "Film", Series: "TV Show", BoxSet: "Collection", Person: "Person" };
  const KEYS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

  /** The search page while it shows; null otherwise. */
  let ui = null;
  /** The header's search field; built on first use. */
  let hs = null;

  // ---------- data ----------------------------------------------------------------------

  const request = async (path, query, signal) => {
    const api = kit.api();
    const response = await fetch(api.getUrl(path, query), {
      signal,
      headers: { Authorization: `MediaBrowser Token="${api.accessToken()}"` },
    });
    if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status}`), { status: response.status });
    return response.json();
  };

  const timed = new Map();
  const remember = (cache, key, ttl) => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < ttl ? hit.value : null;
  };

  const ITEM_FIELDS = "PrimaryImageAspectRatio,ProductionYear";

  const fetchCategory = (category, term, signal) => {
    const common = { userId: kit.userId(), searchTerm: term, limit: category.limit, imageTypeLimit: 1, enableTotalRecordCount: false };
    const query = category.path
      ? common
      : { ...common, includeItemTypes: category.types, recursive: true, fields: ITEM_FIELDS, enableImageTypes: "Primary,Thumb,Backdrop" };
    return request(category.path || "Items", query, signal).then((data) => data?.Items ?? []);
  };

  // ---------- ranking -------------------------------------------------------------------
  // Jellyfin returns each kind in its own order. Rank by how the name matches: exact, then starts
  // with, then a word starts with, then contains.

  const plain = (text) =>
    String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const scoreName = (name, query) => {
    const text = plain(name);
    if (!text || !query) return 0;
    if (text === query) return 100;
    if (text.startsWith(query)) return 80;
    if (text.split(" ").some((word) => word.startsWith(query))) return 60;
    return text.includes(query) ? 40 : 10;
  };

  // A stable sort by how the name matches puts what was typed first; ties keep the server's order.
  const fetchLibrary = (term, signal) => {
    const query = plain(term);
    return Promise.all(
      CATEGORIES.map((category) =>
        fetchCategory(category, term, signal).then((items) =>
          items.map((item) => ({ item, score: scoreName(item.Name, query) })).sort((a, b) => b.score - a.score).map((entry) => entry.item),
        ),
      ),
    );
  };

  const fetchSeerr = (term, signal) =>
    request("HeraTV/discover/search", { query: term, page: 1 }, signal).then((data) => (data?.results ?? []).filter((item) => !item.jellyfinId));

  const KIND_BIAS = { Series: 3, Movie: 2, BoxSet: 1, Person: 0 };

  const topResults = (lib, term) => {
    const query = plain(term);
    const pool = [];
    CATEGORIES.forEach((category, index) => {
      if (category.id === "episode") return;
      lib[index].forEach((item, rank) => {
        const score = scoreName(item.Name, query);
        if (score >= 40) pool.push({ item, score, rank });
      });
    });
    // People lead only when the name really is what was typed: an exact match, or a name that
    // starts with it when no title does.
    const titleBest = Math.max(0, ...pool.filter((entry) => entry.item.Type !== "Person").map((entry) => entry.score));
    const ranked = pool
      .filter((entry) => entry.item.Type !== "Person" || entry.score === 100 || (entry.score >= 80 && titleBest < 80))
      .map((entry) => ({ ...entry, score: entry.score + (KIND_BIAS[entry.item.Type] ?? 0) }));
    ranked.sort((a, b) => b.score - a.score || a.rank - b.rank);
    return ranked.slice(0, TOP_LIMIT).map((entry) => entry.item);
  };

  // ---------- engine --------------------------------------------------------------------
  // One run per key. A new run aborts the previous run's requests and makes its answers stale, so
  // a slow reply to "bro" never paints over "broo". The library is asked at once; Seerr after a
  // short pause. Hooks: onStart(data), onLibrary(data), onSeerr(data), onError(data, error).

  const createRunner = (hooks) => {
    let seq = 0;
    let controller = null;
    let timer = 0;
    let active = "";
    const cancel = () => {
      clearTimeout(timer);
      controller?.abort();
      controller = null;
      seq++;
      active = "";
    };
    const run = (term, { force = false } = {}) => {
      if (!force && term === active) return;
      clearTimeout(timer);
      controller?.abort();
      const mine = ++seq;
      active = term;
      controller = new AbortController();
      const { signal } = controller;
      const stale = () => mine !== seq;
      const key = term.toLowerCase();
      const seerrOn = hooks.seerr() && term.length >= MIN_SEERR;
      const data = {
        term,
        lib: remember(timed, `lib:${key}`, LIBRARY_TTL),
        seerr: seerrOn ? remember(timed, `seerr:${key}`, SEERR_TTL) ?? "loading" : "off",
      };
      hooks.onStart(data);
      if (data.lib) hooks.onLibrary(data);
      else {
        fetchLibrary(term, signal)
          .then((lib) => {
            if (stale()) return;
            data.lib = lib;
            timed.set(`lib:${key}`, { at: Date.now(), value: lib });
            hooks.onLibrary(data);
          })
          .catch((error) => {
            if (stale() || error?.name === "AbortError") return;
            console.error("[Hera TV:search]", error);
            hooks.onError(data, error);
          });
      }
      if (data.seerr === "loading") {
        timer = setTimeout(() => {
          fetchSeerr(term, signal)
            .then((items) => {
              if (stale()) return;
              data.seerr = items;
              timed.set(`seerr:${key}`, { at: Date.now(), value: items });
              hooks.onSeerr(data);
            })
            .catch((error) => {
              if (stale() || error?.name === "AbortError") return;
              // Requesting is an extra; a Seerr failure leaves the library's results alone.
              data.seerr = [];
              hooks.onSeerr(data);
            });
        }, SEERR_SETTLE);
      }
    };
    return { run, cancel, reset: () => (active = "") };
  };

  // ---------- cards ---------------------------------------------------------------------

  const art = (item, type, width) =>
    item.ImageTags?.[type] ? kit.imageUrl(item.Id, type, { maxWidth: width, tag: item.ImageTags[type] }) : null;

  const episodeArt = (item, width = 640) => {
    if (item.ImageTags?.Primary) return art(item, "Primary", width);
    if (item.ParentThumbItemId && item.ParentThumbImageTag) {
      return kit.imageUrl(item.ParentThumbItemId, "Thumb", { maxWidth: width, tag: item.ParentThumbImageTag });
    }
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
      return kit.imageUrl(item.ParentBackdropItemId, "Backdrop", { maxWidth: width, tag: item.ParentBackdropImageTags[0] });
    }
    return null;
  };

  const episodeLine = (item) => {
    const number = [item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : null, item.IndexNumber != null ? `E${item.IndexNumber}` : null]
      .filter(Boolean)
      .join(", ");
    return [item.SeriesName, number].filter(Boolean).join(" · ");
  };

  const libraryCard = (item, { mixed = false } = {}) => {
    const href = `#/details?id=${item.Id}`;
    if (item.Type === "Episode") {
      return kit.card({ href, shape: "wide", image: episodeArt(item), title: item.Name, subtitle: episodeLine(item) });
    }
    if (item.Type === "Person") {
      const card = kit.card({ href, shape: "person", image: art(item, "Primary", 320), title: item.Name, subtitle: mixed ? KIND.Person : null });
      const ghost = card.querySelector(".hera-card__fallback");
      if (ghost) ghost.replaceWith(el("span", { class: "hera-search__ghost" }, icon("person")));
      return card;
    }
    const subtitle =
      item.Type === "BoxSet"
        ? KIND.BoxSet
        : mixed
          ? [KIND[item.Type], item.ProductionYear].filter(Boolean).join(" · ")
          : item.ProductionYear
            ? String(item.ProductionYear)
            : null;
    return kit.card({ href, image: art(item, "Primary", 400), title: item.Name, subtitle });
  };

  const SEERR_BADGE = { partial: "Partly Available", processing: "Processing", pending: "Requested" };
  const seerrBadge = (item) => {
    const status = item.status ?? "none";
    if (status === "available") return item.jellyfinId ? "In Library" : "Available";
    return SEERR_BADGE[status] ?? null;
  };
  const seerrKind = (item) => (item.mediaType === "tv" ? "TV Show" : "Film");

  // Seerr titles share a data-hera-key with Discover's cards, so a request made from the sheet
  // updates the badge here too.
  const seerrCard = (item) => {
    const available = (item.status ?? "none") === "available";
    const card = kit.card({
      href: item.jellyfinId ? `#/details?id=${item.jellyfinId}` : null,
      onClick: item.jellyfinId ? null : (event) => HT.discover?.openTitle?.(item, { opener: event.currentTarget }),
      image: item.poster,
      title: item.title,
      subtitle: [item.year, seerrKind(item)].filter(Boolean).join(" · "),
      badge: seerrBadge(item),
      badgeTone: available ? "light" : undefined,
    });
    card.dataset.heraKey = `${item.mediaType}:${item.tmdbId}`;
    card.heraItem = item;
    return card;
  };

  const shelfOf = (title, cards, shape, onAll) => {
    const row = kit.shelf({ title, cards, shape });
    row.classList.add("hera-search__row");
    if (onAll) {
      row.querySelector(".hera-row__head").append(
        el("button", { type: "button", class: "hera-search__all", "aria-label": `See all ${title}`, onclick: onAll }, ["See All", icon("chevron_right")]),
      );
    }
    return row;
  };

  const gridOf = (title, cards, shape) =>
    el("section", { class: "hera-search__group", "aria-label": title }, [
      el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title hera-search__title", text: title }),
      el("div", { class: `hera-search__grid hera-search__grid--${shape}` }, cards),
    ]);

  // ---------- recent searches -----------------------------------------------------------

  const recentKey = () => `hera.search.recent.${kit.userId()}`;
  const readRecent = () => {
    try {
      const list = JSON.parse(localStorage.getItem(recentKey()) || "[]");
      return Array.isArray(list) ? list.filter((text) => typeof text === "string") : [];
    } catch {
      return [];
    }
  };
  const writeRecent = (list) => {
    try {
      localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, RECENT_LIMIT)));
    } catch {
      /* storage is full or blocked; recent searches are a nicety */
    }
  };
  const rememberSearch = (term) => {
    const text = term.trim();
    if (text.length < 2) return;
    writeRecent([text, ...readRecent().filter((entry) => entry.toLowerCase() !== text.toLowerCase())]);
  };

  const visible = (node) => node.getClientRects().length > 0;

  const queryOf = (params) => (params.get("q") || params.get("query") || "").trim();
  const filterOf = (params) => {
    const id = params.get("in");
    return [...CATEGORIES, REQUEST_CATEGORY].some((category) => category.id === id) ? id : "all";
  };
  const searchHash = (term) => `#/search?q=${encodeURIComponent(term)}`;

  // ==================================================================================
  // The search page
  // ==================================================================================

  const abortIdle = () => ui.idleController.abort();

  const syncUrl = () => {
    if (!window.location.hash.startsWith("#/search")) return;
    const params = new URLSearchParams();
    if (ui.term) {
      params.set("q", ui.term);
      if (ui.filter !== "all") params.set("in", ui.filter);
    }
    const text = params.toString();
    const next = `${window.location.hash.split("?")[0]}${text ? `?${text}` : ""}`;
    // replaceState does not tell Jellyfin's router, so the page is not rebuilt as the term changes,
    // and Back from a result returns here with the same search.
    if (window.location.hash !== next) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + next);
  };

  const say = (text) => {
    ui.status.textContent = text;
  };

  // -- idle: recent searches and suggestions

  const renderRecent = () => {
    const list = readRecent();
    ui.recent.replaceChildren();
    ui.recent.hidden = list.length === 0;
    if (!list.length) return;
    const rows = list.map((text) =>
      el("li", { class: "hera-search__recent-item" }, [
        el("button", { type: "button", class: "hera-search__recent-text", onclick: () => submit(text) }, [icon("history"), el("span", { text })]),
        el(
          "button",
          {
            type: "button",
            class: "hera-search__recent-remove",
            "aria-label": `Remove ${text} from recent searches`,
            onclick: () => {
              writeRecent(readRecent().filter((entry) => entry !== text));
              renderRecent();
            },
          },
          icon("close"),
        ),
      ]),
    );
    ui.recent.append(
      el("div", { class: "hera-search__recent-head" }, [
        el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title", text: "Recent Searches" }),
        el(
          "button",
          {
            type: "button",
            class: "hera-search__link",
            onclick: () => {
              writeRecent([]);
              renderRecent();
            },
          },
          "Clear",
        ),
      ]),
      el("ul", { class: "hera-search__recent-list" }, rows),
    );
  };

  const loadIdle = async () => {
    const signal = ui.idleController.signal;
    const lists = [
      {
        slot: ui.addedSlot,
        title: "Recently Added",
        load: () =>
          request(
            "Items",
            {
              userId: kit.userId(),
              sortBy: "DateCreated",
              sortOrder: "Descending",
              includeItemTypes: "Movie,Series",
              recursive: true,
              limit: 24,
              fields: ITEM_FIELDS,
              imageTypeLimit: 1,
              enableTotalRecordCount: false,
            },
            signal,
          ).then((data) => (data?.Items ?? []).map((item) => libraryCard(item, { mixed: true }))),
      },
      ui.seerr && {
        slot: ui.trendingSlot,
        title: "Trending",
        load: () =>
          kit.hera("discover/lists/trending", { query: { page: 1 } }).then((data) => (data?.results ?? []).slice(0, 24).map((item) => seerrCard(item))),
      },
    ].filter(Boolean);
    await Promise.all(
      lists.map(async (list) => {
        try {
          const cards = await list.load();
          if (signal.aborted || !ui || !cards.length) return;
          list.slot.replaceChildren(shelfOf(list.title, cards, "poster"));
        } catch {
          /* suggestions are an extra; the field still works */
        }
      }),
    );
  };

  // -- results

  const sectionCounts = (data) => {
    const counts = {};
    CATEGORIES.forEach((category, index) => {
      counts[category.id] = data.lib[index].length;
    });
    counts.request = Array.isArray(data.seerr) ? data.seerr.length : 0;
    return counts;
  };

  const renderChips = (counts) => {
    const ids = [ALL.id, ...CATEGORIES.filter((category) => counts[category.id]).map((category) => category.id)];
    if (counts.request) ids.push(REQUEST_CATEGORY.id);
    if (!ids.includes(ui.filter)) ui.filter = ALL.id;
    const focused = ui.chips.contains(document.activeElement) ? document.activeElement.dataset.chip : null;
    const labels = [ALL, ...CATEGORIES, REQUEST_CATEGORY];
    ui.chips.replaceChildren(
      ...ids.map((id) =>
        el("button", {
          type: "button",
          class: "hera-search__chip",
          "data-chip": id,
          "aria-pressed": id === ui.filter ? "true" : "false",
          onclick: () => setFilter(id),
          text: labels.find((label) => label.id === id).label,
        }),
      ),
    );
    ui.chips.hidden = ids.length < 3;
    if (focused) ui.chips.querySelector(`[data-chip="${focused}"]`)?.focus({ preventScroll: true });
  };

  const setFilter = (id) => {
    if (id === ui.filter || !ui.data) return;
    ui.filter = id;
    for (const chip of ui.chips.children) chip.setAttribute("aria-pressed", chip.dataset.chip === id ? "true" : "false");
    renderLibrary();
    renderSeerr();
    syncUrl();
  };

  const emptyState = (title, text, retry) =>
    el("div", { class: "hera-search__empty", role: "status" }, [
      el("h2", { class: "hera-search__empty-title", text: title }),
      el("p", { class: "hera-search__empty-text", text }),
      retry ? el("button", { type: "button", class: "hera-btn hera-btn--glass hera-btn--text", onclick: retry }, "Try Again") : null,
    ]);

  const renderLibrary = () => {
    const data = ui.data;
    const slot = ui.libSlot;
    if (!data?.lib) return;
    const counts = sectionCounts(data);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0) - counts.request;
    const seerrPending = data.seerr === "loading";
    if (!total && !counts.request) {
      slot.replaceChildren(
        seerrPending
          ? el("p", { class: "hera-search__busy", role: "status", text: "Searching…" })
          : emptyState(`No results for “${data.term}”`, "Check the spelling or try a different search."),
      );
      ui.chips.hidden = true;
      say(seerrPending ? "" : `No results for ${data.term}`);
      return;
    }
    const nodes = [];
    if (ui.filter === "all") {
      const top = topResults(data.lib, data.term);
      if (top.length) nodes.push(shelfOf("Top Results", top.map((item) => libraryCard(item, { mixed: true })), "poster"));
      const shown = new Set(top.map((item) => item.Id));
      CATEGORIES.forEach((category, index) => {
        const items = data.lib[index];
        // A shelf that would only repeat Top Results is left out; its chip is still there.
        if (!items.length || items.every((item) => shown.has(item.Id))) return;
        const more = items.length > SHELF_LIMIT ? () => setFilter(category.id) : null;
        nodes.push(shelfOf(category.label, items.slice(0, SHELF_LIMIT).map((item) => libraryCard(item)), category.shape, more));
      });
    } else {
      const index = CATEGORIES.findIndex((category) => category.id === ui.filter);
      if (index >= 0) {
        const category = CATEGORIES[index];
        nodes.push(gridOf(category.label, data.lib[index].map((item) => libraryCard(item)), category.shape));
      }
    }
    slot.replaceChildren(...nodes);
    renderChips(counts);
    say(`${total + counts.request} results for ${data.term}`);
  };

  const renderSeerr = () => {
    const data = ui.data;
    if (!data?.lib) return;
    const items = Array.isArray(data.seerr) ? data.seerr : [];
    ui.seerrSlot.replaceChildren();
    if (!items.length || (ui.filter !== "all" && ui.filter !== "request")) return;
    const cards = items.map((item) => seerrCard(item));
    ui.seerrSlot.append(
      ui.filter === "request"
        ? gridOf(REQUEST_CATEGORY.label, cards, "poster")
        : shelfOf(REQUEST_CATEGORY.label, cards.slice(0, SHELF_LIMIT), "poster", items.length > SHELF_LIMIT ? () => setFilter("request") : null),
    );
  };

  const showResults = (on) => {
    ui.idle.hidden = on;
    ui.results.hidden = !on;
    if (!on) {
      ui.chips.hidden = true;
      ui.results.setAttribute("aria-busy", "false");
      say("");
    }
  };

  const showIdle = () => {
    ui.runner.cancel();
    ui.data = null;
    ui.term = "";
    showResults(false);
    renderRecent();
    syncUrl();
  };

  const pageHooks = {
    seerr: () => Boolean(ui?.seerr),
    onStart(data) {
      ui.term = data.term;
      showResults(true);
      if (!data.lib) {
        ui.results.setAttribute("aria-busy", "true");
        if (!ui.libSlot.firstChild) ui.libSlot.append(el("p", { class: "hera-search__busy", role: "status", text: "Searching…" }));
      }
      syncUrl();
    },
    onLibrary(data) {
      ui.data = data;
      ui.results.setAttribute("aria-busy", "false");
      renderLibrary();
      renderSeerr();
    },
    onSeerr(data) {
      if (ui.data !== data) return;
      const counts = sectionCounts(data);
      // With no library hits this decides between "no results" and results, so redraw it all.
      if (!(counts.film + counts.show + counts.episode + counts.person + counts.collection)) renderLibrary();
      else renderChips(counts);
      renderSeerr();
    },
    onError(data) {
      ui.results.setAttribute("aria-busy", "false");
      ui.chips.hidden = true;
      ui.seerrSlot.replaceChildren();
      ui.libSlot.replaceChildren(emptyState("Search isn't available right now", "Try again in a moment.", () => ui.runner.run(data.term, { force: true })));
    },
  };

  // Every key searches at once; the engine cancels what the next key supersedes.
  const onInput = () => {
    const text = ui.input.value.trim();
    ui.clear.hidden = !ui.input.value;
    if (text.length < MIN_LIBRARY) showIdle();
    else ui.runner.run(text);
  };

  const submit = (text) => {
    ui.input.value = text;
    ui.clear.hidden = !text;
    const term = text.trim();
    if (term.length < MIN_LIBRARY) showIdle();
    else ui.runner.run(term);
    ui.input.focus({ preventScroll: true });
  };

  // -- keyboard

  // Desktop arrow keys move between the field, chips and cards by where they are on screen.
  // The TV layout has Jellyfin's own remote navigation, so it is left to that.
  const FOCUSABLE = "input, a[href], button:not([tabindex='-1'])";
  const move = (from, direction) => {
    const origin = from.getBoundingClientRect();
    const ox = origin.left + origin.width / 2;
    const oy = origin.top + origin.height / 2;
    const vertical = direction === "up" || direction === "down";
    const found = [];
    for (const node of ui.root.querySelectorAll(FOCUSABLE)) {
      if (node === from || node.disabled || !visible(node)) continue;
      const box = node.getBoundingClientRect();
      const dx = box.left + box.width / 2 - ox;
      const dy = box.top + box.height / 2 - oy;
      if (vertical) {
        if (direction === "down" ? dy <= origin.height * 0.4 : dy >= -origin.height * 0.4) continue;
      } else {
        const sameRow = Math.abs(dy) < Math.min(box.height, origin.height) * 0.6;
        if (!sameRow || (direction === "right" ? dx <= 2 : dx >= -2)) continue;
      }
      found.push({ node, dx, dy });
    }
    if (!found.length) return null;
    // Up and down stay in the nearest row, then pick the control closest across; left and right
    // take the nearest neighbour in the row.
    const rowGap = vertical ? Math.min(...found.map((entry) => Math.abs(entry.dy))) : 0;
    const row = vertical ? found.filter((entry) => Math.abs(entry.dy) <= rowGap + 96) : found;
    row.sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx));
    return row[0].node;
  };

  const onKeydown = (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const inField = target === ui.input;
    if (event.key === "Escape" && inField && ui.input.value) {
      event.preventDefault();
      event.stopPropagation();
      submit("");
      return;
    }
    if (event.key === "Enter" && inField) {
      event.preventDefault();
      // The results are already for what was typed; Enter keeps it in Recent Searches.
      rememberSearch(ui.input.value);
      return;
    }
    // A letter typed anywhere on the page goes to the field.
    if (!inField && event.key.length === 1 && !kit.isTv() && /[^\s]/.test(event.key) && target.closest?.("[data-hera-search]") && !target.matches?.("input, textarea")) {
      ui.input.focus({ preventScroll: true });
      ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length);
      return;
    }
    if (kit.isTv()) return;
    const direction = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[event.key];
    if (!direction || (inField && (direction === "left" || direction === "right"))) return;
    // Down from the field lands on the chosen category, as the next stop of the page.
    const chosen = inField && direction === "down" && !ui.chips.hidden ? ui.chips.querySelector("[aria-pressed='true']") : null;
    const next = chosen || move(target, direction);
    if (next) {
      event.preventDefault();
      next.focus();
    } else if (inField && direction === "down") {
      event.preventDefault();
    }
  };


  const typeKey = (text) => {
    ui.input.value = text === "\b" ? ui.input.value.slice(0, -1) : ui.input.value + text;
    onInput();
  };

  const buildKeyboard = () => {
    const key = (label, onclick, { name, text, wide } = {}) =>
      el("button", { type: "button", class: `hera-search__key${wide ? " hera-search__key--wide" : ""}`, "aria-label": name || label, onclick }, text ?? label);
    return el("div", { class: "hera-search__keys", role: "group", "aria-label": "Keyboard" }, [
      ...KEYS.map((k) => key(k, () => typeKey(k), { text: k })),
      key("space", () => typeKey(" "), { name: "Space", text: [icon("space_bar")], wide: true }),
      key("delete", () => typeKey("\b"), { name: "Delete", text: [icon("backspace")], wide: true }),
      key("clear", () => submit(""), { name: "Clear", text: "Clear", wide: true }),
    ]);
  };

  // -- mount

  const build = (page) => {
    const input = el("input", {
      class: "hera-search__input",
      type: "search",
      placeholder: "Films, TV Shows, People",
      "aria-label": "Search",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "search",
    });
    const clear = el("button", { type: "button", class: "hera-search__clear", hidden: true, "aria-label": "Clear search" }, icon("close"));
    const chips = el("div", { class: "hera-search__chips", role: "group", "aria-label": "Filter results", hidden: true });
    const status = el("p", { class: "hera-search__sr", role: "status", "aria-live": "polite" });
    const recent = el("section", { class: "hera-search__recent verticalSection", "aria-label": "Recent searches", hidden: true });
    const addedSlot = el("div", { class: "hera-search__slot" });
    const trendingSlot = el("div", { class: "hera-search__slot" });
    const idle = el("div", { class: "hera-search__idle" }, [recent, addedSlot, trendingSlot]);
    const libSlot = el("div", { class: "hera-search__slot" });
    const seerrSlot = el("div", { class: "hera-search__slot" });
    const results = el("div", { class: "hera-search__results", hidden: true, "aria-busy": "false" }, [libSlot, seerrSlot]);
    const root = el("div", { class: "hera-search", "data-hera-search": "" }, [
      el("h1", { class: "hera-search__heading", text: "Search" }),
      el("div", { class: "hera-search__bar", role: "search" }, [el("div", { class: "hera-search__field" }, [icon("search"), input, clear])]),
      kit.isTv() ? buildKeyboard() : null,
      chips,
      status,
      idle,
      results,
    ]);
    page.classList.add("hera-search-page");
    page.append(root);
    return { page, root, input, clear, chips, status, recent, addedSlot, trendingSlot, idle, results, libSlot, seerrSlot };
  };

  const unmount = () => {
    if (!ui) return;
    ui.runner.cancel();
    abortIdle();
    ui.leave?.();
    ui.page.classList.remove("hera-search-page");
    ui.root.remove();
    ui = null;
  };

  // The address changed under a page that is already showing: adopt its search.
  const adopt = (params) => {
    const wanted = queryOf(params);
    if (wanted === ui.input.value.trim()) return;
    ui.filter = filterOf(params);
    submit(wanted);
    if (!wanted && !kit.isTv()) ui.input.focus({ preventScroll: true });
  };

  const mount = async (page, params) => {
    if (ui?.page === page && ui.root.isConnected) {
      adopt(params);
      return;
    }
    unmount();
    const parts = build(page);
    ui = {
      ...parts,
      seerr: false,
      term: "",
      filter: "all",
      data: null,
      runner: createRunner(pageHooks),
      idleController: new AbortController(),
    };
    const mounted = ui;
    ui.input.addEventListener("input", onInput);
    ui.clear.addEventListener("click", () => {
      submit("");
      ui.input.focus({ preventScroll: true });
    });
    ui.root.addEventListener("keydown", onKeydown);
    ui.results.addEventListener("click", (event) => {
      if (event.target.closest?.(".hera-card")) rememberSearch(ui.term);
    });
    // Router pushes and Back do not fire hashchange; links to a search and the history buttons are
    // the ways the address changes under a search page that is already showing.
    const readHash = () => new URLSearchParams(window.location.hash.split("?")[1] || "");
    const onLink = (event) => {
      if (event.target.closest?.('a[href^="#/search"]')) setTimeout(() => ui === mounted && adopt(readHash()), 80);
    };
    const onPop = () => setTimeout(() => ui === mounted && window.location.hash.startsWith("#/search") && adopt(readHash()), 80);
    document.addEventListener("click", onLink, true);
    window.addEventListener("popstate", onPop);
    ui.leave = () => {
      document.removeEventListener("click", onLink, true);
      window.removeEventListener("popstate", onPop);
    };

    const ints = await kit.integrations();
    if (ui !== mounted) return;
    ui.seerr = Boolean(ints.seerr);

    renderRecent();
    const start = queryOf(params);
    ui.filter = filterOf(params);
    loadIdle();
    if (start.length >= MIN_LIBRARY) {
      ui.input.value = start;
      ui.clear.hidden = false;
      ui.runner.run(start);
    }

    // Jellyfin shows the page with an animation and may move focus as it settles.
    const focusIn = () => {
      if (ui !== mounted || mounted.root.contains(document.activeElement)) return;
      if (kit.isTv()) mounted.root.querySelector(".hera-search__key")?.focus({ preventScroll: true });
      else mounted.input.focus({ preventScroll: true });
    };
    focusIn();
    setTimeout(focusIn, 320);
  };

  // ==================================================================================
  // The header's search field
  // ==================================================================================
  // The app bar's search button opens a glass field where the tab capsule is, and a menu of
  // suggestions under it. On a TV the button keeps opening the full page: a remote types into a
  // header field only through the system keyboard, which hides the menu, where the page's own
  // keyboard keeps results in view and each key searches there too.

  const HEADER = ".MuiAppBar-root, .skinHeader";
  const BUTTON = '.MuiAppBar-root a[href="#/search"], .skinHeader a[href="#/search"], .headerSearchButton';

  const capsuleOf = () =>
    document.querySelector(".MuiAppBar-root > .MuiToolbar-root:first-child > .MuiStack-root") ||
    document.querySelector(".skinHeader .headerTabs");

  const placeHeader = () => {
    const capsule = capsuleOf();
    const box = capsule?.getBoundingClientRect();
    const height = box && box.height > 0 ? box.height : 52;
    const top = box && box.height > 0 ? box.top : 6;
    const width = Math.min(640, window.innerWidth - 32);
    const style = hs.root.style;
    style.setProperty("--hs-top", `${top}px`);
    style.setProperty("--hs-height", `${height}px`);
    style.setProperty("--hs-width", `${width}px`);
    style.setProperty("--hs-left", `${(window.innerWidth - width) / 2}px`);
  };

  // Over the home hero the app bar keeps the dark set whatever the scheme; the field follows it.
  const toneHeader = () => {
    const bar = document.querySelector(HEADER);
    if (!hs || !bar) return;
    const read = (node) => getComputedStyle(node).getPropertyValue("--hera-bg").trim();
    hs.root.classList.toggle("hera-dark", read(bar) !== read(document.documentElement));
  };

  const hsRow = (key, { shape, src, title, subtitle, badge, onActivate, glyph }) => {
    const id = `hera-hs-${hs.rows.length}`;
    const thumb = el("span", { class: `hera-hs__thumb hera-hs__thumb--${shape}` }, [
      src ? el("img", { src, alt: "", decoding: "async" }) : el("span", { class: "hera-hs__ghost" }, icon(glyph || (shape === "person" ? "person" : "movie"))),
    ]);
    const node = el(
      "div",
      { class: "hera-hs__row", role: "option", id, "aria-selected": "false", onmousedown: (event) => event.preventDefault(), onclick: onActivate },
      [
        thumb,
        el("span", { class: "hera-hs__text" }, [
          el("span", { class: "hera-hs__title", text: title }),
          subtitle ? el("span", { class: "hera-hs__sub", text: subtitle }) : null,
        ]),
        badge ? el("span", { class: "hera-hs__badge", text: badge }) : null,
      ],
    );
    hs.rows.push({ key, node, onActivate });
    return node;
  };

  const hsPlainRow = (key, glyph, text, onActivate, { trailing } = {}) => {
    const id = `hera-hs-${hs.rows.length}`;
    const node = el("div", { class: "hera-hs__row hera-hs__row--plain", role: "option", id, "aria-selected": "false", onmousedown: (event) => event.preventDefault(), onclick: onActivate }, [
      el("span", { class: "hera-hs__glyph" }, icon(glyph)),
      el("span", { class: "hera-hs__text" }, el("span", { class: "hera-hs__title", text })),
      trailing ? icon(trailing) : null,
    ]);
    hs.rows.push({ key, node, onActivate });
    return node;
  };

  const hsGroup = (title, rows) =>
    el("div", { class: "hera-hs__group", role: "group", "aria-label": title }, [el("div", { class: "hera-hs__heading", "aria-hidden": "true", text: title }), ...rows]);

  const openItem = (item, term) => {
    rememberSearch(term);
    closeHeader({ restore: false });
    kit.go(`#/details?id=${item.Id}`);
  };

  const libraryRow = (item, term) => {
    const type = item.Type;
    const base = { onActivate: () => openItem(item, term), title: item.Name };
    if (type === "Person") return hsRow(`i:${item.Id}`, { ...base, shape: "person", src: art(item, "Primary", 96), subtitle: KIND.Person });
    if (type === "Episode") return hsRow(`i:${item.Id}`, { ...base, shape: "wide", src: episodeArt(item, 128), subtitle: episodeLine(item), glyph: "tv" });
    const subtitle = type === "BoxSet" ? KIND.BoxSet : [KIND[type], item.ProductionYear].filter(Boolean).join(" · ");
    return hsRow(`i:${item.Id}`, { ...base, shape: "poster", src: art(item, "Primary", 96), subtitle, glyph: type === "BoxSet" ? "video_library" : type === "Series" ? "tv" : "movie" });
  };

  const seerrRow = (item, term) =>
    hsRow(`s:${item.mediaType}:${item.tmdbId}`, {
      shape: "poster",
      src: item.poster,
      title: item.title,
      subtitle: [item.year, seerrKind(item)].filter(Boolean).join(" · "),
      badge: seerrBadge(item),
      onActivate: () => {
        rememberSearch(term);
        const opener = hs.button;
        closeHeader({ restore: false });
        HT.discover?.openTitle?.(item, { opener });
      },
    });

  const goFull = (term) => {
    rememberSearch(term);
    closeHeader({ restore: false });
    kit.go(searchHash(term));
  };

  const setActive = (index, { scroll = true } = {}) => {
    hs.active = index;
    hs.rows.forEach((row, i) => {
      const on = i === index;
      row.node.classList.toggle("is-active", on);
      row.node.setAttribute("aria-selected", on ? "true" : "false");
    });
    const row = hs.rows[index];
    if (row) {
      hs.input.setAttribute("aria-activedescendant", row.node.id);
      if (scroll) row.node.scrollIntoView({ block: "nearest" });
    } else hs.input.removeAttribute("aria-activedescendant");
  };

  // Paints the menu from what has arrived. The row the keyboard is on stays on it as results
  // change under it; with none chosen, nothing is.
  const paintMenu = () => {
    // Until this key's answer arrives the last one stays, rows and all.
    if (hs.term && !hs.data?.lib && hs.menu.firstChild) return;
    const keep = hs.rows[hs.active]?.key;
    hs.rows = [];
    const term = hs.term;
    const data = hs.data;
    const groups = [];
    if (!term) {
      const recent = readRecent().slice(0, 5);
      if (recent.length) {
        groups.push(
          hsGroup(
            "Recent Searches",
            recent.map((text) =>
              hsPlainRow(`r:${text}`, "history", text, () => {
                hs.input.value = text;
                onHeaderInput();
                hs.input.focus();
              }),
            ),
          ),
        );
      }
    } else if (data?.lib) {
      const top = topResults(data.lib, term).slice(0, 4);
      const shown = new Set(top.map((item) => item.Id));
      const query = plain(term);
      const people = data.lib[INDEX.person].filter((item) => !shown.has(item.Id) && scoreName(item.Name, query) >= 60).slice(0, 2);
      const room = MENU_LIBRARY_ROWS - top.length - people.length;
      const episodes = data.lib[INDEX.episode].filter((item) => scoreName(item.Name, query) >= 60).slice(0, Math.max(0, Math.min(2, room)));
      if (top.length) groups.push(hsGroup("Top Results", top.map((item) => libraryRow(item, term))));
      if (people.length) groups.push(hsGroup("People", people.map((item) => libraryRow(item, term))));
      if (episodes.length) groups.push(hsGroup("Episodes", episodes.map((item) => libraryRow(item, term))));
      const requests = Array.isArray(data.seerr) ? data.seerr.slice(0, MENU_SEERR_ROWS) : [];
      if (requests.length) groups.push(hsGroup(REQUEST_CATEGORY.label, requests.map((item) => seerrRow(item, term))));
      if (!groups.length) {
        groups.push(
          el("div", { class: "hera-hs__note", role: "status" }, data.seerr === "loading" ? "Searching…" : `No results for “${term}”`),
        );
      }
    }
    const foot = term
      ? el("div", { class: "hera-hs__group hera-hs__group--foot" }, hsPlainRow("all", "search", `See all results for “${term}”`, () => goFull(term), { trailing: "chevron_right" }))
      : null;
    // The groups scroll; the "See all results" row stays in view under them.
    hs.menu.replaceChildren(...[groups.length ? el("div", { class: "hera-hs__scroll" }, groups) : null, foot].filter(Boolean));
    const shown = groups.length > 0 || Boolean(foot);
    hs.menu.hidden = !shown;
    hs.input.setAttribute("aria-expanded", shown ? "true" : "false");
    const again = keep ? hs.rows.findIndex((row) => row.key === keep) : -1;
    setActive(again, { scroll: false });
  };

  const headerHooks = {
    seerr: () => Boolean(hs?.seerr),
    onStart(data) {
      hs.data = data;
      hs.menu.setAttribute("aria-busy", data.lib ? "false" : "true");
    },
    onLibrary(data) {
      if (hs.data !== data) return;
      hs.menu.setAttribute("aria-busy", "false");
      paintMenu();
    },
    onSeerr(data) {
      if (hs.data === data) paintMenu();
    },
    onError() {
      hs.menu.setAttribute("aria-busy", "false");
      hs.menu.replaceChildren(el("div", { class: "hera-hs__note", role: "status" }, "Search isn't available right now."));
      hs.menu.hidden = false;
    },
  };

  // Every key searches at once.
  const onHeaderInput = () => {
    const text = hs.input.value.trim();
    hs.clear.hidden = !hs.input.value;
    hs.term = text;
    if (text.length < MIN_LIBRARY) {
      hs.runner.cancel();
      hs.data = null;
      hs.menu.setAttribute("aria-busy", "false");
      paintMenu();
    } else hs.runner.run(text);
  };

  const onHeaderKeydown = (event) => {
    if (event.isComposing) return;
    const last = hs.rows.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeHeader();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (last >= 0) setActive(hs.active >= last ? 0 : hs.active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (last >= 0) setActive(hs.active <= 0 ? (hs.active === 0 ? -1 : last) : hs.active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (hs.active >= 0) hs.rows[hs.active].onActivate();
      else if (hs.term) goFull(hs.term);
    } else if (event.key === "Tab") {
      closeHeader({ restore: false });
    }
  };

  const buildHeader = () => {
    const input = el("input", {
      class: "hera-hs__input",
      type: "search",
      role: "combobox",
      placeholder: "Search",
      "aria-label": "Search",
      "aria-autocomplete": "list",
      "aria-controls": "hera-hs-menu",
      "aria-expanded": "false",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "search",
    });
    const clear = el("button", { type: "button", class: "hera-hs__clear", hidden: true, tabindex: "-1", "aria-label": "Clear search", onmousedown: (event) => event.preventDefault() }, icon("close"));
    const field = el("div", { class: "hera-hs__field" }, [icon("search"), input, clear]);
    const menu = el("div", { class: "hera-hs__menu", id: "hera-hs-menu", role: "listbox", "aria-label": "Suggestions", hidden: true, "aria-busy": "false" });
    const root = el("div", { class: "hera-hs", "data-hera-hs": "", role: "search", hidden: true }, [field, menu]);
    document.body.append(root);
    hs = {
      root,
      field,
      input,
      clear,
      menu,
      button: null,
      open: false,
      term: "",
      data: null,
      rows: [],
      active: -1,
      seerr: false,
      animation: null,
      runner: createRunner(headerHooks),
    };
    input.addEventListener("input", onHeaderInput);
    input.addEventListener("keydown", onHeaderKeydown);
    clear.addEventListener("click", () => {
      input.value = "";
      onHeaderInput();
      input.focus();
    });
    root.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (hs.open && next && !root.contains(next) && next !== hs.button) closeHeader({ restore: false });
    });
    kit.integrations().then((ints) => {
      if (hs) hs.seerr = Boolean(ints.seerr);
    });
  };

  const onAway = (event) => {
    if (!hs?.open) return;
    if (hs.root.contains(event.target) || hs.button?.contains(event.target)) return;
    closeHeader({ restore: false });
  };
  const onResize = () => {
    if (hs?.open) placeHeader();
  };
  let toneFrame = 0;
  const onScroll = () => {
    if (!hs?.open || toneFrame) return;
    toneFrame = requestAnimationFrame(() => {
      toneFrame = 0;
      toneHeader();
    });
  };

  const openHeader = (button) => {
    if (!hs) buildHeader();
    if (hs.open) return;
    hs.button = button;
    hs.open = true;
    placeHeader();
    toneHeader();
    document.documentElement.classList.add("hera-search-open");
    button.setAttribute("aria-expanded", "true");
    hs.root.hidden = false;
    hs.input.value = "";
    hs.term = "";
    hs.clear.hidden = true;
    paintMenu();
    // The field grows out of the button: a button-sized window at the button, widening to the field.
    hs.animation?.cancel();
    if (!kit.reduceMotion.matches) {
      const from = button.getBoundingClientRect();
      const to = hs.field.getBoundingClientRect();
      hs.animation = hs.field.animate(
        [
          { transform: `translateX(${from.right - to.right}px)`, clipPath: `inset(0 0 0 calc(100% - ${from.width}px) round 999px)` },
          { transform: "translateX(0)", clipPath: "inset(0 0 0 0 round 999px)" },
        ],
        { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    hs.input.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onAway, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
  };

  const closeHeader = ({ restore = true } = {}) => {
    if (!hs?.open) return;
    hs.open = false;
    hs.runner.cancel();
    hs.data = null;
    document.removeEventListener("pointerdown", onAway, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("scroll", onScroll);
    document.documentElement.classList.remove("hera-search-open");
    hs.button?.setAttribute("aria-expanded", "false");
    const finish = () => {
      if (!hs || hs.open) return;
      hs.root.hidden = true;
      hs.menu.replaceChildren();
      hs.menu.hidden = true;
      hs.rows = [];
    };
    hs.menu.hidden = true;
    hs.animation?.cancel();
    if (kit.reduceMotion.matches) finish();
    else {
      const to = hs.field.getBoundingClientRect();
      const from = hs.button.getBoundingClientRect();
      hs.animation = hs.field.animate(
        [
          { transform: "translateX(0)", clipPath: "inset(0 0 0 0 round 999px)" },
          { transform: `translateX(${from.right - to.right}px)`, clipPath: `inset(0 0 0 calc(100% - ${from.width}px) round 999px)` },
        ],
        { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
      );
      // A timer, not onfinish: a throttled background tab never finishes its animations.
      setTimeout(() => {
        if (hs && !hs.open) {
          hs.animation?.cancel();
          finish();
        }
      }, 210);
    }
    if (restore) hs.button?.focus({ preventScroll: true });
  };

  // Capture phase, so Jellyfin's own link never navigates. Where there is no capsule to replace
  // (phone widths, where Jellyfin keeps its own layout) or on a TV, the button behaves as before.
  const onHeaderClick = (event) => {
    const link = event.target.closest?.(BUTTON);
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (!kit.userId() || kit.isTv()) return;
    if (window.location.hash.startsWith("#/search")) {
      // Already on the search page: the button takes you to its field.
      if (!ui) return;
      event.preventDefault();
      event.stopPropagation();
      ui.input.focus({ preventScroll: true });
      ui.input.select();
      return;
    }
    if (document.documentElement.classList.contains("layout-mobile")) return;
    event.preventDefault();
    event.stopPropagation();
    if (hs?.open) closeHeader();
    else openHeader(link);
  };
  document.addEventListener("click", onHeaderClick, true);

  const onHash = () => closeHeader({ restore: false });
  window.addEventListener("hashchange", onHash);

  HT.register({
    name: "search",
    async onView(page, { params }) {
      if (!kit.userId()) return;
      if (page.id === "searchPage") {
        closeHeader({ restore: false });
        await mount(page, params);
      } else unmount();
    },
    teardown() {
      closeHeader({ restore: false });
      hs?.root.remove();
      hs = null;
      unmount();
      document.removeEventListener("click", onHeaderClick, true);
      window.removeEventListener("hashchange", onHash);
      document.documentElement.classList.remove("hera-search-open");
    },
  });
})();
