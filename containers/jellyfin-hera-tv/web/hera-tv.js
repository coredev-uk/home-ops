/*
 * Hera TV: the Apple TV app's behaviour for Jellyfin 12's web client.
 *  - Home: a full-bleed hero of unwatched titles with logo artwork, crossfading on a timer
 *    that pauses on hover, focus, a hidden tab or the pause button.
 *  - Series pages: season tabs over a horizontal shelf of episode stills, as tv.apple.com.
 *  - Detail pages: logo artwork stands in for the title.
 * Everything talks to the server through the page's own ApiClient; playback goes through the
 * server's remote-control endpoint aimed at this browser's own session, so the stock player opens.
 */
(() => {
  "use strict";

  if (window.HeraTV) {
    window.HeraTV.teardown();
  }

  const root = document.documentElement;
  root.classList.add("hera");

  const state = {
    config: { heroItemCount: 8, heroIntervalSeconds: 8 },
    heroItems: null,
    heroUser: null,
    heroLoad: null,
    heroFetchedAt: 0,
    hero: null,
    cleanups: [],
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- helpers -----------------------------------------------------------------

  const api = () => window.ApiClient;
  const userId = () => api()?.getCurrentUserId?.();

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  };

  const icon = (name) => el("span", { class: "material-icons", "aria-hidden": "true", text: name });

  const getJSON = (path, params) => api().getJSON(api().getUrl(path, params));

  const imageUrl = (itemId, type, opts = {}) =>
    api().getScaledImageUrl(itemId, { type, quality: 90, ...opts });

  const runtime = (ticks) => {
    if (!ticks) return null;
    const minutes = Math.round(ticks / 600000000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h} hr${m ? ` ${m} min` : ""}` : `${m} min`;
  };

  const shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const go = (hash) => {
    window.location.hash = hash;
  };

  // Play on this browser by sending the server's PlayNow command to our own session.
  let sessionId = null;
  const ownSession = async () => {
    if (sessionId) return sessionId;
    const sessions = await getJSON("Sessions", { deviceId: api().deviceId() });
    sessionId = sessions?.[0]?.Id ?? null;
    return sessionId;
  };

  const play = async (item) => {
    let target = item;
    if (item.Type === "Series") {
      const next = await getJSON("Shows/NextUp", { seriesId: item.Id, userId: userId(), limit: 1 });
      target = next?.Items?.[0];
      if (!target) {
        const first = await getJSON(`Shows/${item.Id}/Episodes`, { userId: userId(), limit: 1 });
        target = first?.Items?.[0];
      }
    }
    if (!target) return go(`#/details?id=${item.Id}`);
    const id = await ownSession();
    if (!id) return go(`#/details?id=${target.Id}`);
    const params = { playCommand: "PlayNow", itemIds: target.Id };
    const position = target.UserData?.PlaybackPositionTicks;
    if (position) params.startPositionTicks = position;
    await api().ajax({ type: "POST", url: api().getUrl(`Sessions/${id}/Playing`, params) });
  };

  const toggleFavourite = async (item, button) => {
    const next = !(item.UserData?.IsFavorite ?? false);
    await api().updateFavoriteStatus(userId(), item.Id, next);
    item.UserData = { ...(item.UserData || {}), IsFavorite: next };
    button.setAttribute("aria-pressed", String(next));
    button.querySelector(".material-icons").textContent = next ? "favorite" : "favorite_border";
    button.setAttribute("aria-label", next ? "Remove from Favourites" : "Add to Favourites");
  };

  // ---------- appearance ----------------------------------------------------------------
  // Automatic follows the device; Light and Dark pin it. The choice is saved in a display-
  // preferences record of its own (so it follows the user between browsers, and Jellyfin's own
  // settings saves never overwrite it) and in localStorage, so the next load paints in the
  // right scheme before the server answers. hera-tv.css keys every colour off data-hera-scheme.

  const APPEARANCES = [
    ["auto", "Automatic"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  const APPEARANCE_KEY = "hera-appearance";
  const lightQuery = window.matchMedia?.("(prefers-color-scheme: light)");
  const storedAppearance = () => {
    try {
      return localStorage.getItem(APPEARANCE_KEY);
    } catch {
      return null;
    }
  };
  const prefsUrl = () => api().getUrl("DisplayPreferences/hera", { userId: userId(), client: "heratv" });

  const appearance = {
    pref: APPEARANCES.some(([key]) => key === storedAppearance()) ? storedAppearance() : "auto",
    listeners: new Set(),
    scheme() {
      if (this.pref === "light" || this.pref === "dark") return this.pref;
      return lightQuery?.matches ? "light" : "dark";
    },
    label(pref = this.pref) {
      return APPEARANCES.find(([key]) => key === pref)?.[1] || "Automatic";
    },
    apply() {
      const scheme = this.scheme();
      root.dataset.heraScheme = scheme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", scheme === "light" ? "#ffffff" : "#000000");
      this.listeners.forEach((fn) => fn(this.pref, scheme));
    },
    remember(pref) {
      this.pref = pref;
      try {
        localStorage.setItem(APPEARANCE_KEY, pref);
      } catch {
        /* private mode: the server copy still holds it */
      }
      this.apply();
    },
    async load() {
      const prefs = await api().getJSON(prefsUrl()).catch(() => null);
      const pref = prefs?.CustomPrefs?.[APPEARANCE_KEY];
      if (APPEARANCES.some(([key]) => key === pref) && pref !== this.pref) this.remember(pref);
    },
    async set(pref) {
      if (!APPEARANCES.some(([key]) => key === pref)) return;
      this.remember(pref);
      const prefs = (await api().getJSON(prefsUrl()).catch(() => null)) || { Id: "hera", Client: "heratv" };
      prefs.CustomPrefs = { ...prefs.CustomPrefs, [APPEARANCE_KEY]: pref };
      await api().ajax({ type: "POST", url: prefsUrl(), data: JSON.stringify(prefs), contentType: "application/json" });
    },
    /** Calls `fn(pref, scheme)` on every change; returns the unsubscribe. */
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };

  // ---------- shared kit for modules ----------------------------------------------------
  // hera-home.js and hera-discover.js load after this file and build on these pieces, so every
  // row, card and request in the client looks and behaves the same.

  /** Calls the plugin's own API as the signed-in user. */
  const hera = (path, { method = "GET", query, body } = {}) =>
    api().ajax({
      type: method,
      url: api().getUrl(`HeraTV/${path}`, query),
      data: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
      dataType: "json",
    });

  // Which integrations the server has, and whether this user is linked to Seerr; one fetch per user.
  let integrationsFor = null;
  let integrationsLoad = null;
  const integrations = () => {
    if (integrationsFor !== userId()) {
      integrationsFor = userId();
      integrationsLoad = hera("integrations").catch(() => ({ seerr: false, seerrLinked: false, maintainerr: false }));
    }
    return integrationsLoad;
  };

  /**
   * One card for every row: poster (2:3) or wide (16:9) artwork with an optional badge and
   * progress bar, title and subtitle below. `href` makes it a link; `onClick` a button.
   */
  const card = ({ href, onClick, image, shape = "poster", title, subtitle, badge, badgeTone, progress, label }) => {
    const art = el("span", { class: "hera-card__art" }, [
      image
        ? el("img", { src: image, alt: "", loading: "lazy", decoding: "async" })
        : el("span", { class: "hera-card__fallback", text: title }),
      badge ? el("span", { class: `hera-card__badge${badgeTone ? ` hera-card__badge--${badgeTone}` : ""}`, text: badge }) : null,
      progress > 0
        ? el("span", { class: "hera-card__progress" }, el("span", { style: `width:${Math.min(100, Math.max(3, progress))}%` }))
        : null,
    ]);
    const text = [
      title ? el("span", { class: "hera-card__title", text: title }) : null,
      subtitle ? el("span", { class: "hera-card__subtitle", text: subtitle }) : null,
    ];
    const attrs = { class: `hera-card hera-card--${shape}`, "aria-label": label || [title, subtitle].filter(Boolean).join(", ") };
    if (href) return el("a", { ...attrs, href }, [art, ...text]);
    const button = el("button", { ...attrs, type: "button" }, [art, ...text]);
    if (onClick) button.addEventListener("click", onClick);
    return button;
  };

  /**
   * A titled horizontal row of cards with tv.apple.com's hover paddles. `id` makes it
   * replaceable: mounting a row with the same id swaps the old one in place.
   */
  const shelf = ({ id, title, href, cards, shape = "poster" }) => {
    const track = el("div", { class: `hera-shelf hera-shelf--${shape}` }, cards);
    const paddle = (dir) =>
      el(
        "button",
        {
          type: "button",
          tabindex: "-1",
          class: `hera-row__paddle hera-row__paddle--${dir}`,
          "aria-label": dir === "prev" ? `Scroll ${title} back` : `Scroll ${title} on`,
          onclick: () =>
            track.scrollBy({
              left: (dir === "prev" ? -1 : 1) * track.clientWidth * 0.85,
              behavior: reduceMotion.matches ? "auto" : "smooth",
            }),
        },
        icon(dir === "prev" ? "chevron_left" : "chevron_right"),
      );
    const prev = paddle("prev");
    const next = paddle("next");
    const sync = () => {
      prev.hidden = track.scrollLeft <= 4;
      next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    track.addEventListener("scroll", sync, { passive: true });
    requestAnimationFrame(sync);
    const heading = el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title", text: title });
    return el("section", { class: "hera-row verticalSection", "data-hera-row": id || null, "aria-label": title }, [
      el("div", { class: "hera-row__head" }, [
        href
          ? el("a", { class: "hera-row__link", href }, [heading, icon("chevron_right")])
          : heading,
      ]),
      el("div", { class: "hera-row__viewport" }, [track, prev, next]),
    ]);
  };

  /** Puts a row where `place` says, replacing a previous row with the same id. */
  const mountRow = (row, place) => {
    const id = row.dataset.heraRow;
    const old = id ? document.querySelector(`[data-hera-row="${CSS.escape(id)}"]`) : null;
    if (old) old.replaceWith(row);
    else place(row);
    return row;
  };

  /** A short date, as tvOS writes them: "9 Dec". */
  const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  const modules = [];

  // ---------- stylesheet order ---------------------------------------------------------
  // Jellyfin appends its theme and plugin styles after ours at runtime; keep ours last so
  // equal-specificity rules resolve in our favour without !important everywhere.

  const keepStylesheetLast = () => {
    const links = () => [...document.querySelectorAll('link[data-hera-tv][rel="stylesheet"]')];
    if (!links().length) return;
    let queued = false;
    const move = () => {
      queued = false;
      const custom = document.getElementById("cssBranding");
      const anchor = custom && custom.parentNode === document.head ? custom : null;
      const ours = links();
      const last = ours[ours.length - 1];
      // Already in place: ours are contiguous, in order, and last (or just before branding).
      const inPlace = anchor ? last.nextElementSibling === anchor : document.head.lastElementChild === last;
      if (inPlace && ours.every((link, i) => i === 0 || ours[i - 1].nextElementSibling === link)) return;
      for (const link of ours) {
        if (anchor) document.head.insertBefore(link, anchor);
        else document.head.append(link);
      }
    };
    const observer = new MutationObserver(() => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(move);
      }
    });
    observer.observe(document.head, { childList: true });
    move();
    state.cleanups.push(() => observer.disconnect());
  };

  // ---------- home hero ----------------------------------------------------------------

  // Titles are per profile: a different signed-in user never sees the last one's list.
  const loadHeroItems = async () => {
    const user = userId();
    const fresh = state.heroUser === user && Date.now() - state.heroFetchedAt < 10 * 60 * 1000;
    if (state.heroItems && fresh) return state.heroItems;
    const result = await getJSON(`Users/${user}/Items`, {
      IncludeItemTypes: "Movie,Series",
      Recursive: true,
      ImageTypes: "Backdrop,Logo",
      IsPlayed: false,
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Limit: 40,
      Fields: "Overview,Genres,OfficialRating,CommunityRating,RunTimeTicks,ProductionYear,ChildCount,BackdropImageTags,ImageTags,UserData",
    });
    // ImageTypes matches items with any of the types; the hero needs the backdrop.
    const items = (result?.Items ?? []).filter((item) => item.BackdropImageTags?.length);
    state.heroItems = shuffle(items).slice(0, state.config.heroItemCount);
    state.heroUser = user;
    state.heroFetchedAt = Date.now();
    return state.heroItems;
  };

  const heroSlide = (item, index, total) => {
    const isSeries = item.Type === "Series";
    const resumable = !isSeries && item.UserData?.PlaybackPositionTicks > 0;
    const backdrop = imageUrl(item.Id, "Backdrop", {
      maxWidth: Math.min(2560, Math.round(window.innerWidth * (window.devicePixelRatio || 1))),
      tag: item.BackdropImageTags?.[0],
    });
    const logo = item.ImageTags?.Logo
      ? el("img", {
          class: "hera-hero__logo",
          alt: item.Name,
          src: imageUrl(item.Id, "Logo", { maxWidth: 900, tag: item.ImageTags.Logo }),
        })
      : el("h2", { class: "hera-hero__title", text: item.Name });

    const meta = el("p", { class: "hera-hero__meta" }, [
      el("span", { text: isSeries ? "TV Show" : "Film" }),
      item.Genres?.length ? el("span", { text: item.Genres.slice(0, 2).join(", ") }) : null,
      item.ProductionYear ? el("span", { text: String(item.ProductionYear) }) : null,
      isSeries
        ? item.ChildCount
          ? el("span", { text: `${item.ChildCount} ${item.ChildCount === 1 ? "Season" : "Seasons"}` })
          : null
        : runtime(item.RunTimeTicks)
          ? el("span", { text: runtime(item.RunTimeTicks) })
          : null,
      item.OfficialRating ? el("span", { class: "hera-badge", text: item.OfficialRating }) : null,
    ]);

    const favourite = item.UserData?.IsFavorite ?? false;
    const favButton = el(
      "button",
      {
        type: "button",
        class: "hera-btn hera-btn--glass",
        "aria-pressed": String(favourite),
        "aria-label": favourite ? "Remove from Favourites" : "Add to Favourites",
        title: "Favourites",
      },
      icon(favourite ? "favorite" : "favorite_border"),
    );
    favButton.addEventListener("click", () => toggleFavourite(item, favButton).catch(console.error));

    return el(
      "article",
      {
        class: "hera-hero__slide",
        "aria-roledescription": "slide",
        "aria-label": `${index + 1} of ${total}: ${item.Name}`,
        "data-index": index,
      },
      [
        el("img", { class: "hera-hero__backdrop", src: backdrop, alt: "", loading: index ? "lazy" : "eager", decoding: "async" }),
        el("div", { class: "hera-hero__content" }, [
          logo,
          meta,
          item.Overview ? el("p", { class: "hera-hero__overview", text: item.Overview }) : null,
          el("div", { class: "hera-hero__actions" }, [
            el(
              "button",
              {
                type: "button",
                class: "hera-btn hera-btn--primary",
                onclick: () => play(item).catch(console.error),
              },
              [icon("play_arrow"), el("span", { text: resumable ? "Resume" : "Play" })],
            ),
            el(
              "button",
              {
                type: "button",
                class: "hera-btn hera-btn--glass",
                "aria-label": `More about ${item.Name}`,
                title: "Details",
                onclick: () => go(`#/details?id=${item.Id}`),
              },
              icon("info_outline"),
            ),
            favButton,
          ]),
        ]),
      ],
    );
  };

  // The ambient ground: the current title's art, blurred and dimmed, fixed behind the page (see
  // .hera-ambient in hera-tv.css). The home hero and every detail page feed it, so the rows under
  // a hero and the credits under a banner sit in the same light on every kind of page. Two layers
  // crossfade so a change of title never flashes the ground.
  const ambient = {
    node: null,
    show(src) {
      if (!src) return;
      if (!this.node?.isConnected) {
        this.node = el("div", { class: "hera-ambient", "aria-hidden": "true" }, [
          el("div", { class: "hera-ambient__layer" }),
          el("div", { class: "hera-ambient__layer" }),
        ]);
        document.body.prepend(this.node);
      }
      const [a, b] = this.node.children;
      const shown = a.classList.contains("is-on") ? a : b.classList.contains("is-on") ? b : null;
      if (shown?.dataset.src === src) return;
      const incoming = shown === a ? b : a;
      incoming.dataset.src = src;
      incoming.style.backgroundImage = `url("${src.replace(/"/g, "%22")}")`;
      incoming.classList.add("is-on");
      shown?.classList.remove("is-on");
    },
    hide() {
      this.node?.querySelectorAll(".is-on").forEach((layer) => layer.classList.remove("is-on"));
    },
    remove() {
      this.node?.remove();
      this.node = null;
    },
  };

  class Hero {
    constructor(items) {
      this.items = items;
      this.index = 0;
      this.userPaused = false;
      this.holds = new Set();
      this.elapsed = 0;
      this.last = 0;
      this.frame = 0;
      this.interval = state.config.heroIntervalSeconds * 1000;
      this.build();
    }

    build() {
      const total = this.items.length;
      this.slides = this.items.map((item, i) => heroSlide(item, i, total));
      this.dots = this.items.map((item, i) =>
        el("button", {
          type: "button",
          role: "tab",
          class: "hera-hero__dot",
          "aria-label": item.Name,
          "aria-selected": "false",
          onclick: () => this.show(i, true),
        }),
      );
      this.toggle = el(
        "button",
        {
          type: "button",
          class: "hera-btn hera-btn--glass hera-hero__toggle",
          "aria-label": "Pause featured titles",
          onclick: () => this.setUserPaused(!this.userPaused),
        },
        icon("pause"),
      );
      this.node = el(
        "section",
        { class: "hera-hero", "aria-roledescription": "carousel", "aria-label": "Featured" },
        [
          el("div", { class: "hera-hero__slides", "aria-live": "off" }, this.slides),
          total > 1
            ? el("div", { class: "hera-hero__controls" }, [
                el(
                  "button",
                  {
                    type: "button",
                    class: "hera-hero__paddle",
                    // Pointer affordance: keyboards and remotes step with the pager's arrow keys.
                    tabindex: "-1",
                    "aria-label": "Previous title",
                    onclick: () => this.show(this.index - 1, true),
                  },
                  icon("chevron_left"),
                ),
                el("div", { class: "hera-hero__pager focuscontainer-x", role: "tablist", "aria-label": "Featured titles" }, this.dots),
                el(
                  "button",
                  {
                    type: "button",
                    class: "hera-hero__paddle",
                    tabindex: "-1",
                    "aria-label": "Next title",
                    onclick: () => this.show(this.index + 1, true),
                  },
                  icon("chevron_right"),
                ),
                this.toggle,
              ])
            : null,
        ],
      );

      const hold = (reason) => () => this.holds.add(reason);
      const release = (reason) => () => this.holds.delete(reason);
      this.node.addEventListener("pointerenter", hold("hover"));
      this.node.addEventListener("pointerleave", release("hover"));
      // On a TV the remote rests on Play, so only focus on the pager holds the timer there.
      this.node.addEventListener("focusin", (e) => {
        if (!root.classList.contains("layout-tv") || e.target.closest(".hera-hero__controls")) this.holds.add("focus");
        else this.holds.delete("focus");
      });
      this.node.addEventListener("focusout", (e) => {
        if (!this.node.contains(e.relatedTarget)) this.holds.delete("focus");
      });
      this.node.addEventListener("keydown", (e) => {
        if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.target.closest(".hera-hero__pager")) {
          e.preventDefault();
          e.stopPropagation();
          // Left past the first title returns to the buttons rather than wrapping around.
          if (e.key === "ArrowLeft" && this.index === 0) {
            this.node.querySelector(".hera-hero__slide.is-active .hera-hero__actions")?.lastElementChild?.focus();
          } else {
            this.show(this.index + (e.key === "ArrowRight" ? 1 : -1), true);
          }
        }
        // Right from the last action reaches the pager: the two sit far apart on one row,
        // which Jellyfin's spatial navigation skips.
        const actions = e.target.closest(".hera-hero__actions");
        if (e.key === "ArrowRight" && actions && e.target === actions.lastElementChild) {
          e.preventDefault();
          e.stopPropagation();
          this.dots[this.index]?.focus();
        }
        // Down leaves the hero for the first shelf, as on tvOS; Jellyfin's spatial navigation
        // otherwise stays among the stacked slides.
        if (e.key === "ArrowDown") {
          const page = this.node.closest(".page");
          // A comma list, not :is(): older webOS Chromium lacks :is, and querySelector returns the
          // first match in document order either way.
          const card = page?.querySelector(
            ".homeSectionsContainer .verticalSection:not(.hide) .card, .homeSectionsContainer .verticalSection:not(.hide) .hera-card",
          );
          if (card) {
            e.preventDefault();
            e.stopPropagation();
            card.focus();
            card.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" });
          }
        }
      });
      // Up from the first shelf returns to the hero's Play button.
      this.onKeyUp = (e) => {
        if (e.key !== "ArrowUp" || !this.node.isConnected) return;
        const section = e.target.closest?.(".homeSectionsContainer .verticalSection:not(.hide)");
        const first = this.node.closest(".page")?.querySelector(".homeSectionsContainer .verticalSection:not(.hide)");
        if (!section || section !== first) return;
        e.preventDefault();
        e.stopPropagation();
        this.node.querySelector(".hera-hero__slide.is-active .hera-btn--primary")?.focus();
        window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
      };
      document.addEventListener("keydown", this.onKeyUp, true);
      this.visibility = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.4) this.holds.delete("offscreen");
        else this.holds.add("offscreen");
      }, { threshold: [0, 0.4, 1] });
      this.visibility.observe(this.node);
      this.onVisibility = () => (document.hidden ? this.holds.add("hidden") : this.holds.delete("hidden"));
      document.addEventListener("visibilitychange", this.onVisibility);

      this.show(0, false, true);
      if (reduceMotion.matches) this.setUserPaused(true);
      this.tick = this.tick.bind(this);
      this.frame = requestAnimationFrame(this.tick);
    }

    setUserPaused(paused) {
      this.userPaused = paused;
      this.toggle.setAttribute("aria-label", paused ? "Play featured titles" : "Pause featured titles");
      this.toggle.querySelector(".material-icons").textContent = paused ? "play_arrow" : "pause";
    }

    async show(index, fromUser, immediate = false) {
      const total = this.slides.length;
      const target = (index + total) % total;
      const token = (this.token = (this.token || 0) + 1);
      this.elapsed = 0;
      // Crossfade only to a decoded backdrop, so the fade never reveals a half-drawn image.
      const img = this.slides[target].querySelector(".hera-hero__backdrop");
      if (!immediate && img && !img.complete) {
        img.loading = "eager";
        await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
        if (token !== this.token) return;
      }
      this.index = target;
      this.slides.forEach((slide, i) => {
        const active = i === this.index;
        slide.classList.toggle("is-active", active);
        slide.toggleAttribute("inert", !active);
      });
      this.dots.forEach((dot, i) => dot.setAttribute("aria-selected", String(i === this.index)));
      this.dots.forEach((dot) => dot.style.removeProperty("--hera-progress"));
      this.elapsed = 0;
      if (fromUser && document.activeElement?.classList.contains("hera-hero__dot")) {
        this.dots[this.index].focus();
      }
      const next = this.slides[(this.index + 1) % total]?.querySelector(".hera-hero__backdrop");
      if (next) next.loading = "eager";
      this.paintAmbient();
    }

    paintAmbient() {
      const img = this.slides[this.index]?.querySelector(".hera-hero__backdrop");
      ambient.show(img?.currentSrc || img?.src);
    }

    paint(progress) {
      this.dots[this.index]?.style.setProperty("--hera-progress", progress.toFixed(4));
    }

    tick(now) {
      const dt = this.last ? Math.min(now - this.last, 100) : 0;
      this.last = now;
      if (this.slides.length > 1 && !this.userPaused && this.holds.size === 0) {
        this.elapsed += dt;
        if (this.elapsed >= this.interval) this.show(this.index + 1, false);
        else this.paint(this.elapsed / this.interval);
      }
      this.frame = requestAnimationFrame(this.tick);
    }

    destroy() {
      this.guard?.disconnect();
      cancelAnimationFrame(this.frame);
      this.visibility.disconnect();
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("keydown", this.onKeyUp, true);
      this.node.remove();
    }
  }

  // Favourites is a second tab of the same page: the hero's dark header and the hidden page backdrop
  // belong to the home tab alone, so the class follows which tab is showing.
  const heroTabObserver = { observer: null };
  const watchHomeTab = (tab) => {
    heroTabObserver.observer?.disconnect();
    const sync = () => root.classList.toggle("hera-home", tab.classList.contains("is-active"));
    heroTabObserver.observer = new MutationObserver(sync);
    heroTabObserver.observer.observe(tab, { attributes: true, attributeFilter: ["class"] });
    sync();
  };

  const mountHero = async (page) => {
    const tab = page.querySelector("#homeTab");
    const sections = tab?.querySelector(".homeSectionsContainer");
    if (!tab || !sections) return;
    watchHomeTab(tab);
    if (state.hero && state.heroUser !== userId()) {
      state.hero.destroy();
      state.hero = null;
    }
    if (state.hero && tab.contains(state.hero.node)) return;
    // viewshow and the hashchange fallback both land here; one fetch serves both.
    state.heroLoad ??= loadHeroItems().finally(() => {
      state.heroLoad = null;
    });
    const items = await state.heroLoad;
    if (state.hero && tab.contains(state.hero.node)) return;
    if (!items.length || !page.isConnected || page.classList.contains("hide")) {
      root.classList.remove("hera-home");
      return;
    }
    state.hero?.destroy();
    const hero = (state.hero = new Hero(items));
    tab.insertBefore(hero.node, tab.firstChild);
    // Jellyfin redraws the home tab when it comes back to it, which can sweep the hero out of
    // the tab after it was mounted; put it back at the top.
    hero.guard = new MutationObserver(() => {
      if (hero.node.parentNode === tab || !tab.isConnected || page.classList.contains("hide")) return;
      tab.insertBefore(hero.node, tab.firstChild);
    });
    hero.guard.observe(tab, { childList: true });
    // On a TV the remote starts on Play, as tvOS starts on the hero's primary action.
    if (root.classList.contains("layout-tv") && window.scrollY < 80) {
      const focusPlay = () => state.hero?.node.querySelector(".hera-hero__slide.is-active .hera-btn--primary")?.focus();
      focusPlay();
      // Jellyfin's own autofocus can run after us and leave focus on the body.
      setTimeout(() => {
        if (document.activeElement === document.body) focusPlay();
      }, 500);
    }
  };

  // ---------- series seasons ------------------------------------------------------------

  // One wide card for every shelf of stills: a show's episodes, a collection's films, and (from
  // hera-seerr.js) the films a collection is missing. The centred disc is the card's action: Play
  // for what the library holds, Request for what it doesn't. A card without a page to open is a
  // button that runs that action; its disc is then only a picture of it.
  const shelfCard = ({ href = null, image = null, logo = null, numbered = false, number = null, name, overview, meta, progress = 0, played = false, action, className = "", label = null }) => {
    let disc;
    if (href) {
      disc = el("button", { type: "button", class: "hera-btn hera-btn--glass hera-episode__play", "aria-label": action.label }, icon(action.icon));
      disc.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        action.run(e);
      });
    } else {
      disc = el("span", { class: "hera-btn hera-btn--glass hera-episode__play", "aria-hidden": "true" }, icon(action.icon));
    }
    const card = el(
      href ? "a" : "button",
      {
        class: ["hera-episode", played ? "is-played" : "", className].filter(Boolean).join(" "),
        href,
        type: href ? null : "button",
        "aria-label": label,
      },
      [
        el("span", { class: logo ? "hera-episode__still has-logo" : "hera-episode__still" }, [
          image ? el("img", { src: image, alt: "", loading: "lazy", decoding: "async" }) : null,
          logo ? el("img", { class: "hera-episode__logo", src: logo, alt: "", loading: "lazy", decoding: "async" }) : null,
          progress && !played ? el("span", { class: "hera-episode__progress" }, el("span", { style: `width:${Math.max(3, progress)}%` })) : null,
          disc,
        ]),
        el("span", { class: "hera-episode__name" }, [
          // A numbered shelf counts its cards in CSS, so a card added in its place renumbers the rest.
          numbered ? el("b", { class: "hera-episode__number" }) : number != null ? el("b", { text: String(number) }) : null,
          document.createTextNode(name),
        ]),
        overview ? el("span", { class: "hera-episode__overview", text: overview }) : null,
        meta ? el("span", { class: "hera-episode__meta", text: meta }) : null,
      ],
    );
    if (!href) card.addEventListener("click", (e) => action.run(e));
    return card;
  };

  const episodeCard = (episode) =>
    shelfCard({
      href: `#/details?id=${episode.Id}`,
      image: episode.ImageTags?.Primary ? imageUrl(episode.Id, "Primary", { maxWidth: 640, tag: episode.ImageTags.Primary }) : null,
      number: episode.IndexNumber,
      name: episode.Name,
      overview: episode.Overview,
      meta: [runtime(episode.RunTimeTicks), episode.PremiereDate ? new Date(episode.PremiereDate).getFullYear() : null].filter(Boolean).join(" · "),
      progress: episode.UserData?.PlayedPercentage,
      played: episode.UserData?.Played,
      action: { icon: "play_arrow", label: `Play ${episode.Name}`, run: () => play(episode).catch(console.error) },
    });

  // Moving between episodes of a show opens a new detail page each time (Jellyfin keeps a few in
  // its view cache, which is why some came back instantly and others redrew from nothing). What
  // a page needs from the show (its series, the series list, each series' episodes, the banner
  // art) is kept here for a minute, so a new page paints the banner and the Episodes shelf in its
  // first frame instead of after three round trips. itemHints answers "what is this id?" for
  // anything the shelf has already shown, so even the first item lookup is skipped.
  const SHOW_TTL = 60 * 1000;
  const showCache = new Map(); // seriesId -> { at, seasons, nextUp, episodes: Map(seasonId -> promise) }
  const itemHints = new Map(); // itemId -> { Id, Type, SeriesId, SeasonId }
  const artCache = new Map(); // itemId or seriesId -> { banner, ambient }
  let shelfNavigation = null; // { seriesId, y, left, at } while moving between episodes from the shelf
  const showData = (seriesId) => {
    let entry = showCache.get(seriesId);
    if (!entry || Date.now() - entry.at > SHOW_TTL || entry.user !== userId()) {
      const failed = () => showCache.delete(seriesId);
      entry = {
        at: Date.now(),
        user: userId(),
        seasons: getJSON(`Shows/${seriesId}/Seasons`, { userId: userId() }).catch((error) => (failed(), Promise.reject(error))),
        nextUp: getJSON("Shows/NextUp", { seriesId, userId: userId(), limit: 1 }).catch(() => null),
        episodes: new Map(),
      };
      showCache.set(seriesId, entry);
    }
    return entry;
  };
  // After moving between episodes from the shelf, put the reader back where they were: same shelf
  // position, same scroll. Runs for a freshly drawn page (from the shelf's first paint) and for
  // one Jellyfin brings back from its view cache (from onView). Jellyfin scrolls a shown page to
  // the top a frame later, and the page below the shelf may still be loading (so it can't scroll
  // that far yet), so this keeps trying for a moment, and stops as soon as the reader scrolls.
  const restoreShelfPlace = (page) => {
    const memo = shelfNavigation;
    if (!memo || Date.now() - memo.at > 4000) return false;
    const section = page.querySelector(".hera-seasons");
    const hint = itemHints.get(itemIdFromHash());
    if (!section || hint?.Type !== "Episode" || hint.SeriesId !== memo.seriesId) return false;
    shelfNavigation = null;
    section.querySelector(".hera-shelf")?.scrollTo({ left: memo.left, behavior: "instant" });
    let stopped = false;
    const stop = () => (stopped = true);
    const events = ["wheel", "touchstart", "keydown", "mousedown"];
    events.forEach((type) => window.addEventListener(type, stop, { once: true, passive: true }));
    const until = Date.now() + 1500;
    const land = () => {
      if (stopped || Date.now() > until) {
        events.forEach((type) => window.removeEventListener(type, stop));
        return;
      }
      if (Math.abs(window.scrollY - memo.y) > 2) window.scrollTo({ top: memo.y, behavior: "instant" });
      setTimeout(() => requestAnimationFrame(land), 120);
    };
    requestAnimationFrame(() => requestAnimationFrame(land));
    return true;
  };

  const seasonEpisodes = (seriesId, seasonId) => {
    const entry = showData(seriesId);
    if (!entry.episodes.has(seasonId)) {
      entry.episodes.set(
        seasonId,
        getJSON(`Shows/${seriesId}/Episodes`, { seasonId, userId: userId(), Fields: "Overview,PremiereDate" }).then((result) => {
          for (const episode of result?.Items ?? []) {
            itemHints.set(episode.Id, { Id: episode.Id, Type: "Episode", SeriesId: seriesId, SeasonId: episode.SeasonId ?? seasonId });
          }
          return result;
        }),
      );
    }
    return entry.episodes.get(seasonId);
  };

  // The same Episodes section, in the same place (first after the banner), on a series, a season
  // and an episode page, as the Apple TV app has one episode shelf with series tabs wherever you
  // are in a show. A series opens on the series it's up to; a season on itself; an episode on its
  // own series, scrolled to it and marked as the one you're on. Jellyfin's own lists (a season's
  // vertical list, an episode's "More from Series N" carousel) step aside for it.
  const mountSeasons = async (page, itemId) => {
    const existing = page.querySelector(".hera-seasons");
    if (existing?.dataset.item === itemId) return;
    existing?.remove();
    page.classList.remove("hera-has-seasons");
    const item = itemHints.get(itemId) ?? (await api().getItem(userId(), itemId));
    if (!item || !["Series", "Season", "Episode"].includes(item.Type)) return;
    const seriesId = item.Type === "Series" ? item.Id : item.SeriesId;
    if (!seriesId) return;
    itemHints.set(itemId, { Id: item.Id, Type: item.Type, SeriesId: seriesId, SeasonId: item.SeasonId });
    const show = showData(seriesId);
    const [seasonsResult, nextUp] = await Promise.all([show.seasons, show.nextUp]);
    const seasons = seasonsResult?.Items ?? [];
    for (const season of seasons) itemHints.set(season.Id, { Id: season.Id, Type: "Season", SeriesId: seriesId });
    if (!seasons.length || page.querySelector(".hera-seasons") || itemIdFromHash() !== itemId) return;

    const nextEpisode = nextUp?.Items?.[0];
    const openSeasonId = item.Type === "Season" ? item.Id : item.Type === "Episode" ? item.SeasonId : nextEpisode?.SeasonId;
    const focusEpisodeId = item.Type === "Episode" ? item.Id : nextEpisode?.Id;
    const startIndex = Math.max(0, seasons.findIndex((s) => s.Id === openSeasonId));
    const shelf = el("div", { class: "hera-shelf", role: "tabpanel" });
    // Picking another episode from the shelf is browsing, not leaving: the new page opens where
    // the old one was (same scroll, same shelf position) instead of at the top, every time, rather
    // than only when Jellyfin happened to have the page cached.
    shelf.addEventListener("click", (event) => {
      if (!event.target.closest(".hera-episode") || event.target.closest(".hera-episode__play")) return;
      shelfNavigation = { seriesId, y: window.scrollY, left: shelf.scrollLeft, at: Date.now() };
    });
    const tabs = seasons.map((season, i) =>
      el("button", {
        type: "button",
        role: "tab",
        class: "hera-seasons__tab",
        "aria-selected": "false",
        text: season.Name,
        onclick: () => select(i),
      }),
    );

    const select = async (i) => {
      tabs.forEach((tab, j) => tab.setAttribute("aria-selected", String(i === j)));
      shelf.setAttribute("aria-label", seasons[i].Name);
      const result = await seasonEpisodes(seriesId, seasons[i].Id);
      if (tabs[i].getAttribute("aria-selected") !== "true") return;
      shelf.replaceChildren(...(result?.Items ?? []).map(episodeCard));
      const target = focusEpisodeId && shelf.querySelector(`a[href$="${focusEpisodeId}"]`);
      if (target && item.Type === "Episode") {
        target.classList.add("is-current");
        target.setAttribute("aria-current", "page");
      }
      if (restoreShelfPlace(page)) return;
      shelf.scrollTo({ left: target ? target.offsetLeft - shelf.offsetLeft : 0, behavior: "instant" });
    };

    const section = el("section", { class: "hera-seasons verticalSection", "aria-label": "Episodes", "data-item": itemId }, [
      el("div", { class: "hera-seasons__head" }, [
        el("h2", { class: "hera-seasons__title", text: "Episodes" }),
        seasons.length > 1 ? el("div", { class: "hera-seasons__tabs focuscontainer-x", role: "tablist" }, tabs) : null,
      ]),
      shelf,
    ]);

    // Episodes come straight after the hero, before the credits, as tv.apple.com orders a show.
    const primary = page.querySelector(".detailPagePrimaryContent");
    if (!primary) return;
    primary.insertBefore(section, primary.firstChild);
    page.classList.add("hera-has-seasons");
    await select(startIndex);
  };

  // ---------- collections ---------------------------------------------------------------

  // A collection is its films in release order, on the same shelf as a show's episodes (the Apple
  // TV app puts a bundle's films and a season's episodes on the same kind of row): wide stills
  // with the film's logo, numbered, with synopsis and meta. The next film to watch carries the
  // quiet edge, and the banner's Play starts it ("Play Batman Begins", or "Resume …"). Films the
  // library lacks join the shelf in their place from hera-seerr.js, through kit.collectionShelf.
  const boxSets = new WeakMap(); // page -> { itemId, ready: Promise<shelf handle | null> }

  const dateOf = (item) => (item.PremiereDate || (item.ProductionYear ? `${item.ProductionYear}-01-01` : "")).slice(0, 10);

  // In progress first, as Up Next does; else the first one not watched; else the first.
  const nextInOrder = (items) =>
    items.find((item) => item.UserData?.PlaybackPositionTicks > 0 && !item.UserData?.Played) ??
    items.find((item) => !item.UserData?.Played) ??
    items[0];

  const filmCard = (item, { rating = true } = {}) => {
    const backdrop = item.BackdropImageTags?.[0];
    const tags = item.ImageTags ?? {};
    const image = backdrop
      ? imageUrl(item.Id, "Backdrop", { maxWidth: 720, tag: backdrop })
      : tags.Thumb
        ? imageUrl(item.Id, "Thumb", { maxWidth: 720, tag: tags.Thumb })
        : tags.Primary
          ? imageUrl(item.Id, "Primary", { maxWidth: 720, tag: tags.Primary })
          : null;
    const card = shelfCard({
      href: `#/details?id=${item.Id}`,
      image,
      // A thumb usually has the title painted on; the logo goes only over plain key art.
      logo: backdrop && tags.Logo ? imageUrl(item.Id, "Logo", { maxWidth: 360, tag: tags.Logo }) : null,
      numbered: true,
      name: item.Name,
      overview: item.Overview,
      meta: [item.ProductionYear, runtime(item.RunTimeTicks), rating ? item.OfficialRating : null].filter(Boolean).join(" · "),
      progress: item.UserData?.PlayedPercentage,
      played: item.UserData?.Played,
      action: { icon: "play_arrow", label: `Play ${item.Name}`, run: () => play(item).catch(console.error) },
    });
    card.dataset.date = dateOf(item);
    return card;
  };

  // What hera-seerr.js needs to put a missing film on the shelf: the shelf, its head (for the
  // Request button) and a way to place a card by release date. Cards without a date go last.
  // A page keeps one handle: a redraw points it at the new section, so whatever holds the handle
  // (a Request in flight, a Seerr fetch still loading) lands on the shelf that is on screen.
  const boxSetHandle = (section, shelf) => {
    const handle = {
      section,
      shelf,
      head: section.querySelector(".hera-seasons__head"),
      adopt(nextSection, nextShelf) {
        handle.section = nextSection;
        handle.shelf = nextShelf;
        handle.head = nextSection.querySelector(".hera-seasons__head");
      },
      // Up to three films fill the width between them; four or more make an ordinary shelf.
      refit() {
        const count = handle.shelf.children.length;
        handle.shelf.toggleAttribute("data-few", count < 4);
        handle.shelf.style.setProperty("--hera-few", String(Math.max(2, count)));
      },
      place(card, date) {
        card.dataset.date = date || "";
        const after = date ? [...handle.shelf.children].find((other) => !other.dataset.date || other.dataset.date > date) : null;
        handle.shelf.insertBefore(card, after ?? null);
        handle.refit();
      },
      // Scrolls the next film into view when it would start off the right edge, as a season
      // shelf opens on the episode you're up to.
      reveal() {
        const next = handle.shelf.querySelector(".is-current");
        if (!next) return;
        const x = next.offsetLeft - handle.shelf.offsetLeft;
        if (x + next.offsetWidth <= handle.shelf.clientWidth) return;
        handle.shelf.scrollTo({ left: x, behavior: "instant" });
      },
    };
    return handle;
  };

  const fitBoxSetMeta = (page, items, noun) => {
    const parts = [...page.querySelectorAll(".itemMiscInfo-primary .mediaInfoItem")];
    const count = parts.find((part) => /^\d+ items?$/.test(part.textContent.trim()));
    if (count) count.textContent = `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
    const years = items.map((item) => item.ProductionYear).filter(Boolean);
    const year = parts.find((part) => /^\d{4}$/.test(part.textContent.trim()));
    if (!year || !years.length) return;
    const first = Math.min(...years);
    const last = Math.max(...years);
    year.textContent = first === last ? String(first) : `${first}–${last}`;
    if (noun !== "film" || year.nextElementSibling?.classList.contains("hera-boxset-runtime")) return;
    const total = runtime(items.reduce((sum, item) => sum + (item.RunTimeTicks || 0), 0));
    if (total) year.after(el("div", { class: "mediaInfoItem hera-boxset-runtime", text: total }));
  };

  // The banner's Play names the film it starts, as Apple TV's names the episode.
  const labelBoxSetPlay = (page, next) => {
    const button = page.querySelector(".mainDetailButtons .btnPlay");
    const content = button?.querySelector(".detailButton-content");
    if (!content) return;
    const verb = next.UserData?.PlaybackPositionTicks > 0 && !next.UserData?.Played ? "Resume" : "Play";
    content.dataset.heraLabel = `${verb} ${next.Name}`;
    button.setAttribute("aria-label", `${verb} ${next.Name}`);
    button.title = `${verb} ${next.Name}`;
  };

  const buildBoxSet = async (page, itemId, previous) => {
    const item = await api().getItem(userId(), itemId);
    if (item?.Type !== "BoxSet") return null;
    const result = await getJSON(`Users/${userId()}/Items`, {
      ParentId: itemId,
      SortBy: "PremiereDate,ProductionYear,SortName",
      SortOrder: "Ascending",
      Fields: "Overview,PremiereDate,OfficialRating",
    });
    // Jellyfin sorts films without a date first; they belong at the end of the order.
    const all = result?.Items ?? [];
    const items = [...all.filter((child) => dateOf(child)), ...all.filter((child) => !dateOf(child))];
    const drawn = page.querySelector(".hera-boxset");
    if (!items.length || itemIdFromHash() !== itemId || (drawn && drawn.dataset.item !== itemId)) return null;

    const films = items.every((child) => child.Type === "Movie");
    const shows = items.every((child) => child.Type === "Series");
    const title = films ? "Films" : shows ? "TV Shows" : "In This Collection";
    const next = nextInOrder(items);
    // One certificate for the lot is already in the banner's meta; per film only when they differ.
    const rating = new Set(items.map((child) => child.OfficialRating || "")).size > 1;
    const shelf = el("div", { class: "hera-shelf", "aria-label": title });
    for (const child of items) {
      const card = filmCard(child, { rating });
      if (child === next) card.classList.add("is-current");
      shelf.append(card);
    }
    const section = el("section", { class: "hera-boxset verticalSection", "aria-label": title, "data-item": itemId }, [
      el("div", { class: "hera-seasons__head" }, el("h2", { class: "hera-seasons__title", text: title })),
      shelf,
    ]);
    const primary = page.querySelector(".detailPagePrimaryContent");
    if (!primary) return null;
    // Coming back to the page redraws the shelf in place (watched films, the next one, Play), so
    // nothing jumps; what hera-seerr.js added (missing films, Request) moves across with it, and
    // so do the shelf's scroll and the remote's focus.
    const stale = page.querySelector(".hera-boxset");
    const handle = stale && previous ? previous : boxSetHandle(section, shelf);
    if (stale) {
      const left = stale.querySelector(".hera-shelf")?.scrollLeft ?? 0;
      const focused = stale.contains(document.activeElement) ? document.activeElement : null;
      const focusedHref = focused?.getAttribute("href");
      handle.adopt(section, shelf);
      for (const card of stale.querySelectorAll('.hera-shelf > [data-hera-seerr="collection"]')) handle.place(card, card.dataset.date);
      for (const node of stale.querySelectorAll('.hera-seasons__head > [data-hera-seerr="collection"]')) handle.head.append(node);
      for (const node of stale.querySelectorAll(':scope > [data-hera-seerr="collection"]')) section.append(node);
      handle.refit();
      stale.replaceWith(section);
      shelf.scrollTo({ left, behavior: "instant" });
      const refocus = focusedHref ? shelf.querySelector(`a[href="${CSS.escape(focusedHref)}"]`) : focused?.isConnected ? focused : null;
      refocus?.focus({ preventScroll: true });
    } else {
      handle.refit();
      primary.insertBefore(section, primary.firstChild);
      handle.reveal();
    }
    page.classList.add("hera-has-boxset");
    fitBoxSetMeta(page, items, films ? "film" : shows ? "TV show" : "title");
    page.heraBoxSetNext = next;
    labelBoxSetPlay(page, next);
    if (!page.heraBoxSetPlay) {
      page.heraBoxSetPlay = true;
      // Jellyfin's Play on a collection plays every film from the first; Hera's starts the next.
      page.addEventListener(
        "click",
        (event) => {
          const button = event.target.closest?.(".mainDetailButtons .btnPlay");
          if (!button || !page.heraBoxSetNext || !page.classList.contains("hera-has-boxset")) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          play(page.heraBoxSetNext).catch(console.error);
        },
        true,
      );
    }
    return handle;
  };

  const mountBoxSet = (page, itemId) => {
    const known = boxSets.get(page);
    // Same collection: reuse what is drawing or was drawn a moment ago (a show of the page runs
    // this twice); otherwise draw again, in place, so a page Jellyfin brings back is current.
    if (known?.itemId === itemId && (!known.settled || (Date.now() - known.at < 2000 && known.handle?.section.isConnected))) return known.ready;
    const same = known?.itemId === itemId;
    if (!same) {
      page.querySelector(".hera-boxset")?.remove();
      page.classList.remove("hera-has-boxset");
      page.heraBoxSetNext = null;
    }
    const entry = { itemId, settled: false, handle: null };
    entry.ready = buildBoxSet(page, itemId, same ? known.handle : null)
      .catch((error) => {
        console.error("[Hera TV]", error);
        return null;
      })
      .then((handle) => {
        entry.settled = true;
        entry.at = Date.now();
        entry.handle = handle;
        return handle;
      });
    boxSets.set(page, entry);
    return entry.ready;
  };

  /** The collection shelf on `page` for `itemId` once it is drawn, or null if there is none. */
  const collectionShelf = (page, itemId) => {
    const known = boxSets.get(page);
    return known?.itemId === itemId ? known.ready : Promise.resolve(null);
  };

  // ---------- detail pages --------------------------------------------------------------

  // The banner needs artwork even when the user's "details banner" setting is off.
  // Jellyfin resolves an episode's or season's backdrop to the nearest ancestor that has one, and
  // a season's is often the studio's key art with the title baked in. Under Hera's own logo that
  // prints the title twice, so episodes and seasons take their series' backdrop instead, and fall
  // back to their own only when the series has none.
  const bannerArt = async (item) => {
    const series = item.SeriesId && (item.Type === "Episode" || item.Type === "Season") ? await api().getItem(userId(), item.SeriesId) : null;
    if (series?.BackdropImageTags?.length) return { id: series.Id, tag: series.BackdropImageTags[0] };
    if (item.BackdropImageTags?.length) return { id: item.Id, tag: item.BackdropImageTags[0] };
    if (item.ParentBackdropImageTags?.length) return { id: item.ParentBackdropItemId, tag: item.ParentBackdropImageTags[0] };
    return null;
  };

  // Paints the banner and the ambient ground from a { banner, ambient } pair of image URLs.
  const paintBanner = (page, banner, itemId, urls) => {
    page.classList.remove("hera-no-backdrop");
    root.classList.add("hera-art-top");
    banner.dataset.heraFilled = itemId;
    banner.style.backgroundImage = `url("${urls.banner}")`;
    banner.dataset.heraAmbient = urls.ambient;
    ambient.show(urls.ambient);
  };

  const fillBanner = async (page, itemId) => {
    const banner = page.querySelector("#itemBackdrop");
    if (!banner) return;
    if (banner.dataset.heraFilled === itemId) {
      // Back on a page already drawn: the ambient may be showing another title's art.
      if (banner.dataset.heraAmbient) ambient.show(banner.dataset.heraAmbient);
      return;
    }
    // Jellyfin drew its own banner (mobile layout): leave it.
    if (!banner.dataset.heraFilled && /url\(/.test(getComputedStyle(banner).backgroundImage)) {
      page.classList.remove("hera-no-backdrop");
      root.classList.add("hera-art-top");
      return;
    }
    // Known art (this item, or the series of an episode or season the shelf has shown) paints
    // in the page's first frame; the lookup below only confirms or corrects it.
    const hint = itemHints.get(itemId);
    const known = artCache.get(itemId) ?? (hint?.SeriesId ? artCache.get(hint.SeriesId) : null);
    if (known) paintBanner(page, banner, itemId, known);
    const item = await api().getItem(userId(), itemId);
    if (itemIdFromHash() !== itemId) return;
    page.classList.toggle("hera-person", item?.Type === "Person");
    const art = item ? await bannerArt(item) : null;
    if (itemIdFromHash() !== itemId) return;
    if (!art) {
      // No artwork (people, books, bare collections): no banner; the portrait or cover shows.
      page.classList.add("hera-no-backdrop");
      root.classList.remove("hera-art-top");
      banner.dataset.heraFilled = itemId;
      banner.style.backgroundImage = "";
      ambient.hide();
      return;
    }
    const width = Math.min(2560, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
    // The page below the banner rests on the same art (one source for series, season and
    // episode alike), not on Jellyfin's page backdrop, which follows the season's key art.
    const urls = {
      banner: imageUrl(art.id, "Backdrop", { maxWidth: width, tag: art.tag }),
      ambient: imageUrl(art.id, "Backdrop", { maxWidth: 960, tag: art.tag }),
    };
    artCache.set(itemId, urls);
    if (item.SeriesId && art.id === item.SeriesId) artCache.set(item.SeriesId, urls);
    if (banner.style.backgroundImage !== `url("${urls.banner}")`) paintBanner(page, banner, itemId, urls);
  };

  // Series, season, episode and film pages differ in how much sits over the banner (a title, a
  // meta line, an overview of one to three lines, buttons). The ribbon is pulled up by exactly its
  // own height plus a fixed foot, so the buttons land the same distance above the banner's edge
  // on every one of them. --hera-ribbon-h feeds --hera-detail-overlay in hera-tv.css.
  const ribbonObservers = new WeakMap();
  // A new page starts from the last page's height, which for the next episode of the same show
  // is almost always right, instead of from a half-built ribbon (title only, no buttons yet).
  let lastRibbonHeight = 0;
  const fitRibbon = (page) => {
    const ribbon = page.querySelector(".detailRibbon");
    if (!ribbon || ribbonObservers.has(ribbon)) return;
    if (lastRibbonHeight && !page.style.getPropertyValue("--hera-ribbon-h")) {
      page.style.setProperty("--hera-ribbon-h", `${lastRibbonHeight}px`);
    }
    const measure = () => {
      // Until Jellyfin has drawn the buttons the ribbon is incomplete; measuring it then would
      // pull the content up and drop it again a moment later.
      const buttons = ribbon.querySelector(".mainDetailButtons");
      if (!buttons || buttons.offsetHeight === 0) return;
      const parts = [...ribbon.children].filter((child) => child.offsetParent !== null && child.offsetHeight > 0);
      if (!parts.length) return;
      const top = parts[0].getBoundingClientRect().top;
      const bottom = Math.max(...parts.map((part) => part.getBoundingClientRect().bottom));
      const height = Math.ceil(bottom - top);
      if (height <= 0) return;
      lastRibbonHeight = height;
      if (page.style.getPropertyValue("--hera-ribbon-h") !== `${height}px`) {
        page.style.setProperty("--hera-ribbon-h", `${height}px`);
      }
    };
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    const watch = () => [...ribbon.children].forEach((child) => observer.observe(child));
    watch();
    // Jellyfin swaps the ribbon's children between items; keep watching the new ones.
    const children = new MutationObserver(watch);
    children.observe(ribbon, { childList: true });
    ribbonObservers.set(ribbon, observer);
    state.cleanups.push(() => {
      observer.disconnect();
      children.disconnect();
      ribbonObservers.delete(ribbon);
      page.style.removeProperty("--hera-ribbon-h");
    });
    measure();
  };

  // The synopsis belongs with the title and buttons, over the artwork, as on tvOS; the stock
  // copy further down is hidden while ours is in place.
  const mountOverview = async (page, itemId) => {
    const info = page.querySelector(".detailRibbon .infoWrapper");
    if (!info) return;
    const existing = info.querySelector(".hera-detail-overview");
    if (existing?.dataset.item === itemId) return;
    existing?.remove();
    page.classList.remove("hera-has-overview");
    const item = await api().getItem(userId(), itemId);
    if (!item?.Overview || itemIdFromHash() !== itemId) return;
    // A second call may have finished first while this one waited.
    info.querySelector(".hera-detail-overview")?.remove();
    const text = el("p", { class: "hera-detail-overview", "data-item": itemId, text: item.Overview });
    info.append(text);
    page.classList.add("hera-has-overview");
  };

  // One observer per logo element: Jellyfin reuses the page, and onView runs on every show.
  const logoObservers = new WeakMap();
  const markLogo = (page) => {
    const logo = page.querySelector(".detailLogo");
    const update = () => {
      const has = !!logo && !logo.classList.contains("hide") && /url\(/.test(logo.style.backgroundImage || "");
      page.classList.toggle("hera-has-logo", has);
    };
    update();
    if (logo && !logoObservers.has(logo)) {
      const observer = new MutationObserver(update);
      observer.observe(logo, { attributes: true, attributeFilter: ["style", "class"] });
      logoObservers.set(logo, observer);
      state.cleanups.push(() => {
        observer.disconnect();
        logoObservers.delete(logo);
      });
    }
  };

  // ---------- control center ------------------------------------------------------------
  // The profile button opens a tvOS-style Control Center instead of Jellyfin's menu: who is
  // signed in, the playback preferences people actually change, Quick Connect for signing in a
  // TV, what is playing elsewhere, and (for admins) a library scan. "All options" opens the
  // stock menu, so nothing Jellyfin or another plugin adds to it is lost.

  const SUBTITLE_MODES = [
    ["Smart", "Smart"],
    ["Always", "Always on"],
    ["OnlyForced", "Forced only"],
    ["None", "Off"],
    ["Default", "Default"],
  ];

  const isProfileButton = (target) =>
    target.closest?.(".MuiAppBar-root > .MuiToolbar-root:first-child > .MuiBox-root:last-child button, .headerUserButton");

  const controlCenter = {
    dialog: null,
    bypass: false,
    user: null,

    async open(trigger) {
      this.trigger = trigger;
      this.user = await api().getCurrentUser();
      this.dialog?.remove();
      this.dialog = this.render();
      document.body.append(this.dialog);
      this.dialog.showModal();
      this.refreshSessions().catch(console.error);
    },

    close() {
      if (!this.dialog) return;
      this.dialog.close();
    },

    async saveConfig(change) {
      const user = await api().getCurrentUser();
      const config = { ...user.Configuration, ...change };
      await api().updateUserConfiguration(user.Id, config);
      this.user = { ...user, Configuration: config };
    },

    tile({ icon: name, label, value, pressed, onclick }) {
      const valueNode = el("span", { class: "hera-cc__tile-value", text: value });
      const button = el(
        "button",
        {
          type: "button",
          class: "hera-cc__tile",
          "aria-pressed": pressed === undefined ? undefined : String(pressed),
        },
        [icon(name), el("span", { class: "hera-cc__tile-label", text: label }), valueNode],
      );
      button.addEventListener("click", () => onclick(button, valueNode));
      return button;
    },

    render() {
      const user = this.user;
      const config = user.Configuration || {};
      const admin = !!user.Policy?.IsAdministrator;

      const avatar = user.PrimaryImageTag
        ? el("img", {
            class: "hera-cc__avatar",
            alt: "",
            src: api().getUrl(`Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: 160, quality: 90 }),
          })
        : el("span", { class: "hera-cc__avatar", "aria-hidden": "true", text: (user.Name || "?").slice(0, 1).toUpperCase() });

      const subtitleIndex = Math.max(0, SUBTITLE_MODES.findIndex(([mode]) => mode === config.SubtitleMode));
      const tiles = [
        this.tile({
          icon: "closed_caption",
          label: "Subtitles",
          value: SUBTITLE_MODES[subtitleIndex][1],
          pressed: config.SubtitleMode !== "None",
          onclick: async (button, value) => {
            const current = SUBTITLE_MODES.findIndex(([mode]) => mode === this.user.Configuration.SubtitleMode);
            const [mode, text] = SUBTITLE_MODES[(Math.max(0, current) + 1) % SUBTITLE_MODES.length];
            await this.saveConfig({ SubtitleMode: mode });
            value.textContent = text;
            button.setAttribute("aria-pressed", String(mode !== "None"));
          },
        }),
        this.tile({
          icon: "skip_next",
          label: "Autoplay",
          value: config.EnableNextEpisodeAutoPlay ? "Next episode" : "Off",
          pressed: !!config.EnableNextEpisodeAutoPlay,
          onclick: async (button, value) => {
            const next = !this.user.Configuration.EnableNextEpisodeAutoPlay;
            await this.saveConfig({ EnableNextEpisodeAutoPlay: next });
            value.textContent = next ? "Next episode" : "Off";
            button.setAttribute("aria-pressed", String(next));
          },
        }),
        this.tile({
          icon: appearance.scheme() === "light" ? "light_mode" : "dark_mode",
          label: "Appearance",
          value: appearance.label(),
          onclick: async (button, value) => {
            const index = APPEARANCES.findIndex(([key]) => key === appearance.pref);
            const [next] = APPEARANCES[(index + 1) % APPEARANCES.length];
            await appearance.set(next);
            value.textContent = appearance.label();
            button.querySelector(".material-icons").textContent = appearance.scheme() === "light" ? "light_mode" : "dark_mode";
          },
        }),
        this.tile({
          icon: "new_releases",
          label: "Recently Added",
          value: config.HidePlayedInLatest ? "Unwatched only" : "Everything",
          pressed: !!config.HidePlayedInLatest,
          onclick: async (button, value) => {
            const next = !this.user.Configuration.HidePlayedInLatest;
            await this.saveConfig({ HidePlayedInLatest: next });
            value.textContent = next ? "Unwatched only" : "Everything";
            button.setAttribute("aria-pressed", String(next));
          },
        }),
        admin
          ? this.tile({
              icon: "sync",
              label: "Libraries",
              value: "Scan for new media",
              onclick: async (button, value) => {
                button.disabled = true;
                value.textContent = "Scanning…";
                await api().ajax({ type: "POST", url: api().getUrl("Library/Refresh") });
                value.textContent = "Scan started";
              },
            })
          : null,
      ];

      // Quick Connect: a TV or phone app shows a six-digit code; entering it here signs that
      // device in as this user, which is how SSO accounts reach native apps.
      const codeInput = el("input", {
        class: "hera-cc__code",
        type: "text",
        inputmode: "numeric",
        autocomplete: "one-time-code",
        maxlength: "6",
        pattern: "[0-9]{6}",
        placeholder: "000000",
        "aria-label": "Quick Connect code",
        "aria-describedby": "hera-cc-qc-status",
      });
      const qcStatus = el("p", {
        class: "hera-cc__status",
        id: "hera-cc-qc-status",
        role: "status",
        text: "Enter the code a TV or phone shows to sign it in as you.",
      });
      const qcForm = el("form", { class: "hera-cc__qc" }, [
        codeInput,
        el("button", { type: "submit", class: "hera-btn hera-btn--primary hera-cc__qc-submit", text: "Sign In" }),
      ]);
      qcForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = codeInput.value.trim();
        if (!/^\d{6}$/.test(code)) {
          qcStatus.textContent = "The code is six digits.";
          codeInput.focus();
          return;
        }
        try {
          await api().ajax({ type: "POST", url: api().getUrl("QuickConnect/Authorize", { code }) });
          qcStatus.textContent = "Signed in. The device continues on its own.";
          codeInput.value = "";
        } catch {
          qcStatus.textContent = "That code has expired or was mistyped. Ask the device for a new one.";
        }
      });

      this.sessionList = el("ul", { class: "hera-cc__sessions", "aria-live": "polite" });

      const link = (href, name, text) =>
        el("a", { class: "hera-cc__link", href, onclick: () => this.close() }, [icon(name), el("span", { text })]);
      const links = el("nav", { class: "hera-cc__links", "aria-label": "Account" }, [
        link(`#/userprofile?userId=${user.Id}`, "person", "Profile"),
        link("#/mypreferencesmenu", "settings", "Settings"),
        admin ? link("#/dashboard", "dashboard", "Dashboard") : null,
        el(
          "button",
          {
            type: "button",
            class: "hera-cc__link",
            onclick: () => {
              this.close();
              // Open Jellyfin's own menu once, for anything a plugin adds there.
              this.bypass = true;
              this.trigger?.click();
              this.bypass = false;
            },
          },
          [icon("more_horiz"), el("span", { text: "All options" })],
        ),
      ]);
      // Requests (hera-activity.js) are for people who can request and administrators who watch the queue.
      integrations().then((ints) => {
        if (window.HeraTV?.activity?.requestsAvailable(ints)) {
          links.firstElementChild?.after(link(window.HeraTV.activity.hash, "playlist_add_check", "Requests"));
        }
      });

      const dialog = el("dialog", { class: "hera-cc", "aria-label": "Control Center" }, [
        el("div", { class: "hera-cc__panel" }, [
          el("header", { class: "hera-cc__profile" }, [
            avatar,
            el("div", { class: "hera-cc__who" }, [
              el("p", { class: "hera-cc__name", text: user.Name }),
              el("p", { class: "hera-cc__role", text: admin ? "Administrator" : "Member" }),
            ]),
            el(
              "button",
              {
                type: "button",
                class: "hera-btn hera-btn--glass hera-cc__signout",
                "aria-label": "Sign out",
                title: "Sign out",
                onclick: () => {
                  this.close();
                  window.Dashboard?.logout?.();
                },
              },
              icon("logout"),
            ),
          ]),
          el("div", { class: "hera-cc__tiles" }, tiles),
          el("section", { class: "hera-cc__group", "aria-labelledby": "hera-cc-qc" }, [
            el("h2", { class: "hera-cc__heading", id: "hera-cc-qc", text: "Quick Connect" }),
            qcForm,
            qcStatus,
          ]),
          el("section", { class: "hera-cc__group", "aria-labelledby": "hera-cc-now" }, [
            el("h2", { class: "hera-cc__heading", id: "hera-cc-now", text: "Watching Now" }),
            this.sessionList,
          ]),
          links,
        ]),
      ]);
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) this.close();
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (this.dialog === dialog) this.dialog = null;
        this.trigger?.focus?.();
      });
      return dialog;
    },

    async refreshSessions() {
      const list = this.sessionList;
      const sessions = (await getJSON("Sessions", { activeWithinSeconds: 960 })) ?? [];
      const own = api().deviceId();
      const playing = sessions.filter((s) => s.NowPlayingItem && s.DeviceId !== own);
      if (!list.isConnected) return;
      if (!playing.length) {
        list.replaceChildren(el("li", { class: "hera-cc__empty", text: "Nothing is playing on other devices." }));
        return;
      }
      list.replaceChildren(
        ...playing.map((s) => {
          const item = s.NowPlayingItem;
          const title = item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name;
          const percent = item.RunTimeTicks ? Math.round(((s.PlayState?.PositionTicks || 0) / item.RunTimeTicks) * 100) : 0;
          return el("li", { class: "hera-cc__session" }, [
            el("span", { class: "hera-cc__session-title", text: title }),
            el("span", {
              class: "hera-cc__session-meta",
              text: `${s.UserName || "Someone"} · ${s.DeviceName}${s.PlayState?.IsPaused ? " · Paused" : ""}`,
            }),
            el("span", { class: "hera-cc__session-progress" }, el("span", { style: `width:${percent}%` })),
          ]);
        }),
      );
    },
  };

  const onProfileClick = (e) => {
    const button = isProfileButton(e.target);
    if (!button || controlCenter.bypass || !api() || !userId()) return;
    e.preventDefault();
    e.stopPropagation();
    controlCenter.open(button).catch((error) => {
      console.error("[Hera TV]", error);
      controlCenter.bypass = true;
      button.click();
      controlCenter.bypass = false;
    });
  };

  // ---------- routing --------------------------------------------------------------------

  const itemIdFromHash = () => new URLSearchParams(window.location.hash.split("?")[1] || "").get("id");

  // The scroll-edge layer under the bar (body::after in hera-tv.css) is as tall as the bar that
  // is showing: 64px, more with a library page's toolbar, or the TV layout's own header.
  const measureBar = () => {
    const bar = [...document.querySelectorAll(".MuiAppBar-root, .skinHeader")].find((node) => node.offsetHeight > 0);
    if (bar) root.style.setProperty("--hera-bar-h", `${Math.round(bar.offsetHeight)}px`);
  };

  // Jellyfin can show the home page before its home tab has drawn the sections container (coming
  // back from another page through the header's Home link, or from Favourites). The hero and
  // every home row hang off that container, so the page runs again once it exists.
  const homeWait = { observer: null, timer: 0 };
  const stopHomeWait = () => {
    homeWait.observer?.disconnect();
    homeWait.observer = null;
    clearTimeout(homeWait.timer);
  };
  const waitForHomeSections = (page) => {
    stopHomeWait();
    homeWait.observer = new MutationObserver(() => {
      if (!page.querySelector("#homeTab .homeSectionsContainer")) return;
      stopHomeWait();
      if (!page.classList.contains("hide")) onView(page);
    });
    homeWait.observer.observe(page, { childList: true, subtree: true });
    homeWait.timer = setTimeout(stopHomeWait, 10000);
  };

  const onView = async (page) => {
    if (!api() || !userId()) return;
    root.dataset.heraView = page.id || "";
    // The page's toolbar renders a moment after the page shows.
    requestAnimationFrame(measureBar);
    setTimeout(measureBar, 400);
    const isHome = page.id === "indexPage";
    stopHomeWait();
    if (isHome && !page.querySelector("#homeTab .homeSectionsContainer")) waitForHomeSections(page);
    if (!isHome) root.classList.remove("hera-home");
    if (page.id !== "itemDetailPage") root.classList.remove("hera-art-top");
    try {
      if (isHome) await mountHero(page);
      if (page.id === "itemDetailPage") {
        markLogo(page);
        fitRibbon(page);
        const id = itemIdFromHash();
        if (id) {
          fillBanner(page, id).catch(console.error);
          mountOverview(page, id).catch(console.error);
          await mountSeasons(page, id);
          // A page Jellyfin brings back from its cache keeps its shelf, so mountSeasons returns
          // early; the reader's place is restored here instead.
          restoreShelfPlace(page);
          await mountBoxSet(page, id);
        }
      }
    } catch (error) {
      console.error("[Hera TV]", error);
    }
    // Modules see every page after the built-ins; one failing never stops the others.
    const context = { itemId: itemIdFromHash(), params: new URLSearchParams(window.location.hash.split("?")[1] || "") };
    for (const module of modules) {
      try {
        await module.onView?.(page, context);
      } catch (error) {
        console.error(`[Hera TV:${module.name}]`, error);
      }
    }
  };

  const onViewShow = (event) => {
    const page = event.target?.closest?.(".page") || event.target;
    if (page instanceof HTMLElement) onView(page);
  };

  // Series pages re-render their sections after the first viewshow; a late mount catches that.
  const onHash = () => {
    setTimeout(() => {
      const page = document.querySelector(".page:not(.hide)");
      if (page) onView(page);
    }, 400);
  };

  // ---------- British copy -------------------------------------------------------------
  // Jellyfin's React header, its menus and its section titles name things in American English
  // ("Movies", "Favorites", "Shows"), and a CSS ::after cannot tell one title from another. Rewrite
  // those exact words where Jellyfin draws them, and again when it redraws them.

  const BRITISH = new Map([
    ["Movies", "Films"],
    ["Shows", "TV Shows"],
    ["Favorites", "Favourites"],
  ]);
  const localiseCopy = () => {
    for (const node of document.querySelectorAll(".MuiAppBar-root .MuiTypography-h2, #library-view-menu li, .page:not(.hide) h2.sectionTitle")) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const next = BRITISH.get(text.nodeValue.trim());
        if (next) text.nodeValue = next;
      }
    }
  };
  const watchCopy = () => {
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        localiseCopy();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    localiseCopy();
    state.cleanups.push(() => observer.disconnect());
  };

  const start = async () => {
    keepStylesheetLast();
    watchCopy();
    appearance.apply();
    const onDeviceScheme = () => appearance.pref === "auto" && appearance.apply();
    lightQuery?.addEventListener?.("change", onDeviceScheme);
    state.cleanups.push(() => lightQuery?.removeEventListener?.("change", onDeviceScheme));
    const onScroll = () => {
      const scrolled = window.scrollY > 24;
      if (scrolled && !root.classList.contains("hera-scrolled")) measureBar();
      root.classList.toggle("hera-scrolled", scrolled);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    state.cleanups.push(() => window.removeEventListener("scroll", onScroll));
    onScroll();
    try {
      const response = await fetch(new URL("../HeraTV/config", document.baseURI));
      if (response.ok) state.config = { ...state.config, ...(await response.json()) };
    } catch {
      /* defaults stand */
    }
    document.addEventListener("viewshow", onViewShow);
    // Capture phase, so the profile button's own menu never opens underneath.
    document.addEventListener("click", onProfileClick, true);
    state.cleanups.push(() => document.removeEventListener("click", onProfileClick, true));
    state.cleanups.push(() => controlCenter.dialog?.remove());
    window.addEventListener("hashchange", onHash);
    state.cleanups.push(() => document.removeEventListener("viewshow", onViewShow));
    state.cleanups.push(() => window.removeEventListener("hashchange", onHash));

    // The first page may already be showing when we arrive.
    const waitForApi = setInterval(() => {
      if (!api() || !userId()) return;
      appearance.load().catch(() => {});
      getJSON("System/Info/Public")
        .then((info) => info?.ServerName && root.style.setProperty("--hera-server", JSON.stringify(info.ServerName)))
        .catch(() => {});
      clearInterval(waitForApi);
      onHash();
    }, 250);
    state.cleanups.push(() => clearInterval(waitForApi));
  };

  window.HeraTV = {
    kit: {
      api,
      userId,
      el,
      icon,
      getJSON,
      imageUrl,
      runtime,
      shuffle,
      go,
      play,
      hera,
      integrations,
      card,
      shelf,
      mountRow,
      shelfCard,
      collectionShelf,
      shortDate,
      itemIdFromHash,
      reduceMotion,
      appearance,
      appearances: APPEARANCES,
      isTv: () => root.classList.contains("layout-tv"),
    },
    /** Adds a module: `{ name, onView(page, { itemId, params }), teardown() }`. */
    register(module) {
      modules.push(module);
      // A module that arrives after the first page still sees it.
      const page = document.querySelector(".page:not(.hide)");
      if (page && api() && userId()) {
        Promise.resolve()
          .then(() => module.onView?.(page, { itemId: itemIdFromHash(), params: new URLSearchParams(window.location.hash.split("?")[1] || "") }))
          .catch((error) => console.error(`[Hera TV:${module.name}]`, error));
      }
    },
    teardown() {
      state.hero?.destroy();
      stopHomeWait();
      ambient.remove();
      heroTabObserver.observer?.disconnect();
      state.cleanups.splice(0).forEach((fn) => fn());
      modules.splice(0).forEach((module) => module.teardown?.());
      document.querySelectorAll(".hera-seasons, .hera-boxset").forEach((n) => n.remove());
      root.classList.remove("hera-home");
    },
  };

  start();
})();
