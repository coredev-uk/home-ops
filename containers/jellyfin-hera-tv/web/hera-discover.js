/*
 * Hera TV: discover module. Registers with window.HeraTV (hera-tv.js).
 *  - A Discover tab beside Home: Seerr's trending, popular and upcoming titles, with search.
 *  - A title sheet: backdrop, details, cast, trailer, and Request (films) or a season checklist (TV).
 *  - A Discover row on Jellyfin's search page, and "Request seasons" beside a series' Episodes.
 * Requests are made by the plugin as the viewer's own Seerr account; a viewer who isn't linked
 * can browse but is pointed at Seerr instead.
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const root = document.documentElement;
  const cleanups = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  const DISCOVER_HASH = "#/home?hera=discover";

  // ---------- data ----------------------------------------------------------------------

  const keyOf = (item) => `${item.mediaType}:${item.tmdbId}`;

  // Statuses changed by a request made here; they win over a list fetched before it.
  const overrides = new Map();
  const statusOf = (item) => overrides.get(keyOf(item)) ?? item.status ?? "none";

  const LISTS = [
    { id: "trending", name: "trending", title: "Trending" },
    { id: "films", name: "movies", title: "Popular Films" },
    { id: "tv", name: "tv", title: "Popular TV Programmes" },
    { id: "upcoming-films", name: "upcoming-movies", title: "Upcoming Films", dates: true },
    { id: "upcoming-tv", name: "upcoming-tv", title: "Upcoming TV", dates: true },
  ];

  const cache = new Map();
  const cached = (key, load, ttl = 3 * 60 * 1000) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = Promise.resolve(load()).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { at: Date.now(), promise });
    return promise;
  };

  const fetchList = (name, page = 1) =>
    cached(`list:${name}:${page}`, () => kit.hera(`discover/lists/${name}`, { query: { page } }));
  const fetchTitle = (mediaType, tmdbId) =>
    cached(`title:${mediaType}:${tmdbId}`, () => kit.hera(`discover/titles/${mediaType}/${tmdbId}`), 60 * 1000);
  const searchTitles = (query, page = 1) => kit.hera("discover/search", { query: { query, page } });

  const errorStatus = (error) => error?.status ?? error?.response?.status ?? null;
  const errorMessage = async (error) => {
    try {
      const body = await (error?.json ? error.json() : null);
      return body?.message || null;
    } catch {
      return null;
    }
  };

  // ---------- cards ---------------------------------------------------------------------

  const BADGES = { partial: "Partly Available", processing: "Processing", pending: "Requested" };
  const badgeOf = (item) => {
    const status = statusOf(item);
    if (status === "available") return item.jellyfinId ? "In Library" : "Available";
    return BADGES[status] ?? null;
  };

  const kindOf = (item) => (item.mediaType === "tv" ? "TV Programme" : "Film");

  const itemCard = (item, { dates = false } = {}) => {
    const link = item.jellyfinId ? `#/details?id=${item.jellyfinId}` : null;
    const when = dates && item.releaseDate ? kit.shortDate(item.releaseDate) : item.year;
    const card = kit.card({
      href: link,
      onClick: link ? null : (event) => openTitle(item, { opener: event.currentTarget }),
      image: item.poster,
      title: item.title,
      subtitle: [when, kindOf(item)].filter(Boolean).join(" · "),
      badge: badgeOf(item),
      badgeTone: statusOf(item) === "available" ? "light" : undefined,
    });
    card.dataset.heraKey = keyOf(item);
    card.heraItem = item;
    return card;
  };

  // A request changes a title's status everywhere it is on screen.
  const refreshCards = (key) => {
    for (const card of document.querySelectorAll(`[data-hera-key="${CSS.escape(key)}"]`)) {
      const art = card.querySelector(".hera-card__art");
      if (!art || !card.heraItem) continue;
      art.querySelector(".hera-card__badge")?.remove();
      const text = badgeOf(card.heraItem);
      if (text) {
        art.append(
          el("span", {
            class: `hera-card__badge${statusOf(card.heraItem) === "available" ? " hera-card__badge--light" : ""}`,
            text,
          }),
        );
      }
      card.setAttribute(
        "aria-label",
        [card.heraItem.title, [card.heraItem.year, kindOf(card.heraItem)].filter(Boolean).join(" · ")].join(", "),
      );
    }
  };

  const setStatus = (item, status) => {
    overrides.set(keyOf(item), status);
    refreshCards(keyOf(item));
  };

  // ---------- title sheet ---------------------------------------------------------------

  const STATUS_TEXT = {
    available: "Available",
    partial: "Partly Available",
    processing: "Processing",
    pending: "Requested",
  };
  const STATUS_ICON = { available: "check_circle", partial: "timelapse", processing: "downloading", pending: "schedule" };

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // Jellyfin here says "Series 1" for seasons. Contiguous numbers read as a range: "Series 6–8".
  const seriesText = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    if (contiguous) return sorted.length === 1 ? `Series ${sorted[0]}` : `Series ${sorted[0]}–${sorted.at(-1)}`;
    return `${sorted.length} Series`;
  };
  const seasonName = (season) => {
    const match = /^Season (\d+)$/.exec(season.name || "");
    return match || !season.name ? `Series ${season.seasonNumber}` : season.name;
  };

  const sheetState = { dialog: null, close: null };

  const closeSheet = () => sheetState.close?.();

  /**
   * Opens the sheet for a title. `item` needs `mediaType` and `tmdbId`; any other fields
   * paint at once while the full details load. `options.seasons` preselects TV seasons.
   */
  const openTitle = async (item, options = {}) => {
    if (!item?.mediaType || !item?.tmdbId) return;
    closeSheet();
    const ints = await kit.integrations();
    const isTv = item.mediaType === "tv";

    const ctx = {
      item: { ...item },
      details: null,
      seasons: [],
      selected: new Set(options.seasons ?? []),
      linked: ints.seerr ? ints.seerrLinked !== false : false,
      requestable: Boolean(ints.seerr),
      seerrUrl: ints.seerrUrl,
      busy: false,
      notice: null,
    };

    const opener = options.opener ?? document.activeElement;
    const dialog = el("dialog", { class: "hera-sheet", "aria-label": item.title || "Title details" });
    const scroll = el("div", { class: "hera-sheet__scroll" });
    const head = el("div", { class: "hera-sheet__head" });
    const body = el("div", { class: "hera-sheet__body" });
    const actions = el("div", { class: "hera-sheet__actions" });
    const seasonsBox = el("div", { class: "hera-sheet__seasons" });
    const castBox = el("div", { class: "hera-sheet__cast-wrap" });
    const closeButton = el(
      "button",
      { type: "button", class: "hera-btn hera-btn--glass hera-sheet__close", "aria-label": "Close", onclick: () => close() },
      icon("close"),
    );

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (sheetState.dialog === dialog) {
        sheetState.dialog = null;
        sheetState.close = null;
      }
      if (opener?.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
      options.onClose?.(ctx);
    };
    sheetState.dialog = dialog;
    sheetState.close = close;

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    // A click on the backdrop lands on the dialog itself, outside its box.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    });
    // Escape, and the remote's Back key: webOS 461, Tizen 10009. Jellyfin would otherwise navigate back.
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || event.keyCode === 461 || event.keyCode === 10009 || event.key === "GoBack") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });

    scroll.append(head, body);
    dialog.append(scroll, closeButton);

    // ----- painting

    const info = () => ctx.details?.item ?? ctx.item;

    const paintHead = () => {
      const current = info();
      head.replaceChildren(
        current.backdrop
          ? el("img", { class: "hera-sheet__backdrop", src: current.backdrop, alt: "" })
          : el("div", { class: "hera-sheet__backdrop hera-sheet__backdrop--empty" }),
      );
    };

    const paintBody = () => {
      const current = info();
      const d = ctx.details;
      const meta = [
        current.year ? el("span", { text: current.year }) : null,
        isTv && ctx.seasons.length ? el("span", { text: `${ctx.seasons.length} Series` }) : null,
        d?.runtime ? el("span", { text: kit.runtime(d.runtime * 600000000) }) : null,
        d?.genres?.length ? el("span", { text: d.genres.slice(0, 3).join(", ") }) : null,
        d?.certification ? el("span", { class: "hera-badge", text: d.certification }) : null,
      ].filter(Boolean);
      body.replaceChildren(
        el("h2", { class: "hera-sheet__title", text: current.title || "" }),
        meta.length ? el("p", { class: "hera-sheet__meta" }, meta) : null,
        d?.tagline ? el("p", { class: "hera-sheet__tagline", text: d.tagline }) : null,
        current.overview ? el("p", { class: "hera-sheet__overview", text: current.overview }) : null,
        actions,
        seasonsBox,
        castBox,
      );
      if (!d) body.append(el("p", { class: "hera-sheet__loading", role: "status", text: "Loading…" }));
    };

    const paintCast = () => {
      const cast = (ctx.details?.cast ?? []).slice(0, 14);
      castBox.replaceChildren();
      if (!cast.length) return;
      castBox.append(
        el("h3", { class: "hera-sheet__heading", text: "Cast" }),
        el(
          "ul",
          { class: "hera-sheet__cast" },
          cast.map((person) =>
            el("li", { class: "hera-sheet__person" }, [
              person.photo
                ? el("img", { src: person.photo, alt: "", loading: "lazy", decoding: "async" })
                : el("span", { class: "hera-sheet__person-fallback" }, icon("person")),
              el("span", { class: "hera-sheet__person-name", text: person.name }),
              person.character ? el("span", { class: "hera-sheet__person-role", text: person.character }) : null,
            ]),
          ),
        ),
      );
    };

    const selectable = (season) => season.status === "none";
    const selectableSeasons = () => ctx.seasons.filter(selectable);
    const canPick = () => ctx.requestable && ctx.linked && !ctx.busy;

    const paintSeasons = () => {
      seasonsBox.replaceChildren();
      if (!isTv || !ctx.seasons.length) return;
      const open = selectableSeasons();
      const all = open.length > 0 && open.every((season) => ctx.selected.has(season.seasonNumber));
      const toggle = (season) => {
        if (!selectable(season) || !canPick()) return;
        if (ctx.selected.has(season.seasonNumber)) ctx.selected.delete(season.seasonNumber);
        else ctx.selected.add(season.seasonNumber);
        ctx.notice = null;
        paintSeasons();
        paintActions();
        seasonsBox.querySelector(`[data-season="${season.seasonNumber}"]`)?.focus({ preventScroll: true });
      };
      const row = (season) => {
        const open = selectable(season);
        const checked = ctx.selected.has(season.seasonNumber);
        return el(
          "button",
          {
            type: "button",
            class: "hera-season",
            role: "checkbox",
            "aria-checked": String(checked),
            "data-season": season.seasonNumber,
            disabled: !open || !canPick(),
            onclick: () => toggle(season),
          },
          [
            icon(checked ? "check_box" : "check_box_outline_blank"),
            el("span", { class: "hera-season__name", text: seasonName(season) }),
            el("span", { class: "hera-season__count", text: season.episodeCount ? plural(season.episodeCount, "episode") : "" }),
            el("span", { class: "hera-season__status", text: season.status === "none" ? "" : (STATUS_TEXT[season.status] ?? "") }),
          ],
        );
      };
      seasonsBox.append(
        el("div", { class: "hera-sheet__heading-row" }, [
          el("h3", { class: "hera-sheet__heading", text: "Series" }),
          open.length > 1
            ? el(
                "button",
                {
                  type: "button",
                  class: "hera-season hera-season--all",
                  role: "checkbox",
                  "aria-checked": String(all),
                  disabled: !canPick(),
                  onclick: () => {
                    for (const season of open) {
                      if (all) ctx.selected.delete(season.seasonNumber);
                      else ctx.selected.add(season.seasonNumber);
                    }
                    ctx.notice = null;
                    paintSeasons();
                    paintActions();
                    seasonsBox.querySelector(".hera-season--all")?.focus({ preventScroll: true });
                  },
                },
                [icon(all ? "check_box" : "check_box_outline_blank"), el("span", { class: "hera-season__name", text: "All" })],
              )
            : null,
        ]),
        el("div", { class: "hera-season-list", role: "group", "aria-label": "Series" }, ctx.seasons.map(row)),
      );
    };

    const pill = (status) =>
      el("span", { class: "hera-sheet__status" }, [icon(STATUS_ICON[status] ?? "check_circle"), STATUS_TEXT[status] ?? status]);

    const unlinkedNote = () =>
      el("div", { class: "hera-sheet__note", role: "note" }, [
        el("p", {
          text: "Your Jellyfin account isn't linked to Seerr, so you can't request from here. Sign in to Seerr with your Jellyfin account once, then come back.",
        }),
        ctx.seerrUrl
          ? el(
              "a",
              { class: "hera-btn hera-btn--glass hera-btn--text", href: ctx.seerrUrl, target: "_blank", rel: "noopener noreferrer" },
              [icon("open_in_new"), "Open Seerr"],
            )
          : null,
      ]);

    const paintActions = () => {
      const current = info();
      const status = statusOf(current);
      const buttons = [];
      const extras = [];

      if (ctx.details) {
        if (current.jellyfinId) {
          buttons.push(
            el(
              "a",
              { class: "hera-btn hera-btn--primary", href: `#/details?id=${current.jellyfinId}`, onclick: () => close() },
              [icon("play_arrow"), "View in Library"],
            ),
          );
        }

        if (ctx.requestable) {
          if (isTv) {
            const pickedNumbers = selectableSeasons().filter((season) => ctx.selected.has(season.seasonNumber)).map((season) => season.seasonNumber);
            const picked = pickedNumbers.length;
            if (selectableSeasons().length && ctx.linked) {
              buttons.push(
                el(
                  "button",
                  {
                    type: "button",
                    class: `hera-btn ${current.jellyfinId ? "hera-btn--glass hera-btn--text" : "hera-btn--primary"} hera-sheet__request`,
                    disabled: ctx.busy || !picked,
                    "aria-busy": ctx.busy ? "true" : null,
                    onclick: () => submit(),
                  },
                  [icon(ctx.busy ? "hourglass_top" : "add"), ctx.busy ? "Requesting…" : picked ? `Request ${seriesText(pickedNumbers)}` : "Request"],
                ),
              );
            } else if (selectableSeasons().length && !ctx.linked) {
              extras.push(unlinkedNote());
            } else if (!current.jellyfinId && status !== "none") {
              buttons.push(pill(status));
            }
          } else if (status === "none") {
            if (ctx.linked) {
              buttons.push(
                el(
                  "button",
                  {
                    type: "button",
                    class: "hera-btn hera-btn--primary hera-sheet__request",
                    disabled: ctx.busy,
                    "aria-busy": ctx.busy ? "true" : null,
                    onclick: () => submit(),
                  },
                  [icon(ctx.busy ? "hourglass_top" : "add"), ctx.busy ? "Requesting…" : "Request"],
                ),
              );
            } else {
              extras.push(unlinkedNote());
            }
          } else if (!current.jellyfinId) {
            buttons.push(pill(status));
          }
        }

        if (ctx.details.trailer) {
          buttons.push(
            el(
              "a",
              { class: "hera-btn hera-btn--glass hera-btn--text", href: ctx.details.trailer, target: "_blank", rel: "noopener noreferrer" },
              [icon("smart_display"), "Trailer"],
            ),
          );
        }
      }

      if (ctx.notice) {
        extras.unshift(
          el("p", { class: `hera-sheet__result hera-sheet__result--${ctx.notice.tone}`, role: ctx.notice.tone === "error" ? "alert" : "status" }, [
            icon(ctx.notice.tone === "error" ? "error_outline" : "check_circle"),
            ctx.notice.text,
          ]),
        );
      }
      actions.replaceChildren(el("div", { class: "hera-sheet__buttons" }, buttons), ...extras);
    };

    // Repainting replaces the focused control; keep focus inside the sheet.
    const keepFocus = () => {
      if (dialog.contains(document.activeElement) && document.activeElement !== dialog) return;
      (dialog.querySelector(".hera-sheet__buttons .hera-btn:not([disabled]), .hera-season:not([disabled])") ?? closeButton).focus({
        preventScroll: true,
      });
    };

    // ----- requesting

    const submit = async () => {
      if (ctx.busy) return;
      const current = info();
      const body = { mediaType: item.mediaType, tmdbId: item.tmdbId };
      let picked = [];
      if (isTv) {
        picked = selectableSeasons()
          .filter((season) => ctx.selected.has(season.seasonNumber))
          .map((season) => season.seasonNumber)
          .sort((a, b) => a - b);
        if (!picked.length) return;
        body.seasons = picked;
      }
      ctx.busy = true;
      ctx.notice = null;
      paintSeasons();
      paintActions();
      try {
        const result = await kit.hera("discover/requests", { method: "POST", body });
        const state = result?.requestStatus;
        if (state === "declined" || state === "failed") {
          ctx.notice = { tone: "error", text: state === "declined" ? "This request was declined." : "Seerr couldn't send that request. Try again later." };
        } else {
          const next = state === "available" ? "available" : state === "approved" ? "processing" : "pending";
          if (isTv) {
            for (const season of ctx.seasons) if (picked.includes(season.seasonNumber)) season.status = next;
            ctx.selected.clear();
            const states = ctx.seasons.map((season) => season.status);
            const some = (...values) => states.some((value) => values.includes(value));
            const overall = states.every((value) => value === "none")
              ? "none"
              : some("available", "partial") && !states.every((value) => value === "available")
                ? "partial"
                : states.every((value) => value === "available")
                  ? "available"
                  : some("processing")
                    ? "processing"
                    : "pending";
            setStatus(current, overall);
            ctx.notice = { tone: "ok", text: state === "available" ? "Already available." : `Requested ${seriesText(picked)}.` };
          } else {
            setStatus(current, next);
            ctx.notice = { tone: "ok", text: state === "available" ? "Already available." : "Requested." };
          }
          cache.delete(`title:${item.mediaType}:${item.tmdbId}`);
          refresh(picked, next).catch(() => {});
        }
      } catch (error) {
        if (errorStatus(error) === 403) {
          ctx.linked = false;
        } else {
          ctx.notice = {
            tone: "error",
            text: (await errorMessage(error)) || "Couldn't send the request. Try again in a moment.",
          };
        }
      }
      ctx.busy = false;
      paintSeasons();
      paintActions();
      keepFocus();
    };

    // After a request, Seerr's own view of the title is the truth; keep what we set where it hasn't caught up.
    const refresh = async (picked, optimistic) => {
      const fresh = await fetchTitle(item.mediaType, item.tmdbId);
      if (closed || !fresh) return;
      ctx.details = { ...ctx.details, ...fresh };
      if (isTv) {
        ctx.seasons = (fresh.seasons ?? [])
          .filter((season) => season.seasonNumber > 0)
          .map((season) => (picked.includes(season.seasonNumber) && season.status === "none" ? { ...season, status: optimistic } : season));
      }
      if (fresh.item && fresh.item.status !== "none") setStatus(fresh.item, fresh.item.status);
      paintSeasons();
      paintActions();
      keepFocus();
    };

    // ----- open

    paintHead();
    paintBody();
    paintActions();
    document.body.append(dialog);
    dialog.showModal();
    closeButton.blur();
    (dialog.querySelector(".hera-sheet__request, .hera-btn--primary") ?? closeButton).focus({ preventScroll: true });

    try {
      const details = await fetchTitle(item.mediaType, item.tmdbId);
      if (closed) return;
      ctx.details = details;
      ctx.item = { ...ctx.item, ...details.item };
      if (isTv) {
        ctx.seasons = (details.seasons ?? []).filter((season) => season.seasonNumber > 0);
        if (options.seasons) {
          ctx.selected = new Set(options.seasons.filter((n) => ctx.seasons.some((s) => s.seasonNumber === n && selectable(s))));
        }
      }
      paintHead();
      paintBody();
      paintSeasons();
      paintCast();
      paintActions();
      const focus = dialog.querySelector(".hera-sheet__buttons .hera-btn:not([disabled]), .hera-season:not([disabled])");
      if (focus && (!dialog.contains(document.activeElement) || document.activeElement === closeButton)) focus.focus({ preventScroll: true });
    } catch {
      if (closed) return;
      body.querySelector(".hera-sheet__loading")?.remove();
      body.append(el("p", { class: "hera-sheet__result hera-sheet__result--error", role: "alert", text: "Couldn't load this title. Try again in a moment." }));
    }
  };

  // ---------- discover view -------------------------------------------------------------

  const view = { root: null, abort: null };

  const primaryButton = (item, { onNavigate } = {}) => {
    const status = statusOf(item);
    if (item.jellyfinId) {
      return el("a", { class: "hera-btn hera-btn--primary", href: `#/details?id=${item.jellyfinId}`, onclick: onNavigate }, [
        icon("play_arrow"),
        "In Library",
      ]);
    }
    const label = status === "none" ? "Request" : (STATUS_TEXT[status] ?? "Request");
    return el(
      "button",
      { type: "button", class: "hera-btn hera-btn--primary", onclick: (event) => openTitle(item, { opener: event.currentTarget }) },
      [icon(status === "none" ? "add" : (STATUS_ICON[status] ?? "check_circle")), label],
    );
  };

  const buildFeature = (item) => {
    const meta = [kindOf(item), item.year, item.rating ? `${item.rating.toFixed(1)} rating` : null].filter(Boolean);
    const box = el("section", { class: "hera-discover__feature", "aria-label": item.title }, [
      el("img", { class: "hera-discover__feature-art", src: item.backdrop, alt: "" }),
      el("div", { class: "hera-discover__feature-body" }, [
        el("h2", { class: "hera-discover__feature-title", text: item.title }),
        el("p", { class: "hera-hero__meta" }, meta.map((text) => el("span", { text }))),
        item.overview ? el("p", { class: "hera-discover__feature-overview", text: item.overview }) : null,
        el("div", { class: "hera-hero__actions" }, [
          primaryButton(item),
          el(
            "button",
            { type: "button", class: "hera-btn hera-btn--glass hera-btn--text", onclick: (event) => openTitle(item, { opener: event.currentTarget }) },
            [icon("info_outline"), "More Info"],
          ),
        ]),
      ]),
    ]);
    return box;
  };

  const MAX_PAGES = 5;

  const buildRow = (def, first) => {
    const row = kit.shelf({
      id: `discover-${def.id}`,
      title: def.title,
      cards: first.results.map((item) => itemCard(item, { dates: def.dates })),
    });
    const track = row.querySelector(".hera-shelf");
    let page = first.page ?? 1;
    const total = Math.min(first.totalPages ?? 1, MAX_PAGES);
    const seen = new Set(first.results.map(keyOf));
    let loading = false;
    const more = async () => {
      if (loading || page >= total) return;
      if (track.scrollLeft + track.clientWidth < track.scrollWidth - 700) return;
      loading = true;
      try {
        const next = await fetchList(def.name, page + 1);
        page = next.page ?? page + 1;
        const fresh = (next.results ?? []).filter((item) => !seen.has(keyOf(item)));
        fresh.forEach((item) => seen.add(keyOf(item)));
        track.append(...fresh.map((item) => itemCard(item, { dates: def.dates })));
        track.dispatchEvent(new Event("scroll"));
      } catch {
        page = total;
      }
      loading = false;
    };
    track.addEventListener("scroll", more, { passive: true });
    return row;
  };

  const SEARCH_MIN = 2;

  const buildView = (signal) => {
    const input = el("input", {
      class: "hera-discover__input",
      type: "search",
      placeholder: "Search films and TV programmes",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Search films and TV programmes",
      enterkeyhint: "search",
    });
    const clear = el("button", { type: "button", class: "hera-discover__clear", hidden: true, "aria-label": "Clear search" }, icon("close"));
    const search = el("div", { class: "hera-discover__search", role: "search" }, [
      el("div", { class: "hera-discover__field" }, [icon("search"), input, clear]),
    ]);
    const featureSlot = el("div", { class: "hera-discover__feature-slot" });
    const rows = el("div", { class: "hera-discover__rows" });
    const results = el("div", { class: "hera-discover__results", hidden: true });
    const rootEl = el("div", { class: "hera-discover", "data-hera-discover": "" }, [search, featureSlot, rows, results]);

    // Rows in a fixed order, each arriving as soon as its list does.
    const slots = LISTS.map((def) => {
      const slot = el("div", { class: "hera-discover__slot" });
      rows.append(slot);
      return slot;
    });
    let settled = 0;
    LISTS.forEach((def, index) => {
      fetchList(def.name)
        .then((data) => {
          if (signal.aborted || !data?.results?.length) return;
          slots[index].replaceChildren(buildRow(def, data));
          if (def.name === "trending" && !featureSlot.firstChild) {
            // A feature worth discovering: one the library doesn't already have.
            const lead = data.results.find((item) => item.backdrop && !item.jellyfinId) ?? data.results.find((item) => item.backdrop);
            if (lead) featureSlot.replaceChildren(buildFeature(lead));
          }
        })
        .catch((error) => {
          if (signal.aborted || def.name !== "trending") return;
          console.error("[Hera TV:discover]", error);
          slots[index].replaceChildren(
            el("p", { class: "hera-discover__empty", role: "alert", text: "Discover isn't available right now. Try again in a moment." }),
          );
        })
        .finally(() => {
          // The feature leads; if Trending never arrives, the first card of whatever did will do.
          settled++;
          if (def.name === "trending" || settled === LISTS.length) land();
        });
    });

    // On a TV the remote moves focus; the search field would raise the on-screen keyboard.
    // Land on the feature's button (or the first card) once, and keep focus out of the field.
    let landed = false;
    const land = (force = false) => {
      if (!kit.isTv() || signal.aborted || sheetState.dialog) return;
      const active = document.activeElement;
      if (landed && !(force && active === input)) return;
      if (!force && active && rootEl.contains(active) && active !== input) {
        landed = true;
        return;
      }
      const target = rootEl.querySelector(".hera-discover__feature .hera-btn--primary") ?? rootEl.querySelector(".hera-card");
      if (!target) return;
      if (active === input) input.blur();
      target.focus({ preventScroll: true });
      landed = true;
    };
    land.again = () => setTimeout(() => land(true), 450);

    // Search
    let timer = 0;
    let seq = 0;
    const showResults = (on) => {
      results.hidden = !on;
      featureSlot.hidden = on;
      rows.hidden = on;
    };
    const run = async (text, page = 1, append = null) => {
      const mine = ++seq;
      try {
        const data = await searchTitles(text, page);
        if (signal.aborted || mine !== seq) return;
        const found = data?.results ?? [];
        if (append) {
          append.grid.append(...found.map((item) => itemCard(item)));
          append.more.hidden = (data.page ?? page) >= Math.min(data.totalPages ?? 1, MAX_PAGES);
          append.more.dataset.page = String(data.page ?? page);
          return;
        }
        if (!found.length) {
          results.replaceChildren(el("p", { class: "hera-discover__empty", role: "status", text: `No results for “${text}”.` }));
          return;
        }
        const grid = el("div", { class: "hera-discover__grid" }, found.map((item) => itemCard(item)));
        const moreButton = el(
          "button",
          {
            type: "button",
            class: "hera-btn hera-btn--glass hera-btn--text hera-discover__more",
            hidden: (data.page ?? 1) >= Math.min(data.totalPages ?? 1, MAX_PAGES),
            "data-page": String(data.page ?? 1),
            onclick: () => run(text, Number(moreButton.dataset.page) + 1, { grid, more: moreButton }),
          },
          "Show More",
        );
        results.replaceChildren(
          el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title hera-discover__results-title", text: "Results" }),
          grid,
          moreButton,
        );
      } catch (error) {
        if (signal.aborted || mine !== seq) return;
        console.error("[Hera TV:discover]", error);
        results.replaceChildren(el("p", { class: "hera-discover__empty", role: "alert", text: "Search isn't available right now. Try again in a moment." }));
      }
    };
    const onInput = () => {
      const text = input.value.trim();
      clear.hidden = !input.value;
      clearTimeout(timer);
      if (text.length < SEARCH_MIN) {
        seq++;
        showResults(false);
        return;
      }
      showResults(true);
      timer = setTimeout(() => run(text), 320);
    };
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && input.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        onInput();
      }
    });
    clear.addEventListener("click", () => {
      input.value = "";
      onInput();
      input.focus();
    });
    signal.addEventListener("abort", () => clearTimeout(timer));
    land.again();
    return rootEl;
  };

  const mountView = (page) => {
    if (view.root?.isConnected) return;
    const host = page.querySelector("#homeTab");
    if (!host) return;
    unmountView();
    view.abort = new AbortController();
    view.root = buildView(view.abort.signal);
    host.append(view.root);
    root.classList.add("hera-discover-on");
    window.scrollTo(0, 0);
  };

  const unmountView = () => {
    view.abort?.abort();
    view.abort = null;
    view.root?.remove();
    view.root = null;
    root.classList.remove("hera-discover-on");
  };

  // ---------- tab and routing -----------------------------------------------------------

  const wantsDiscover = () => {
    const [path, query = ""] = window.location.hash.split("?");
    return path.startsWith("#/home") && new URLSearchParams(query).get("hera") === "discover";
  };

  const currentPage = () => document.querySelector(".page:not(.hide)");

  // `page` is the page that is, or is about to be, showing.
  const sync = (page = currentPage()) => {
    if (wantsDiscover() && page?.id === "indexPage" && kit.userId()) {
      kit.integrations().then((ints) => {
        if (ints.seerr && wantsDiscover()) mountView(page);
        updateTabs();
      });
    } else {
      unmountView();
      updateTabs();
    }
  };

  const STACK = ".MuiAppBar-root > .MuiToolbar-root:first-child > .MuiStack-root";
  let seerrOn = false;
  let desktopTab = null;
  let tvTab = null;

  const tabsFor = () => {
    const onHome = currentPage()?.id === "indexPage";
    const stack = document.querySelector(STACK);
    const slider = onHome ? document.querySelector(".headerTabs .emby-tabs-slider") : null;
    return { stack, slider };
  };

  const updateTabs = () => {
    const active = Boolean(view.root);
    const { stack, slider } = tabsFor();

    if (stack && seerrOn) {
      desktopTab ??= el("a", { class: "hera-discover-tab", href: DISCOVER_HASH, tabindex: "0", text: "Discover" });
      if (stack.lastElementChild !== desktopTab) stack.append(desktopTab);
      if (active) desktopTab.setAttribute("aria-current", "page");
      else desktopTab.removeAttribute("aria-current");
    } else if (desktopTab?.isConnected) {
      desktopTab.remove();
    }

    if (slider && seerrOn) {
      if (!tvTab) {
        tvTab = el("button", { type: "button", class: "emby-tab-button emby-button show-focus hera-discover-tab", "data-hera-tab": "discover" }, [
          el("div", { class: "emby-button-foreground", text: "Discover" }),
        ]);
      }
      if (slider.lastElementChild !== tvTab) slider.append(tvTab);
      tvTab.classList.toggle("emby-tab-button-active", active);
    } else if (tvTab?.isConnected) {
      tvTab.remove();
    }
  };

  // Jellyfin's own tab strip knows nothing of ours: Discover is routed here, and a click on its
  // other tabs first leaves Discover so the strip's own state is right again.
  const onTabClick = (event) => {
    const button = event.target.closest?.(".headerTabs .emby-tab-button");
    if (!button) return;
    if (button === tvTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!wantsDiscover()) kit.go(DISCOVER_HASH);
      return;
    }
    if (view.root) {
      unmountView();
      window.history.replaceState(null, "", "#/home");
      updateTabs();
      // Home is the tab the strip still thinks is selected, so it won't fire; show it ourselves.
      if (button.dataset.index === "0") {
        event.stopImmediatePropagation();
        event.preventDefault();
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
    }
  };

  const observeChrome = () => {
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (seerrOn) updateTabs();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  };

  // ---------- search page ---------------------------------------------------------------

  const searchPage = { input: null, handler: null, timer: 0, seq: 0 };

  const clearSearchRow = () => document.querySelector('[data-hera-row="discover-search"]')?.remove();

  const runPageSearch = async (page, text) => {
    const mine = ++searchPage.seq;
    clearSearchRow();
    if (text.trim().length < SEARCH_MIN) return;
    try {
      const data = await searchTitles(text.trim());
      if (mine !== searchPage.seq || !page.isConnected) return;
      const found = (data?.results ?? []).filter((item) => !item.jellyfinId);
      if (!found.length) return;
      const row = kit.shelf({ id: "discover-search", title: "Discover", cards: found.map((item) => itemCard(item)) });
      kit.mountRow(row, (node) => {
        const results = page.querySelector(".searchResults");
        if (results) results.after(node);
        else page.append(node);
      });
    } catch {
      /* Discover is an extra here; a failure leaves Jellyfin's own results alone */
    }
  };

  const mountSearchPage = (page, params) => {
    const input = page.querySelector("#searchTextInput");
    if (!input || searchPage.input === input) return;
    unbindSearchPage();
    searchPage.input = input;
    searchPage.handler = () => {
      clearTimeout(searchPage.timer);
      if (input.value.trim().length < SEARCH_MIN) {
        searchPage.seq++;
        clearSearchRow();
        return;
      }
      searchPage.timer = setTimeout(() => runPageSearch(page, input.value), 450);
    };
    input.addEventListener("input", searchPage.handler);
    // Jellyfin fills the field from the address a moment after the page shows.
    setTimeout(() => {
      if (searchPage.input === input && (input.value || params.get("query"))) {
        runPageSearch(page, input.value || params.get("query") || "");
      }
    }, 600);
  };

  const unbindSearchPage = () => {
    clearTimeout(searchPage.timer);
    searchPage.seq++;
    if (searchPage.input && searchPage.handler) searchPage.input.removeEventListener("input", searchPage.handler);
    searchPage.input = null;
    searchPage.handler = null;
    clearSearchRow();
  };

  // ---------- series pages --------------------------------------------------------------

  const missing = new Map(); // series id -> Promise<{ tmdbId, seasons[] } | null>

  const loadMissing = (itemId) => {
    if (!missing.has(itemId)) {
      missing.set(
        itemId,
        (async () => {
          const item = await kit.api().getItem(kit.userId(), itemId);
          const tmdbId = item?.Type === "Series" ? item.ProviderIds?.Tmdb : null;
          if (!tmdbId) return null;
          const [details, have] = await Promise.all([
            fetchTitle("tv", tmdbId),
            kit.getJSON(`Shows/${itemId}/Seasons`, { userId: kit.userId() }),
          ]);
          const owned = new Set((have?.Items ?? []).map((season) => season.IndexNumber).filter((n) => n != null));
          const seasons = (details?.seasons ?? [])
            .filter((season) => season.seasonNumber > 0 && season.status === "none" && season.episodeCount > 0 && !owned.has(season.seasonNumber))
            .map((season) => season.seasonNumber);
          return seasons.length ? { tmdbId: Number(tmdbId), seasons } : null;
        })().catch(() => null),
      );
    }
    return missing.get(itemId);
  };

  const seriesWatch = { observer: null, timer: 0 };
  const stopSeriesWatch = () => {
    seriesWatch.observer?.disconnect();
    seriesWatch.observer = null;
    clearTimeout(seriesWatch.timer);
  };

  const removeMissingControls = () => document.querySelectorAll(".hera-discover-missing").forEach((node) => node.remove());

  const mountMissing = async (page, itemId) => {
    stopSeriesWatch();
    const ints = await kit.integrations();
    if (!ints.seerr) return;
    const found = await loadMissing(itemId);
    if (!found || kit.itemIdFromHash() !== itemId) return;

    const place = () => {
      const headEl = page.querySelector(`.hera-seasons[data-item="${itemId}"] .hera-seasons__head`);
      if (!headEl) return false;
      if (headEl.querySelector(".hera-discover-missing")) return true;
      removeMissingControls();
      const control = el(
        "button",
        {
          type: "button",
          class: "hera-btn hera-btn--glass hera-btn--text hera-discover-missing",
          onclick: (event) =>
            openTitle(
              { mediaType: "tv", tmdbId: found.tmdbId },
              {
                seasons: found.seasons,
                opener: event.currentTarget,
                onClose: () => {
                  missing.delete(itemId);
                  loadMissing(itemId).then((next) => {
                    if (!next) control.remove();
                    else control.querySelector(".hera-discover-missing__label").textContent = labelFor(next.seasons);
                    found.seasons = next?.seasons ?? found.seasons;
                  });
                },
              },
            ),
        },
        [icon("add"), el("span", { class: "hera-discover-missing__label", text: labelFor(found.seasons) })],
      );
      headEl.append(control);
      return true;
    };

    if (place()) return;
    // The core builds the season shelf after its own fetches; wait for it.
    seriesWatch.observer = new MutationObserver(() => {
      if (place()) stopSeriesWatch();
    });
    seriesWatch.observer.observe(page, { childList: true, subtree: true });
    seriesWatch.timer = setTimeout(stopSeriesWatch, 10000);
  };

  const labelFor = (seasons) => `Request ${seriesText(seasons)}`;

  // ---------- module --------------------------------------------------------------------

  const onViewShow = (event) => {
    const page = event.target?.closest?.(".page") || event.target;
    if (page instanceof HTMLElement) sync(page);
  };

  const start = () => {
    const wait = setInterval(async () => {
      if (!kit.api() || !kit.userId()) return;
      clearInterval(wait);
      const ints = await kit.integrations();
      seerrOn = Boolean(ints.seerr);
      updateTabs();
      sync();
    }, 250);
    cleanups.push(() => clearInterval(wait));
    listen(document, "viewshow", onViewShow, true);
    listen(window, "hashchange", () => requestAnimationFrame(() => sync()));
    listen(document, "click", onTabClick, true);
    observeChrome();
  };

  HT.register({
    name: "discover",
    async onView(page, { itemId, params }) {
      if (!kit.userId()) return;
      const ints = await kit.integrations();
      seerrOn = Boolean(ints.seerr);
      sync(page);
      if (!ints.seerr) return;
      if (page.id !== "searchPage") unbindSearchPage();
      if (page.id !== "itemDetailPage") {
        stopSeriesWatch();
        removeMissingControls();
      }
      if (page.id === "searchPage") mountSearchPage(page, params);
      if (page.id === "itemDetailPage" && itemId) await mountMissing(page, itemId);
    },
    teardown() {
      closeSheet();
      stopSeriesWatch();
      removeMissingControls();
      unbindSearchPage();
      unmountView();
      desktopTab?.remove();
      tvTab?.remove();
      document.querySelectorAll(".hera-sheet").forEach((node) => node.remove());
      cleanups.splice(0).forEach((fn) => fn());
      delete HT.discover;
    },
  });

  HT.discover = { openTitle };
  start();
})();
