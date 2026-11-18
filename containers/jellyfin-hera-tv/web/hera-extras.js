/*
 * Hera TV: extras. Registers with window.HeraTV (hera-tv.js). What Jellyfin Enhanced and Jellyfin
 * Tweaks used to add, rebuilt in Hera's own language:
 *  - Defaults for a person's first visit on a browser: page backdrops, detail banners, blurhash.
 *    They are written only where the person has not chosen, so a changed setting is never undone.
 *  - Quality on detail pages (meta line) and on cards (4K, HDR, Dolby Vision, Atmos), fetched in
 *    batches for the cards that are on screen.
 *  - IMDb and Rotten Tomatoes scores on film and series pages (from Seerr, through the server).
 *  - "Also on": the streaming services that carry a title in the configured region.
 *  - Hide titles: "Remove from Up Next" and "Not Interested", saved per user on the server,
 *    honoured by Hera's rows, Discover and search, and listed with Unhide in Settings > Home.
 */
(() => {
  "use strict";

  const heraTv = window.HeraTV;
  if (!heraTv) return;
  const { kit } = heraTv;
  const { el, icon } = kit;

  const BADGE_LABEL = { "4k": "4K", dv: "Dolby Vision", hdr: "HDR", atmos: "Dolby Atmos", "7.1": "7.1", "5.1": "5.1" };
  // Cards carry the loudest facts only, in the shortest words.
  const CARD_LABEL = { "4k": "4K", dv: "DV", hdr: "HDR", atmos: "Atmos" };
  const CARD_ORDER = ["4k", "dv", "hdr", "atmos"];
  const CARD_SELECTOR = [
    '.card[data-id][data-type="Movie"]',
    '.card[data-id][data-type="Series"]',
    '.card[data-id][data-type="Episode"]',
    '.card[data-id][data-type="Video"]',
    '.hera-card[href^="#/details?id="]:not(.hera-card--person)',
    ".hera-upnext > .hera-card",
  ].join(",");
  const BADGE_BATCH = 40;
  const BADGE_TTL = 10 * 60 * 1000;
  const EXTRAS_TTL = 5 * 60 * 1000;
  const UNDO_MS = 6000;
  const LONG_PRESS_MS = 450;

  const state = {
    run: 0,
    cleanups: [],
    extras: new Map(), // item id -> { at, promise }
    badges: new Map(), // item id -> { at, badges }
    badgeQueue: new Set(),
    badgeTimer: 0,
    badgeObserver: null,
    mutationObserver: null,
    mutationQueued: false,
    detail: null,
  };

  const plainId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
  const features = async () => (await kit.integrations())?.features || {};

  // ---------- defaults ------------------------------------------------------------------------
  // Jellyfin keeps these in the browser, under "<user id>-<setting>". Jellyfin Tweaks forced them
  // on every load; here a missing value is filled in once and a stored one, on or off, is left.

  const DEFAULTS = { enableBackdrops: "true", detailsBanner: "true", blurhash: "true" };

  const applyDefaults = () => {
    const user = kit.userId();
    if (!user) return;
    try {
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (localStorage.getItem(`${user}-${key}`) === null) localStorage.setItem(`${user}-${key}`, value);
      }
    } catch {
      /* private mode: Jellyfin's own defaults stand */
    }
  };

  // ---------- hidden titles -------------------------------------------------------------------

  const hidden = { user: null, list: null, loading: null };

  const loadHidden = () => {
    const user = kit.userId();
    if (hidden.user !== user) {
      hidden.user = user;
      hidden.list = null;
      hidden.loading = null;
    }
    if (!hidden.loading) {
      hidden.loading = Promise.resolve(kit.hera("hidden"))
        .then((list) => (hidden.list = Array.isArray(list) ? list : []))
        .catch((error) => {
          hidden.loading = null;
          console.warn("[Hera TV:extras] hidden titles", error);
          return hidden.list || [];
        });
    }
    return hidden.loading;
  };

  /** The saved entry that hides a title in this scope, matching any of its keys; null when it is shown. */
  const hiddenEntry = (scope, keys) => {
    if (!hidden.list || !hidden.list.length) return null;
    const wanted = keys.filter(Boolean);
    return hidden.list.find((entry) => entry.scope === scope && (wanted.includes(entry.key) || entry.aliases?.some((alias) => wanted.includes(alias)))) || null;
  };

  const writeHidden = (list) => {
    hidden.list = list;
    hidden.loading = Promise.resolve(list);
  };

  const hide = async (descriptor) => {
    const entry = {
      scope: descriptor.scope,
      key: descriptor.keys[0],
      title: descriptor.title,
      year: descriptor.year || null,
      kind: descriptor.kind || null,
      image: descriptor.image || null,
      aliases: descriptor.keys.slice(1),
      at: new Date().toISOString(),
    };
    const before = hidden.list || [];
    writeHidden([entry, ...before.filter((e) => !(e.scope === entry.scope && e.key === entry.key))]);
    try {
      writeHidden(await kit.hera("hidden", { method: "POST", body: entry }));
    } catch (error) {
      writeHidden(before);
      throw error;
    }
  };

  const unhide = async (entry) => {
    const before = hidden.list || [];
    writeHidden(before.filter((e) => !(e.scope === entry.scope && e.key === entry.key)));
    try {
      writeHidden(await kit.hera("hidden", { method: "DELETE", query: { scope: entry.scope, key: entry.key } }));
    } catch (error) {
      writeHidden(before);
      throw error;
    }
  };

  const SCOPE_TEXT = {
    upnext: { action: "Remove from Up Next", icon: "playlist_remove", done: "Removed from Up Next", where: "Removed from Up Next" },
    interest: { action: "Not Interested", icon: "visibility_off", done: "Hidden", where: "Not Interested" },
  };

  const tmdbKey = (item) => (item?.tmdbId && item.mediaType ? `tmdb:${item.mediaType}:${item.tmdbId}` : null);

  /** What a card stands for, when it can be hidden: { scope, keys, title, year, kind, image }. */
  const describe = (card) => {
    if (card.heraHide) return card.heraHide;
    const item = card.heraItem;
    if (!item?.title || !card.closest(".hera-discover, .hera-search, [data-hera-row]") || card.closest(".hera-sheet, .hera-seerr")) return null;
    const keys = [tmdbKey(item), item.jellyfinId ? plainId(item.jellyfinId) : null].filter(Boolean);
    if (!keys.length) return null;
    return {
      scope: "interest",
      keys,
      title: item.title,
      year: item.year ? String(item.year) : null,
      kind: item.mediaType === "tv" ? "TV Show" : "Film",
      image: item.poster || null,
    };
  };

  // The element that leaves a row when its title is hidden: Up Next wraps its card.
  const cellOf = (card) => card.closest(".hera-upnext") || card;

  const setCellHidden = (cell, off) => {
    cell.hidden = off;
    cell.classList.toggle("hera-card--hidden", off);
    const row = cell.closest(".hera-row");
    if (row) row.hidden = ![...row.querySelectorAll(".hera-card")].some((c) => !cellOf(c).hidden);
  };

  /** Hides what the person has already hidden: Discover and search build cards without asking. */
  const filterCards = (root) => {
    if (!hidden.list?.length) return;
    const cards = root.matches?.(".hera-card") ? [root] : [...(root.querySelectorAll?.(".hera-card") || [])];
    for (const card of cards) {
      const descriptor = describe(card);
      if (!descriptor || descriptor.scope !== "interest") continue;
      if (hiddenEntry("interest", descriptor.keys)) setCellHidden(cellOf(card), true);
    }
  };

  // ---------- toast ---------------------------------------------------------------------------

  let toast = null;
  let toastTimer = 0;

  const say = (message, undo) => {
    clearTimeout(toastTimer);
    toast?.remove();
    const node = el("div", { class: "hera-toast", role: "status" }, [
      el("span", { class: "hera-toast__text", text: message }),
      undo ? el("button", { class: "hera-toast__undo", type: "button", text: "Undo", onclick: () => { dismiss(); undo(); } }) : null,
    ]);
    const dismiss = () => {
      clearTimeout(toastTimer);
      node.classList.remove("is-in");
      setTimeout(() => node.remove(), 240);
      if (toast === node) toast = null;
    };
    toast = node;
    document.body.append(node);
    requestAnimationFrame(() => node.classList.add("is-in"));
    toastTimer = setTimeout(dismiss, UNDO_MS);
  };

  const doHide = async (card, descriptor) => {
    const cell = cellOf(card);
    setCellHidden(cell, true);
    try {
      await hide(descriptor);
    } catch (error) {
      console.error("[Hera TV:extras]", error);
      setCellHidden(cell, false);
      say("Couldn't hide that. Check your connection and try again.");
      return;
    }
    const entry = hiddenEntry(descriptor.scope, descriptor.keys);
    say(`${descriptor.title}: ${SCOPE_TEXT[descriptor.scope].done}`, async () => {
      try {
        if (entry) await unhide(entry);
        setCellHidden(cell, false);
      } catch (error) {
        console.error("[Hera TV:extras]", error);
        say("Couldn't undo that. Open Settings > Home > Hidden Titles to unhide it.");
      }
    });
  };

  // ---------- menu ----------------------------------------------------------------------------

  const menu = { node: null, opener: null, off: null };

  const closeMenu = ({ restore = true } = {}) => {
    if (!menu.node) return;
    menu.node.remove();
    menu.off?.();
    const opener = menu.opener;
    menu.node = menu.opener = menu.off = null;
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
  };

  /** A small glass menu at a point or beside a rectangle. Items: { label, icon, onSelect }. */
  const openMenu = ({ at, rect, opener, items }) => {
    closeMenu({ restore: false });
    const buttons = items.map((item) =>
      el("button", { class: "hera-menu__item", type: "button", role: "menuitem", onclick: () => { closeMenu(); item.onSelect(); } }, [icon(item.icon), el("span", { text: item.label })]),
    );
    const node = el("div", { class: "hera-menu", role: "menu" }, buttons);
    document.body.append(node);
    const box = node.getBoundingClientRect();
    let x = at ? at.x : rect.right - box.width;
    let y = at ? at.y : rect.bottom + 6;
    x = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    if (y + box.height > window.innerHeight - 8) y = Math.max(8, (rect ? rect.top - 6 : y) - box.height);
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    menu.node = node;
    menu.opener = opener || null;
    const away = (event) => {
      if (!node.contains(event.target)) closeMenu({ restore: false });
    };
    const keys = (event) => {
      if (event.key === "Escape" || event.keyCode === 461 || event.keyCode === 10009 || event.key === "GoBack") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const at = buttons.indexOf(document.activeElement);
        buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
      } else if (event.key === "Tab") {
        closeMenu({ restore: false });
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    document.addEventListener("keydown", keys, true);
    const onScroll = () => closeMenu({ restore: false });
    window.addEventListener("scroll", onScroll, { passive: true, once: true });
    menu.off = () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", keys, true);
      window.removeEventListener("scroll", onScroll);
    };
    buttons[0].focus({ preventScroll: true });
  };

  const menuFor = (card, descriptor, anchor) => {
    const text = SCOPE_TEXT[descriptor.scope];
    const items = [...(descriptor.extra || []), { label: text.action, icon: text.icon, onSelect: () => doHide(card, descriptor) }];
    openMenu({ ...anchor, opener: card, items });
  };

  // ---------- the "more" button that follows the pointer --------------------------------------
  // One floating button serves every eligible card, so cards need no markup of their own and a
  // card's link or button never holds another button.

  const more = { node: null, card: null, timer: 0 };

  const placeMore = (card) => {
    const art = card.querySelector(".hera-card__art") || card;
    const box = art.getBoundingClientRect();
    const inset = card.closest(".hera-upnext") ? 48 : 8;
    more.node.style.left = `${Math.round(box.right - inset - 32)}px`;
    more.node.style.top = `${Math.round(box.top + 8)}px`;
  };

  const hideMore = () => {
    clearTimeout(more.timer);
    more.card = null;
    more.node?.classList.remove("is-on");
  };

  const showMore = (card) => {
    if (!more.node || kit.isTv()) return;
    const descriptor = describe(card);
    if (!descriptor || cellOf(card).hidden) return;
    clearTimeout(more.timer);
    more.card = card;
    more.node.setAttribute("aria-label", `${SCOPE_TEXT[descriptor.scope].action}: ${descriptor.title}`);
    placeMore(card);
    more.node.classList.add("is-on");
  };

  const mountMore = () => {
    more.node = el("button", { class: "hera-more hera-dark", type: "button", tabindex: "-1", "aria-hidden": "true", title: "More" }, icon("more_horiz"));
    more.node.addEventListener("click", (event) => {
      event.preventDefault();
      const card = more.card;
      const descriptor = card && describe(card);
      if (!descriptor) return;
      menuFor(card, descriptor, { rect: more.node.getBoundingClientRect() });
    });
    document.body.append(more.node);

    const cardAt = (target) => target?.closest?.(".hera-card");
    const over = (event) => {
      if (event.pointerType === "touch") return;
      const card = cardAt(event.target);
      if (card && describe(card)) showMore(card);
      else if (!more.node.contains(event.target) && more.card) {
        clearTimeout(more.timer);
        more.timer = setTimeout(hideMore, 120);
      }
    };
    const out = (event) => {
      if (!more.card || more.node.contains(event.relatedTarget) || more.card.contains(event.relatedTarget) || cellOf(more.card).contains(event.relatedTarget)) return;
      clearTimeout(more.timer);
      more.timer = setTimeout(hideMore, 120);
    };
    const focus = (event) => {
      const card = cardAt(event.target);
      if (card && describe(card) && event.target.matches?.(":focus-visible")) showMore(card);
    };
    const blur = (event) => {
      if (event.relatedTarget === more.node) return;
      hideMore();
    };
    const reposition = () => {
      if (more.card?.isConnected) placeMore(more.card);
      else hideMore();
    };
    // The shelves scroll inside themselves; capture sees those scrolls too.
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    state.cleanups.push(() => {
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      window.removeEventListener("scroll", reposition, true);
      more.node?.remove();
      more.node = null;
    });
  };

  // Right-click, the keyboard's Menu key and Shift+F10 all raise a `contextmenu` event on the card.
  const onContextMenu = (event) => {
    const card = event.target.closest?.(".hera-card");
    const descriptor = card && describe(card);
    if (!descriptor || cellOf(card).hidden) return;
    event.preventDefault();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const rect = (card.querySelector(".hera-card__art") || card).getBoundingClientRect();
    menuFor(card, descriptor, fromKeyboard ? { rect: { right: rect.left + rect.width * 0.7, bottom: rect.top + rect.height * 0.5, top: rect.top } } : { at: { x: event.clientX, y: event.clientY } });
  };

  // A remote has no pointer: holding OK on a card opens the same menu.
  const press = { timer: 0, card: null, fired: false };
  const onPressStart = (event) => {
    if (!kit.isTv() || event.key !== "Enter" || event.repeat) return;
    const card = event.target.closest?.(".hera-card");
    const descriptor = card && !card.closest(".hera-upnext") && describe(card);
    if (!descriptor) return;
    press.fired = false;
    press.card = card;
    press.timer = setTimeout(() => {
      press.fired = true;
      const rect = (card.querySelector(".hera-card__art") || card).getBoundingClientRect();
      menuFor(card, descriptor, { rect: { right: rect.left + rect.width * 0.7, bottom: rect.top + rect.height * 0.5, top: rect.top } });
    }, LONG_PRESS_MS);
    event.preventDefault();
  };
  const onPressEnd = (event) => {
    if (!press.timer || event.key !== "Enter") return;
    clearTimeout(press.timer);
    press.timer = 0;
    if (!press.fired) press.card?.click();
    press.card = null;
  };

  // ---------- quality badges on cards ---------------------------------------------------------

  const cardId = (card) => {
    if (card.dataset.id) return plainId(card.dataset.id);
    const href = card.getAttribute("href");
    if (href) return plainId(new URLSearchParams(href.split("?")[1] || "").get("id"));
    return card.heraId ? plainId(card.heraId) : null;
  };

  const paintCard = (card, badges) => {
    const art = card.querySelector(".hera-card__art, .cardScalable");
    if (!art) return;
    art.querySelector(":scope > .hera-quality")?.remove();
    const shown = CARD_ORDER.filter((key) => badges.includes(key) && !(key === "hdr" && badges.includes("dv")));
    if (!shown.length) return;
    const node = el("span", { class: "hera-quality hera-dark", "aria-label": shown.map((key) => BADGE_LABEL[key]).join(", ") }, shown.map((key) => el("span", { class: "hera-quality__chip", "aria-hidden": "true", text: CARD_LABEL[key] })));
    if (art.querySelector(".hera-card__progress, .itemProgressBar")) node.classList.add("hera-quality--raised");
    art.append(node);
  };

  const paintId = (id, badges) => {
    for (const card of document.querySelectorAll(`[data-hera-qid="${id}"]`)) paintCard(card, badges);
  };

  const flushBadges = async () => {
    state.badgeTimer = 0;
    const user = kit.userId();
    const ids = [...state.badgeQueue].filter((id) => !(state.badges.get(id)?.at > Date.now() - BADGE_TTL));
    state.badgeQueue.clear();
    if (!ids.length || (await features()).qualityBadges === false) return;
    for (let at = 0; at < ids.length; at += BADGE_BATCH) {
      const chunk = ids.slice(at, at + BADGE_BATCH);
      try {
        const found = (await kit.hera("extras/badges", { query: { ids: chunk.join(",") } })) || {};
        if (user !== kit.userId()) return;
        for (const id of chunk) {
          const badges = found[id] || [];
          state.badges.set(id, { at: Date.now(), badges });
          paintId(id, badges);
        }
      } catch (error) {
        console.warn("[Hera TV:extras] badges", error);
      }
    }
  };

  const queueBadges = (id) => {
    const held = state.badges.get(id);
    if (held && Date.now() - held.at < BADGE_TTL) {
      paintId(id, held.badges);
      return;
    }
    state.badgeQueue.add(id);
    if (!state.badgeTimer) state.badgeTimer = setTimeout(flushBadges, 80);
  };

  const watchCard = (card) => {
    if (card.dataset.heraQid) return;
    const id = cardId(card);
    if (!id) return;
    card.dataset.heraQid = id;
    const held = state.badges.get(id);
    if (held) paintCard(card, held.badges);
    state.badgeObserver?.observe(card);
  };

  const scan = (root) => {
    if (root.matches?.(CARD_SELECTOR)) watchCard(root);
    for (const card of root.querySelectorAll?.(CARD_SELECTOR) || []) watchCard(card);
    filterCards(root);
  };

  const startCards = async () => {
    if ((await features()).qualityBadges !== false) {
      state.badgeObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.badgeObserver.unobserve(entry.target);
            queueBadges(entry.target.dataset.heraQid);
          }
        },
        { rootMargin: "240px 400px" },
      );
    }
    const pending = new Set();
    state.mutationObserver = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) pending.add(node);
      if (state.mutationQueued || !pending.size) return;
      state.mutationQueued = true;
      requestAnimationFrame(() => {
        state.mutationQueued = false;
        const nodes = [...pending];
        pending.clear();
        for (const node of nodes) if (node.isConnected) scan(node);
      });
    });
    state.mutationObserver.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
  };

  // ---------- detail pages --------------------------------------------------------------------

  const extrasFor = (id) => {
    const held = state.extras.get(id);
    if (held && Date.now() - held.at < EXTRAS_TTL) return held.promise;
    const promise = Promise.resolve(kit.hera(`extras/${id}`)).catch((error) => {
      if (state.extras.get(id)?.promise === promise) state.extras.delete(id);
      console.warn("[Hera TV:extras] extras", error);
      return null;
    });
    state.extras.set(id, { at: Date.now(), promise });
    return promise;
  };

  const ratingText = (value) => `${value}%`;

  const stateIcon = (fresh) => el("span", { class: "material-icons hera-rating__state", "aria-hidden": "true", text: fresh ? "thumb_up" : "thumb_down" });

  const ratingsNode = (ratings) => {
    const parts = [];
    if (ratings.imdb?.score != null) {
      const votes = ratings.imdb.votes ? ` from ${ratings.imdb.votes.toLocaleString()} votes` : "";
      parts.push(
        el("span", { class: "hera-rating", title: `IMDb rating ${ratings.imdb.score.toFixed(1)}${votes}`, "aria-label": `IMDb rating ${ratings.imdb.score.toFixed(1)} out of 10` }, [
          el("span", { class: "hera-mark", "aria-hidden": "true", text: "IMDb" }),
          el("span", { text: ratings.imdb.score.toFixed(1) }),
        ]),
      );
    }
    const rt = ratings.rt;
    if (rt?.critics) {
      parts.push(
        el("span", { class: "hera-rating", title: `Rotten Tomatoes critics ${ratingText(rt.critics.score)}, ${rt.critics.fresh ? "fresh" : "rotten"}`, "aria-label": `Rotten Tomatoes critics ${ratingText(rt.critics.score)}, ${rt.critics.fresh ? "fresh" : "rotten"}` }, [
          el("span", { class: "hera-mark", "aria-hidden": "true", text: "RT" }),
          stateIcon(rt.critics.fresh),
          el("span", { text: ratingText(rt.critics.score) }),
        ]),
      );
    }
    if (rt?.audience) {
      parts.push(
        el("span", { class: "hera-rating", title: `Rotten Tomatoes audience ${ratingText(rt.audience.score)}, ${rt.audience.fresh ? "upright" : "spilled"}`, "aria-label": `Rotten Tomatoes audience ${ratingText(rt.audience.score)}, ${rt.audience.fresh ? "upright" : "spilled"}` }, [
          el("span", { class: "hera-mark", "aria-hidden": "true", text: "RT Audience" }),
          stateIcon(rt.audience.fresh),
          el("span", { text: ratingText(rt.audience.score) }),
        ]),
      );
    }
    return parts.length ? el("div", { class: "mediaInfoItem hera-xmeta hera-ratings" }, parts) : null;
  };

  const qualityNode = (badges) =>
    badges?.length
      ? el(
          "div",
          { class: "mediaInfoItem hera-xmeta hera-qualities", "aria-label": badges.map((key) => BADGE_LABEL[key]).join(", ") },
          badges.map((key) => el("span", { class: "hera-chip", "aria-hidden": "true", text: BADGE_LABEL[key] })),
        )
      : null;

  const elsewhereNode = (providers) => {
    if (!providers?.streaming?.length) return null;
    const logos = providers.streaming.map((provider) => {
      const logo = el("img", { src: provider.logo, alt: provider.name, loading: "lazy", decoding: "async" });
      return el("li", {}, el("a", { class: "hera-provider", href: providers.link || "https://www.themoviedb.org/", target: "_blank", rel: "noopener noreferrer", title: `Watch on ${provider.name}`, "aria-label": `Watch on ${provider.name}` }, logo));
    });
    return el("section", { class: "hera-elsewhere", "aria-label": "Also on" }, [
      el("h3", { class: "hera-elsewhere__title", text: "Also on" }),
      el("ul", { class: "hera-elsewhere__list" }, logos),
      el("a", { class: "hera-elsewhere__source", href: providers.link || "https://www.themoviedb.org/", target: "_blank", rel: "noopener noreferrer", text: "Streaming data from JustWatch" }),
    ]);
  };

  const clearDetail = () => {
    state.detail?.observer?.disconnect();
    state.detail = null;
    document.querySelectorAll(".hera-xmeta, .hera-elsewhere").forEach((node) => node.remove());
    document.querySelectorAll(".hera-meta-ratings").forEach((node) => node.classList.remove("hera-meta-ratings"));
  };

  const paintDetail = (page, data) => {
    const meta = page.querySelector(".itemMiscInfo-primary");
    if (meta) {
      meta.querySelectorAll(".hera-xmeta").forEach((node) => node.remove());
      const ratings = data.ratings ? ratingsNode(data.ratings) : null;
      const quality = qualityNode(data.badges);
      const before = meta.querySelector(".endsAt");
      for (const node of [ratings, quality]) {
        if (!node) continue;
        if (before) meta.insertBefore(node, before);
        else meta.append(node);
      }
      // Our scores stand in for the stock TMDB star and critic score.
      meta.classList.toggle("hera-meta-ratings", !!ratings);
    }
    const section = page.querySelector(".detailPagePrimaryContent .detailSectionContent");
    page.querySelectorAll(".hera-elsewhere").forEach((node) => node.remove());
    const elsewhere = data.providers ? elsewhereNode(data.providers) : null;
    if (section && elsewhere) section.prepend(elsewhere);
  };

  const mountDetail = async (page, id) => {
    if (!id) return;
    if (state.detail?.page === page && state.detail.id === id && page.querySelector(".hera-xmeta, .hera-elsewhere")) return;
    clearDetail();
    const run = ++state.run;
    const data = await extrasFor(plainId(id));
    if (!data || run !== state.run || !page.isConnected || page.classList.contains("hide") || plainId(kit.itemIdFromHash()) !== plainId(id)) return;
    const flags = await features();
    const shown = {
      badges: flags.qualityBadges === false ? [] : data.badges,
      ratings: flags.ratings === false ? null : data.ratings,
      providers: flags.elsewhere === false ? null : data.providers,
    };
    paintDetail(page, shown);
    // Jellyfin draws the meta line again when the item reloads (a played mark, a refreshed rating).
    const meta = page.querySelector(".itemMiscInfo-primary");
    const observer = new MutationObserver(() => {
      if (meta.querySelector(".hera-xmeta") || (!shown.ratings && !shown.badges?.length)) return;
      observer.disconnect();
      paintDetail(page, shown);
      observer.observe(meta, { childList: true });
    });
    if (meta) observer.observe(meta, { childList: true });
    state.detail = { page, id, observer };
  };

  // ---------- Settings > Home: hidden titles --------------------------------------------------

  /** A grouped list for the Settings app: each hidden title with an Unhide on its row. */
  const settingsGroup = () => {
    const list = el("div", { class: "hera-set-list" });
    const node = el("section", { class: "hera-set-group", "aria-label": "Hidden Titles" }, [
      el("h2", { class: "hera-set-group__title", text: "Hidden Titles" }),
      list,
      el("p", { class: "hera-set-group__foot", text: "Titles you remove from Up Next or mark Not Interested stay out of Home, Discover and search until you unhide them." }),
    ]);
    const empty = () => el("div", { class: "hera-set-row hera-set-row--static" }, el("span", { class: "hera-set-row__text" }, el("span", { class: "hera-set-row__desc", text: "Nothing is hidden." })));
    const render = (entries) => {
      if (!entries.length) {
        list.replaceChildren(empty());
        return;
      }
      list.replaceChildren(
        ...entries.map((entry) => {
          const detail = [SCOPE_TEXT[entry.scope]?.where, entry.kind, entry.year].filter(Boolean).join(" · ");
          const row = el("button", { class: "hera-set-row hera-hidden-row", type: "button", "aria-label": `Unhide ${entry.title}` }, [
            el("span", { class: "hera-set-row__icon" }, entry.image ? el("img", { class: "hera-hidden-row__art", src: entry.image, alt: "", loading: "lazy" }) : icon("visibility_off")),
            el("span", { class: "hera-set-row__text" }, [el("span", { class: "hera-set-row__label", text: entry.title }), el("span", { class: "hera-set-row__desc", text: detail })]),
            el("span", { class: "hera-set-row__value", text: "Unhide" }),
          ]);
          row.addEventListener("click", async () => {
            row.disabled = true;
            try {
              await unhide(entry);
              render(hidden.list || []);
            } catch (error) {
              console.error("[Hera TV:extras]", error);
              row.disabled = false;
              row.querySelector(".hera-set-row__value").textContent = "Try again";
            }
          });
          return row;
        }),
      );
    };
    list.replaceChildren(el("div", { class: "hera-set-row hera-set-row--static" }, el("span", { class: "hera-set-row__text" }, el("span", { class: "hera-set-row__desc", text: "Loading…" }))));
    loadHidden().then((entries) => node.isConnected !== false && render(entries));
    return node;
  };

  heraTv.hidden = {
    /** Resolves once this user's hidden titles are known. */
    ready: loadHidden,
    /** The entry hiding a title in `scope` ("upnext" or "interest") by any of `keys`, or null. */
    match: hiddenEntry,
    settingsGroup,
    /** Opens a card's menu over its artwork (a remote's long press); false when the card has none. */
    menu(card) {
      const descriptor = describe(card);
      if (!descriptor) return false;
      const rect = (card.querySelector(".hera-card__art") || card).getBoundingClientRect();
      menuFor(card, descriptor, { rect: { right: rect.left + rect.width * 0.7, bottom: rect.top + rect.height * 0.5, top: rect.top } });
      return true;
    },
  };

  // ---------- module --------------------------------------------------------------------------

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    mountMore();
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onPressStart, true);
    document.addEventListener("keyup", onPressEnd, true);
    state.cleanups.push(() => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onPressStart, true);
      document.removeEventListener("keyup", onPressEnd, true);
    });
    loadHidden().then(() => scan(document.body));
    startCards().catch((error) => console.error("[Hera TV:extras]", error));
  };

  heraTv.register({
    name: "extras",
    onView(page, { itemId }) {
      applyDefaults();
      start();
      if (page.id === "itemDetailPage") {
        mountDetail(page, itemId).catch((error) => console.error("[Hera TV:extras]", error));
      } else {
        clearDetail();
      }
    },
    teardown() {
      state.run++;
      state.cleanups.splice(0).forEach((fn) => fn());
      state.badgeObserver?.disconnect();
      state.mutationObserver?.disconnect();
      clearTimeout(state.badgeTimer);
      closeMenu({ restore: false });
      toast?.remove();
      clearDetail();
      document.querySelectorAll(".hera-quality").forEach((node) => node.remove());
      document.querySelectorAll("[data-hera-qid]").forEach((node) => delete node.dataset.heraQid);
      document.querySelectorAll(".hera-card--hidden").forEach((cell) => {
        cell.hidden = false;
        cell.classList.remove("hera-card--hidden");
      });
      started = false;
      delete heraTv.hidden;
    },
  });
})();
