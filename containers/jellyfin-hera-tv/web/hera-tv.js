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
    button.querySelector(".material-icons").textContent = next ? "check" : "add";
    button.setAttribute("aria-label", next ? "Remove from Favourites" : "Add to Favourites");
  };

  // ---------- stylesheet order ---------------------------------------------------------
  // Jellyfin appends its theme and plugin styles after ours at runtime; keep ours last so
  // equal-specificity rules resolve in our favour without !important everywhere.

  const keepStylesheetLast = () => {
    const link = document.querySelector('link[data-hera-tv][rel="stylesheet"]');
    if (!link) return;
    let queued = false;
    const move = () => {
      queued = false;
      const custom = document.getElementById("cssBranding");
      const anchor = custom && custom.parentNode === document.head ? custom : null;
      if (anchor) {
        if (link.nextElementSibling !== anchor) document.head.insertBefore(link, anchor);
      } else if (document.head.lastElementChild !== link) {
        document.head.append(link);
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

  const loadHeroItems = async () => {
    const fresh = Date.now() - state.heroFetchedAt < 10 * 60 * 1000;
    if (state.heroItems && fresh) return state.heroItems;
    const result = await getJSON(`Users/${userId()}/Items`, {
      IncludeItemTypes: "Movie,Series",
      Recursive: true,
      ImageTypes: "Backdrop,Logo",
      IsPlayed: false,
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Limit: 40,
      Fields: "Overview,Genres,OfficialRating,CommunityRating,RunTimeTicks,ProductionYear,ChildCount,BackdropImageTags,ImageTags,UserData",
    });
    state.heroItems = shuffle(result?.Items ?? []).slice(0, state.config.heroItemCount);
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
      el("span", { text: isSeries ? "TV Programme" : "Film" }),
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
      icon(favourite ? "check" : "add"),
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
          el("div", { class: "hera-hero__actions focuscontainer-x" }, [
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
      this.node.addEventListener("focusin", hold("focus"));
      this.node.addEventListener("focusout", (e) => {
        if (!this.node.contains(e.relatedTarget)) this.holds.delete("focus");
      });
      this.node.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" && e.target.closest(".hera-hero__pager")) this.show(this.index + 1, true);
        if (e.key === "ArrowLeft" && e.target.closest(".hera-hero__pager")) this.show(this.index - 1, true);
        // Down leaves the hero for the first shelf, as on tvOS; Jellyfin's spatial navigation
        // otherwise stays among the stacked slides.
        if (e.key === "ArrowDown") {
          const page = this.node.closest(".page");
          const card = page?.querySelector(".homeSectionsContainer .verticalSection:not(.hide) .card");
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
      cancelAnimationFrame(this.frame);
      this.visibility.disconnect();
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("keydown", this.onKeyUp, true);
      this.node.remove();
    }
  }

  const mountHero = async (page) => {
    const tab = page.querySelector("#homeTab");
    const sections = tab?.querySelector(".homeSectionsContainer");
    if (!tab || !sections) return;
    root.classList.add("hera-home");
    if (state.hero && tab.contains(state.hero.node)) return;
    const items = await loadHeroItems();
    if (!items.length || !page.isConnected || page.classList.contains("hide")) {
      root.classList.remove("hera-home");
      return;
    }
    state.hero?.destroy();
    state.hero = new Hero(items);
    tab.insertBefore(state.hero.node, tab.firstChild);
    // On a TV the remote starts on Play, as tvOS starts on the hero's primary action.
    if (root.classList.contains("layout-tv") && window.scrollY < 80) {
      state.hero.node.querySelector(".hera-hero__slide.is-active .hera-btn--primary")?.focus();
    }
  };

  // ---------- series seasons ------------------------------------------------------------

  const episodeCard = (episode) => {
    const progress = episode.UserData?.PlayedPercentage;
    const played = episode.UserData?.Played;
    const still = episode.ImageTags?.Primary
      ? el("img", {
          src: imageUrl(episode.Id, "Primary", { maxWidth: 640, tag: episode.ImageTags.Primary }),
          alt: "",
          loading: "lazy",
          decoding: "async",
        })
      : null;
    const playButton = el(
      "button",
      {
        type: "button",
        class: "hera-btn hera-btn--glass hera-episode__play",
        "aria-label": `Play ${episode.Name}`,
      },
      icon("play_arrow"),
    );
    playButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      play(episode).catch(console.error);
    });
    const meta = [runtime(episode.RunTimeTicks), episode.PremiereDate ? new Date(episode.PremiereDate).getFullYear() : null]
      .filter(Boolean)
      .join(" · ");
    return el(
      "a",
      {
        class: `hera-episode${played ? " is-played" : ""}`,
        href: `#/details?id=${episode.Id}`,
      },
      [
        el("span", { class: "hera-episode__still" }, [
          still,
          progress && !played
            ? el("span", { class: "hera-episode__progress" }, el("span", { style: `width:${Math.max(3, progress)}%` }))
            : null,
          playButton,
        ]),
        el("p", { class: "hera-episode__name" }, [
          episode.IndexNumber != null ? el("b", { text: String(episode.IndexNumber) }) : null,
          document.createTextNode(episode.Name),
        ]),
        episode.Overview ? el("p", { class: "hera-episode__overview", text: episode.Overview }) : null,
        meta ? el("p", { class: "hera-episode__meta", text: meta }) : null,
      ],
    );
  };

  const mountSeasons = async (page, itemId) => {
    const existing = page.querySelector(".hera-seasons");
    if (existing?.dataset.item === itemId) return;
    existing?.remove();
    page.classList.remove("hera-has-seasons");
    const item = await api().getItem(userId(), itemId);
    if (item?.Type !== "Series") return;
    const [seasonsResult, nextUp] = await Promise.all([
      getJSON(`Shows/${itemId}/Seasons`, { userId: userId() }),
      getJSON("Shows/NextUp", { seriesId: itemId, userId: userId(), limit: 1 }),
    ]);
    const seasons = seasonsResult?.Items ?? [];
    if (!seasons.length || page.querySelector(".hera-seasons") || itemIdFromHash() !== itemId) return;

    const nextSeasonId = nextUp?.Items?.[0]?.SeasonId;
    const startIndex = Math.max(0, seasons.findIndex((s) => s.Id === nextSeasonId));
    const shelf = el("div", { class: "hera-shelf", role: "tabpanel" });
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

    const cache = new Map();
    const select = async (i) => {
      tabs.forEach((tab, j) => tab.setAttribute("aria-selected", String(i === j)));
      shelf.setAttribute("aria-label", seasons[i].Name);
      const season = seasons[i];
      if (!cache.has(season.Id)) {
        cache.set(
          season.Id,
          getJSON(`Shows/${itemId}/Episodes`, {
            seasonId: season.Id,
            userId: userId(),
            Fields: "Overview,PremiereDate",
          }),
        );
      }
      const result = await cache.get(season.Id);
      if (tabs[i].getAttribute("aria-selected") !== "true") return;
      shelf.replaceChildren(...(result?.Items ?? []).map(episodeCard));
      const nextId = nextUp?.Items?.[0]?.Id;
      const target = nextId && shelf.querySelector(`a[href$="${nextId}"]`);
      shelf.scrollTo({ left: target ? target.offsetLeft - shelf.offsetLeft - 0 : 0, behavior: "instant" });
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

  // ---------- detail pages --------------------------------------------------------------

  // The banner needs artwork even when the user's "details banner" setting is off: use the
  // item's own backdrop, else its series' or parent's.
  const fillBanner = async (page, itemId) => {
    const banner = page.querySelector("#itemBackdrop");
    if (!banner || banner.dataset.heraFilled === itemId) return;
    // Jellyfin drew its own banner (the user's setting is on): leave it.
    if (!banner.dataset.heraFilled && /url\(/.test(getComputedStyle(banner).backgroundImage)) return;
    const item = await api().getItem(userId(), itemId);
    let id = null;
    let tag = null;
    if (item?.BackdropImageTags?.length) {
      id = item.Id;
      tag = item.BackdropImageTags[0];
    } else if (item?.ParentBackdropImageTags?.length) {
      id = item.ParentBackdropItemId;
      tag = item.ParentBackdropImageTags[0];
    }
    if (!id) return;
    const width = Math.min(2560, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
    banner.style.backgroundImage = `url("${imageUrl(id, "Backdrop", { maxWidth: width, tag })}")`;
    banner.dataset.heraFilled = itemId;
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
    const text = el("p", { class: "hera-detail-overview", "data-item": itemId, text: item.Overview });
    info.append(text);
    page.classList.add("hera-has-overview");
  };

  const markLogo = (page) => {
    const logo = page.querySelector(".detailLogo");
    const update = () => {
      const has = !!logo && !logo.classList.contains("hide") && /url\(/.test(logo.style.backgroundImage || "");
      page.classList.toggle("hera-has-logo", has);
    };
    update();
    if (logo) {
      const observer = new MutationObserver(update);
      observer.observe(logo, { attributes: true, attributeFilter: ["style", "class"] });
      state.cleanups.push(() => observer.disconnect());
    }
  };

  // ---------- routing --------------------------------------------------------------------

  const itemIdFromHash = () => new URLSearchParams(window.location.hash.split("?")[1] || "").get("id");

  const onView = async (page) => {
    if (!api() || !userId()) return;
    root.dataset.heraView = page.id || "";
    const isHome = page.id === "indexPage";
    if (!isHome) root.classList.remove("hera-home");
    try {
      if (isHome) await mountHero(page);
      if (page.id === "itemDetailPage") {
        markLogo(page);
        const id = itemIdFromHash();
        if (id) {
          fillBanner(page, id).catch(console.error);
          mountOverview(page, id).catch(console.error);
          await mountSeasons(page, id);
        }
      }
    } catch (error) {
      console.error("[Hera TV]", error);
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

  const start = async () => {
    keepStylesheetLast();
    const onScroll = () => root.classList.toggle("hera-scrolled", window.scrollY > 24);
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
    window.addEventListener("hashchange", onHash);
    state.cleanups.push(() => document.removeEventListener("viewshow", onViewShow));
    state.cleanups.push(() => window.removeEventListener("hashchange", onHash));

    // The first page may already be showing when we arrive.
    const waitForApi = setInterval(() => {
      if (!api() || !userId()) return;
      getJSON("System/Info/Public")
        .then((info) => info?.ServerName && root.style.setProperty("--hera-server", JSON.stringify(info.ServerName)))
        .catch(() => {});
      clearInterval(waitForApi);
      onHash();
    }, 250);
    state.cleanups.push(() => clearInterval(waitForApi));
  };

  window.HeraTV = {
    teardown() {
      state.hero?.destroy();
      state.cleanups.splice(0).forEach((fn) => fn());
      document.querySelectorAll(".hera-seasons").forEach((n) => n.remove());
      root.classList.remove("hera-home");
    },
  };

  start();
})();
