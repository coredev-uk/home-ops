/*
 * Hera TV: search. Registers with window.HeraTV (hera-tv.js).
 * Replaces the body of Jellyfin's search page (#/search) with the Apple TV app's search:
 *  - one glass field, results as you type (debounced; superseded requests are cancelled);
 *  - before typing: recent searches, what was added lately, and what is trending on Seerr;
 *  - results from the Jellyfin API per kind (Top Results, Films, TV Shows, Episodes, People,
 *    Collections) plus Seerr titles that are not in the library yet, with category chips;
 *  - a remote-friendly on-screen keyboard in the TV layout.
 * Jellyfin's own page and route stay, so the header's search button and back navigation work;
 * its markup is only hidden (hera-search.css).
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const MIN_LENGTH = 2;
  const DEBOUNCE = 260;
  const LIBRARY_TTL = 60 * 1000;
  const SEERR_TTL = 20 * 1000;
  const SHELF_LIMIT = 20;
  const TOP_LIMIT = 12;
  const RECENT_LIMIT = 8;

  // Library categories, in the order their shelves appear. `path` is the API route; `types` the
  // item types it asks for; `limit` how many the server may return.
  const CATEGORIES = [
    { id: "film", label: "Films", types: "Movie", shape: "poster", limit: 60 },
    { id: "show", label: "TV Shows", types: "Series", shape: "poster", limit: 60 },
    { id: "episode", label: "Episodes", types: "Episode", shape: "wide", limit: 40 },
    { id: "person", label: "People", path: "Persons", shape: "person", limit: 40 },
    { id: "collection", label: "Collections", types: "BoxSet", shape: "poster", limit: 30 },
  ];
  const REQUEST_CATEGORY = { id: "request", label: "Not in Your Library", shape: "poster" };
  const ALL = { id: "all", label: "All" };
  const KIND = { Movie: "Film", Series: "TV Show", BoxSet: "Collection", Person: "Person" };
  const KEYS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

  /** Everything the mounted page owns; null while no search page shows. */
  let ui = null;

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

  // Each kind comes back in Jellyfin's order; a stable sort by how the name matches puts what was
  // typed first (Array.sort is stable, so ties keep the server's order).
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

  // ---------- ranking -------------------------------------------------------------------
  // Jellyfin returns each kind in its own order. Top Results mixes kinds, so rank by how the name
  // matches: exact, then starts with, then a word starts with, then contains.

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

  // ---------- cards ---------------------------------------------------------------------

  const art = (item, type, width) =>
    item.ImageTags?.[type] ? kit.imageUrl(item.Id, type, { maxWidth: width, tag: item.ImageTags[type] }) : null;

  const episodeArt = (item) => {
    if (item.ImageTags?.Primary) return art(item, "Primary", 640);
    if (item.ParentThumbItemId && item.ParentThumbImageTag) {
      return kit.imageUrl(item.ParentThumbItemId, "Thumb", { maxWidth: 640, tag: item.ParentThumbImageTag });
    }
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
      return kit.imageUrl(item.ParentBackdropItemId, "Backdrop", { maxWidth: 640, tag: item.ParentBackdropImageTags[0] });
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

  // Seerr titles share a data-hera-key with Discover's cards, so a request made from the sheet
  // updates the badge here too.
  const seerrCard = (item) => {
    const kind = item.mediaType === "tv" ? "TV Show" : "Film";
    const available = (item.status ?? "none") === "available";
    const card = kit.card({
      href: item.jellyfinId ? `#/details?id=${item.jellyfinId}` : null,
      onClick: item.jellyfinId ? null : (event) => HT.discover?.openTitle?.(item, { opener: event.currentTarget }),
      image: item.poster,
      title: item.title,
      subtitle: [item.year, kind].filter(Boolean).join(" · "),
      badge: seerrBadge(item),
      badgeTone: available ? "light" : undefined,
    });
    card.dataset.heraKey = `${item.mediaType}:${item.tmdbId}`;
    card.heraItem = item;
    return card;
  };

  const SHELF_SHAPES = { poster: "poster", wide: "wide", person: "person" };

  const shelfOf = (title, cards, shape, onAll) => {
    const row = kit.shelf({ title, cards, shape: SHELF_SHAPES[shape] ?? "poster" });
    row.classList.add("hera-search__row");
    if (onAll) {
      row.querySelector(".hera-row__head").append(
        el("button", { type: "button", class: "hera-search__all", "aria-label": `See all ${title}`, onclick: onAll }, [
          "See All",
          icon("chevron_right"),
        ]),
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
    if (text.length < MIN_LENGTH) return;
    writeRecent([text, ...readRecent().filter((entry) => entry.toLowerCase() !== text.toLowerCase())]);
  };

  // ---------- page ----------------------------------------------------------------------

  const clearTimer = () => {
    clearTimeout(ui.timer);
    ui.timer = 0;
  };

  const abortSearch = () => {
    ui.controller?.abort();
    ui.controller = null;
  };

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

  const visible = (node) => node.getClientRects().length > 0;

  // -- idle: recent searches and suggestions

  const renderRecent = () => {
    const list = readRecent();
    ui.recent.replaceChildren();
    ui.recent.hidden = list.length === 0;
    if (!list.length) return;
    const rows = list.map((text) =>
      el("li", { class: "hera-search__recent-item" }, [
        el("button", { type: "button", class: "hera-search__recent-text", onclick: () => submit(text) }, [icon("history"), el("span", { text })]),
        el("button", {
          type: "button",
          class: "hera-search__recent-remove",
          "aria-label": `Remove ${text} from recent searches`,
          onclick: () => {
            writeRecent(readRecent().filter((entry) => entry !== text));
            renderRecent();
          },
        }, icon("close")),
      ]),
    );
    ui.recent.append(
      el("div", { class: "hera-search__recent-head" }, [
        el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title", text: "Recent Searches" }),
        el("button", {
          type: "button",
          class: "hera-search__link",
          onclick: () => {
            writeRecent([]);
            renderRecent();
          },
        }, "Clear"),
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
          request("Items", {
            userId: kit.userId(),
            sortBy: "DateCreated",
            sortOrder: "Descending",
            includeItemTypes: "Movie,Series",
            recursive: true,
            limit: 24,
            fields: ITEM_FIELDS,
            imageTypeLimit: 1,
            enableTotalRecordCount: false,
          }, signal).then((data) => (data?.Items ?? []).map((item) => libraryCard(item, { mixed: true }))),
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
    clearTimer();
    abortSearch();
    ui.seq++;
    ui.active = "";
    ui.data = null;
    ui.term = "";
    showResults(false);
    renderRecent();
    syncUrl();
  };

  // Runs a search for `term` now. A term already on screen or already in flight is not asked again.
  const run = (term) => {
    if (term === ui.active) return;
    abortSearch();
    const mine = ++ui.seq;
    ui.active = term;
    ui.term = term;
    const controller = new AbortController();
    ui.controller = controller;
    const { signal } = controller;
    const stale = () => mine !== ui.seq || !ui.root.isConnected;

    showResults(true);
    syncUrl();

    const libHit = remember(timed, `lib:${term.toLowerCase()}`, LIBRARY_TTL);
    const seerrHit = ui.seerr ? remember(timed, `seerr:${term.toLowerCase()}`, SEERR_TTL) : null;
    const data = { term, lib: libHit, seerr: ui.seerr ? seerrHit ?? "loading" : "off" };

    const arrive = () => {
      ui.data = data;
      ui.results.setAttribute("aria-busy", "false");
      renderLibrary();
      renderSeerr();
    };

    if (data.lib) arrive();
    else {
      ui.results.setAttribute("aria-busy", "true");
      if (!ui.libSlot.firstChild) ui.libSlot.append(el("p", { class: "hera-search__busy", role: "status", text: "Searching…" }));
      fetchLibrary(term, signal)
        .then((lib) => {
          if (stale()) return;
          data.lib = lib;
          timed.set(`lib:${term.toLowerCase()}`, { at: Date.now(), value: lib });
          arrive();
        })
        .catch((error) => {
          if (stale() || error?.name === "AbortError") return;
          console.error("[Hera TV:search]", error);
          ui.results.setAttribute("aria-busy", "false");
          ui.chips.hidden = true;
          ui.seerrSlot.replaceChildren();
          ui.libSlot.replaceChildren(emptyState("Search isn't available right now", "Try again in a moment.", () => {
            ui.active = "";
            run(term);
          }));
        });
    }

    if (data.seerr === "loading") {
      fetchSeerr(term, signal)
        .then((items) => {
          if (stale()) return;
          data.seerr = items;
          timed.set(`seerr:${term.toLowerCase()}`, { at: Date.now(), value: items });
          if (ui.data !== data) return;
          const counts = sectionCounts(data);
          // With no library hits this decides between "no results" and results, so redraw it all.
          if (!(counts.film + counts.show + counts.episode + counts.person + counts.collection)) renderLibrary();
          else renderChips(counts);
          renderSeerr();
        })
        .catch((error) => {
          if (stale() || error?.name === "AbortError") return;
          // Requesting is an extra here; a Seerr failure leaves the library's results alone.
          data.seerr = [];
          if (ui.data === data) renderLibrary();
        });
    }
  };

  // Typing: wait a beat, then search. Enter and recent searches go straight away.
  const onInput = () => {
    const text = ui.input.value.trim();
    ui.clear.hidden = !ui.input.value;
    clearTimer();
    if (text.length < MIN_LENGTH) {
      showIdle();
      return;
    }
    ui.timer = setTimeout(() => {
      ui.timer = 0;
      run(text);
    }, DEBOUNCE);
  };

  const submit = (text) => {
    ui.input.value = text;
    ui.clear.hidden = !text;
    clearTimer();
    const term = text.trim();
    if (term.length < MIN_LENGTH) {
      showIdle();
      return;
    }
    run(term);
    ui.input.focus({ preventScroll: true });
  };

  // ---------- keyboard ------------------------------------------------------------------

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
      submit(ui.input.value);
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
    const value = text === "\b" ? ui.input.value.slice(0, -1) : ui.input.value + text;
    ui.input.value = value;
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

  // ---------- mount ---------------------------------------------------------------------

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
      el("div", { class: "hera-search__bar", role: "search" }, [
        el("div", { class: "hera-search__field" }, [icon("search"), input, clear]),
      ]),
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
    clearTimer();
    abortSearch();
    ui.idleController.abort();
    ui.leave?.();
    ui.page.classList.remove("hera-search-page");
    ui.root.remove();
    ui = null;
  };

  const queryOf = (params) => (params.get("q") || params.get("query") || "").trim();
  const filterOf = (params) => {
    const id = params.get("in");
    return [...CATEGORIES, REQUEST_CATEGORY].some((category) => category.id === id) ? id : "all";
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
      timer: 0,
      seq: 0,
      active: "",
      term: "",
      filter: "all",
      data: null,
      controller: null,
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
    // Router pushes and Back do not fire hashchange; the header's search button and the history
    // buttons are the two ways the address changes under a search page that is already showing.
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
    if (start.length >= MIN_LENGTH) {
      ui.input.value = start;
      ui.clear.hidden = false;
      run(start);
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

  HT.register({
    name: "search",
    async onView(page, { params }) {
      if (!kit.userId()) return;
      if (page.id === "searchPage") await mount(page, params);
      else unmount();
    },
    teardown() {
      unmount();
    },
  });
})();
