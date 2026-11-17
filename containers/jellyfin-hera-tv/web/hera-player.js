/*
 * Hera TV: player module. Registers with window.HeraTV (hera-tv.js).
 *  - Keeps the player dark in either scheme (the picture sets the light, not the Appearance setting).
 *  - The title block at the foot of the player ("Brooklyn Nine-Nine" / "S1, E1 · Pilot").
 *  - The pause screen: after a few quiet seconds paused, the picture dims and the title's logo,
 *    synopsis, time left and a Resume / Restart pair settle at the lower left, as on tvOS.
 */
(() => {
  "use strict";

  const heraTv = window.HeraTV;
  if (!heraTv) return;
  const { api, el, icon, getJSON, imageUrl, runtime, userId } = heraTv.kit;

  const PAUSE_DELAY = 3000;
  const FADE_OUT = 200;
  const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"];

  const osd = { timer: 0 };

  // What the server says is playing in this browser: the item, its position and the session id
  // that remote commands (restart) are addressed to. The page has no public handle on any of it.
  const nowPlaying = async () => {
    const sessions = await getJSON("Sessions", { deviceId: api().deviceId() });
    const session = sessions?.find((s) => s.NowPlayingItem);
    return session ? { session, item: session.NowPlayingItem } : null;
  };

  const episodeCode = (item) =>
    item.Type === "Episode" && item.ParentIndexNumber != null && item.IndexNumber != null ? `S${item.ParentIndexNumber}, E${item.IndexNumber}` : null;

  // ---------- title block ------------------------------------------------------------------
  // tv.apple.com titles the player at its foot: the show (or film) large, then "S1, E1 · Pilot".
  // A light poll follows autoplay into the next episode.

  const renderOsdTitle = async (page) => {
    const controls = page.querySelector(".osdControls");
    if (!controls) return;
    const playing = await nowPlaying();
    const item = playing?.item;
    const existing = controls.querySelector(".hera-osd-title");
    if (!item) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.item === item.Id) return;
    const episode = item.Type === "Episode";
    const line = episode
      ? [episodeCode(item), item.Name].filter(Boolean).join(" · ")
      : [item.ProductionYear, runtime(item.RunTimeTicks)].filter(Boolean).join(" · ");
    const node = el("div", { class: "hera-osd-title", "data-item": item.Id }, [
      el("p", { class: "hera-osd-title__name", text: episode ? item.SeriesName || item.Name : item.Name }),
      line ? el("p", { class: "hera-osd-title__line", text: line }) : null,
    ]);
    existing?.remove();
    controls.prepend(node);
  };

  const followPlayer = (page) => {
    clearInterval(osd.timer);
    const tick = () => renderOsdTitle(page).catch(() => {});
    tick();
    // Playback registers with the server a moment after the page shows.
    setTimeout(tick, 2500);
    osd.timer = setInterval(() => {
      if (page.classList.contains("hide") || !page.isConnected) clearInterval(osd.timer);
      else tick();
    }, 10000);
  };

  // ---------- always dark ------------------------------------------------------------------
  // Light mode never reaches the player: the page, the header it borrows, and the sheets and
  // menus opened from it all take the dark token set (.hera-dark in hera-tv.css).

  const dark = { headers: [], bodyObserver: null };

  // Overlays appended to <body>, outside the page: sheets, menus and Intro Skipper's button.
  const DARK_OVERLAYS = ["dialogContainer", "MuiPopover-root", "MuiModal-root", "skip-button-container"];
  const isOverlay = (node) => node.nodeType === 1 && DARK_OVERLAYS.some((name) => node.classList.contains(name));

  const startDark = (page) => {
    page.classList.add("hera-dark");
    // Jellyfin 12 keeps two headers (the legacy one and the MUI app bar's); the player shows
    // whichever it uses, so both go dark while it is up.
    dark.headers = [...document.querySelectorAll(".skinHeader")];
    dark.headers.forEach((header) => header.classList.add("hera-dark"));
    if (dark.bodyObserver) return;
    for (const node of document.body.children) if (isOverlay(node)) node.classList.add("hera-dark");
    dark.bodyObserver = new MutationObserver((records) => {
      if (page.classList.contains("hide")) return;
      for (const record of records) {
        for (const node of record.addedNodes) if (isOverlay(node)) node.classList.add("hera-dark");
      }
    });
    dark.bodyObserver.observe(document.body, { childList: true });
  };

  const stopDark = () => {
    dark.bodyObserver?.disconnect();
    dark.headers.forEach((header) => header.classList.remove("hera-dark"));
    dark.headers = [];
    dark.bodyObserver = null;
  };

  // ---------- pause screen -----------------------------------------------------------------
  // Shown once the video has been paused for PAUSE_DELAY with the OSD out of the way (or the
  // moment the OSD hides while paused). A key, a touch or a click on the picture gives the OSD
  // back (still paused) and fades this out; resuming removes it. A mouse can move freely, so it
  // can reach the buttons; navigation keys step onto them, so a remote can use them too.

  const pauseScreen = {
    page: null,
    layer: null,
    cleanups: [],
    timer: 0,
    pausedAt: 0,
    generation: 0,
    pointer: { x: -1, y: -1 },
    details: new Map(),
  };

  const video = () => document.querySelector(".videoPlayerContainer video") || document.querySelector("video");

  const osdVisible = () => {
    const bar = pauseScreen.page?.querySelector(".videoOsdBottom");
    if (!bar) return false;
    return !bar.classList.contains("videoOsdBottom-hidden") && !bar.classList.contains("hide");
  };

  const sheetOpen = () => !!document.querySelector(".dialogContainer .dialog");

  const isPaused = () => {
    const v = video();
    return !!v && v.paused && !v.ended && !v.seeking && v.readyState > 0;
  };

  const loadDetails = async (id) => {
    const cache = pauseScreen.details;
    if (!cache.has(id)) cache.set(id, getJSON(`Users/${userId()}/Items/${id}`).catch(() => null));
    return cache.get(id);
  };

  // 24-hour clock, British locale: "21:41".
  const endsAt = (ms) => new Date(Date.now() + ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

  const timeLeft = (ticks) => {
    const minutes = Math.round(ticks / 600000000);
    return minutes < 1 ? "Less than a minute left" : `${runtime(ticks)} left`;
  };

  const logoFor = (item) => {
    if (item.ImageTags?.Logo) return imageUrl(item.Id, "Logo", { maxWidth: 700, tag: item.ImageTags.Logo });
    if (item.ParentLogoItemId && item.ParentLogoImageTag) return imageUrl(item.ParentLogoItemId, "Logo", { maxWidth: 700, tag: item.ParentLogoImageTag });
    return null;
  };

  const castStrip = (item) => {
    const cast = (item.People || []).filter((p) => p.Type === "Actor").slice(0, 6);
    if (!cast.length) return null;
    return el(
      "ul",
      { class: "hera-pause__cast", "aria-label": "Cast" },
      cast.map((person) => {
        const portrait = person.PrimaryImageTag
          ? el("img", { src: imageUrl(person.Id, "Primary", { maxWidth: 200, tag: person.PrimaryImageTag }), alt: "", loading: "lazy" })
          : icon("person");
        return el("li", { class: "hera-pause__person" }, [
          el("span", { class: "hera-pause__portrait" }, [portrait]),
          el("span", { class: "hera-pause__person-name", text: person.Name }),
        ]);
      }),
    );
  };

  const buildLayer = (playing, item, left) => {
    const shown = playing.item;
    const logo = logoFor(item);
    const episode = item.Type === "Episode";
    const line = episode
      ? [episodeCode(item), item.Name].filter(Boolean).join(" · ")
      : [item.ProductionYear, (item.Genres || []).slice(0, 2).join(", ")].filter(Boolean).join(" · ");
    const name = episode ? item.SeriesName || item.Name : item.Name;

    const resume = el("button", { class: "hera-pause__button hera-pause__button--primary", type: "button" }, [icon("play_arrow"), el("span", { text: "Resume" })]);
    const restart = el("button", { class: "hera-pause__button", type: "button" }, [icon("replay"), el("span", { text: "Restart" })]);
    // Jellyfin toggles playback on a click that reaches the page; these buttons are their own.
    resume.addEventListener("click", (event) => {
      event.stopPropagation();
      resumePlayback(playing.session.Id);
    });
    restart.addEventListener("click", (event) => {
      event.stopPropagation();
      restartPlayback(playing.session.Id);
    });

    const timeline = left > 0 ? `${timeLeft(left)} · Ends at ${endsAt(left / 10000)}` : null;

    return el("div", { class: "hera-pause hera-dark", "data-item": shown.Id, role: "region", "aria-label": "Paused" }, [
      el("div", { class: "hera-pause__scrim" }),
      el("div", { class: "hera-pause__info" }, [
        logo ? el("img", { class: "hera-pause__logo", src: logo, alt: name }) : el("h2", { class: "hera-pause__name", text: name }),
        line ? el("p", { class: "hera-pause__line", text: line }) : null,
        item.Overview ? el("p", { class: "hera-pause__overview", text: item.Overview }) : null,
        timeline ? el("p", { class: "hera-pause__time", text: timeline }) : null,
        el("div", { class: "hera-pause__actions" }, [resume, restart]),
      ]),
      castStrip(item),
    ]);
  };

  const hideLayer = () => {
    const layer = pauseScreen.layer;
    if (!layer) return;
    pauseScreen.layer = null;
    layer.classList.remove("is-on");
    // Focus must not stay on a control that is leaving.
    if (layer.contains(document.activeElement)) document.activeElement.blur();
    setTimeout(() => layer.remove(), FADE_OUT);
  };

  const cancelTimer = () => {
    clearTimeout(pauseScreen.timer);
    pauseScreen.timer = 0;
  };

  const showLayer = async () => {
    const generation = ++pauseScreen.generation;
    const page = pauseScreen.page;
    if (!page || pauseScreen.layer) return;
    const playing = await nowPlaying().catch(() => null);
    if (!playing || generation !== pauseScreen.generation) return;
    const item = await loadDetails(playing.item.Id);
    // The world moved on while the data loaded: the user resumed, or woke the OSD.
    if (!item || generation !== pauseScreen.generation || !isPaused() || osdVisible() || sheetOpen()) return;
    const total = playing.item.RunTimeTicks || item.RunTimeTicks || 0;
    const left = total ? Math.max(0, total - (playing.session.PlayState?.PositionTicks || 0)) : 0;
    // Nothing to rest on at the very end: Up Next takes over there.
    if (total && left < 30000000) return;
    const layer = buildLayer(playing, item, left);
    pauseScreen.layer = layer;
    // First child: beneath the OSD, which is later in the page.
    page.prepend(layer);
    // Two frames: the hidden state must paint once for the fade to run.
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("is-on")));
  };

  // Decide what the pause screen should be doing right now.
  const reconcile = (immediate) => {
    if (!isPaused() || osdVisible() || sheetOpen()) {
      cancelTimer();
      pauseScreen.generation++;
      hideLayer();
      return;
    }
    if (pauseScreen.layer || pauseScreen.timer) return;
    const wait = immediate ? 0 : Math.max(0, PAUSE_DELAY - (Date.now() - pauseScreen.pausedAt));
    pauseScreen.timer = setTimeout(() => {
      pauseScreen.timer = 0;
      if (isPaused() && !osdVisible()) showLayer().catch(() => {});
    }, wait);
  };

  // Activity of any kind hands the screen back to the OSD. The timer restarts so a still-paused
  // picture settles again once the OSD has gone quiet.
  const wake = () => {
    cancelTimer();
    pauseScreen.generation++;
    hideLayer();
    pauseScreen.pausedAt = Date.now();
    if (isPaused()) setTimeout(() => reconcile(false), 0);
  };

  const focusables = () => [...(pauseScreen.layer?.querySelectorAll(".hera-pause__button") || [])];

  const onKey = (event) => {
    const layer = pauseScreen.layer;
    if (!layer) return;
    if (NAV_KEYS.includes(event.key)) {
      const buttons = focusables();
      const index = buttons.indexOf(document.activeElement);
      // First nav key lands on Resume; then left/right (or Tab) move along the row.
      let next = 0;
      if (index >= 0) {
        const step = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey) ? -1 : event.key === "ArrowRight" || event.key === "Tab" ? 1 : 0;
        if (!step) return wake();
        next = index + step;
        if (next < 0 || next >= buttons.length) return wake();
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      buttons[next]?.focus();
      return;
    }
    // Enter or Space on a focused button does that button's job, not "toggle playback".
    if ((event.key === "Enter" || event.key === " ") && layer.contains(document.activeElement)) {
      event.stopImmediatePropagation();
      return;
    }
    wake();
  };

  // With a mouse, the pause screen must survive the pointer travelling to its buttons, so
  // movement alone never dismisses it (and never reaches Jellyfin, which would raise the OSD over
  // it). A press on the picture hands the screen back to the OSD, still paused: the press is
  // swallowed, so it doesn't also toggle playback underneath.
  const onPointer = (event) => {
    if (!pauseScreen.layer) {
      if (event.type === "click" || event.type === "pointerup" || event.type === "mouseup") {
        if (pauseScreen.swallow) {
          event.stopPropagation();
          event.preventDefault();
          if (event.type === "click") pauseScreen.swallow = false;
        }
        return;
      }
      if (event.type === "mousemove" || event.type === "pointermove") {
        // Chrome repeats a move when content appears under a resting pointer.
        const { x, y } = pauseScreen.pointer;
        pauseScreen.pointer = { x: event.clientX, y: event.clientY };
        if (event.clientX === x && event.clientY === y) return;
      }
      return wake();
    }
    if (event.target.closest?.(".hera-pause__actions")) {
      // Jellyfin never sees a pointer that is using the buttons.
      if (event.type !== "click") event.stopPropagation();
      return;
    }
    if (event.type === "mousemove" || event.type === "pointermove") {
      event.stopPropagation();
      // Jellyfin hid the cursor with the OSD and never hears this move, so show it here, and
      // hide it again once the pointer rests.
      const layer = pauseScreen.layer;
      layer.classList.add("has-pointer");
      clearTimeout(pauseScreen.pointerTimer);
      pauseScreen.pointerTimer = setTimeout(() => layer.classList.remove("has-pointer"), 2500);
      return;
    }
    if (event.type === "pointerdown" || event.type === "mousedown" || event.type === "touchstart") {
      event.stopPropagation();
      pauseScreen.swallow = true;
      setTimeout(() => (pauseScreen.swallow = false), 600);
      wake();
      // The press was the user reaching for the controls: raise the OSD the way Jellyfin does,
      // from a pointer move, which it never got while the pause screen held the pointer. Jellyfin
      // ignores moves under 10px of screen distance from the last it saw, so two moves 24px apart
      // guarantee one counts.
      const point = event.touches?.[0] || event;
      setTimeout(() => {
        for (const step of [0, 24]) {
          const init = { bubbles: true, pointerType: "mouse", clientX: point.clientX + step, clientY: point.clientY, screenX: point.screenX + step, screenY: point.screenY };
          document.dispatchEvent(new PointerEvent("pointermove", init));
          document.dispatchEvent(new MouseEvent("mousemove", init));
        }
      }, 0);
      return;
    }
    wake();
  };

  const onMedia = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    if (event.type === "pause" || event.type === "seeked" || event.type === "canplay") {
      // A transcode reloads its stream on a seek and stays paused without a pause event of its
      // own, so the end of a seek starts the wait again.
      if (event.type === "pause" || isPaused()) {
        pauseScreen.pausedAt = Date.now();
        reconcile(false);
      }
    } else {
      cancelTimer();
      pauseScreen.generation++;
      hideLayer();
    }
  };

  // Resume and Restart go through Jellyfin's own session commands, so a transcode seeks properly.
  const sessionCommand = (sessionId, command, query) =>
    api().ajax({ type: "POST", url: api().getUrl(`Sessions/${sessionId}/Playing/${command}`, query) });

  const resumePlayback = async (sessionId) => {
    hideLayer();
    await sessionCommand(sessionId, "Unpause").catch(() => video()?.play());
  };

  const restartPlayback = async (sessionId) => {
    hideLayer();
    const v = video();
    // An Unpause that lands while the stream is still re-seeking is dropped, so wait for the
    // seek to finish (a transcode restarts its stream) before resuming.
    const landed = v ? new Promise((done) => v.addEventListener("seeked", done, { once: true })) : Promise.resolve();
    await sessionCommand(sessionId, "Seek", { seekPositionTicks: 0 }).catch(() => {});
    await Promise.race([landed, new Promise((done) => setTimeout(done, 2500))]);
    await sessionCommand(sessionId, "Unpause").catch(() => {});
    // Belt and braces: the element itself, should the command have been dropped regardless.
    setTimeout(() => {
      if (isPaused()) video()?.play();
    }, 800);
  };

  const bindPause = (page) => {
    if (pauseScreen.page === page) return;
    unbindPause();
    pauseScreen.page = page;
    const on = (target, type, fn, capture) => {
      target.addEventListener(type, fn, capture);
      pauseScreen.cleanups.push(() => target.removeEventListener(type, fn, capture));
    };
    // Media events do not bubble, but they can be caught on the way down; that survives the
    // <video> element being replaced between items.
    for (const type of ["pause", "seeked", "canplay", "play", "playing", "ended", "emptied", "seeking"]) on(document, type, onMedia, true);
    on(window, "keydown", onKey, true);
    for (const type of ["pointermove", "mousemove", "pointerdown", "mousedown", "touchstart", "wheel", "pointerup", "mouseup", "click"]) on(window, type, onPointer, true);

    // The OSD hiding while paused is the other trigger.
    const bar = page.querySelector(".videoOsdBottom");
    if (bar) {
      let visible = osdVisible();
      const observer = new MutationObserver(() => {
        const now = osdVisible();
        if (now === visible) return;
        visible = now;
        reconcile(!now);
      });
      observer.observe(bar, { attributes: true, attributeFilter: ["class"] });
      pauseScreen.cleanups.push(() => observer.disconnect());
    }
    // A sheet closing hands the screen back as well.
    const sheets = new MutationObserver(() => reconcile(false));
    sheets.observe(document.body, { childList: true });
    pauseScreen.cleanups.push(() => sheets.disconnect());
  };

  const unbindPause = () => {
    cancelTimer();
    pauseScreen.generation++;
    pauseScreen.layer?.remove();
    pauseScreen.layer = null;
    pauseScreen.cleanups.splice(0).forEach((fn) => fn());
    pauseScreen.page = null;
    pauseScreen.details.clear();
  };

  // ---------- lifecycle --------------------------------------------------------------------

  heraTv.register({
    name: "player",
    onView(page) {
      if (page?.id !== "videoOsdPage") {
        clearInterval(osd.timer);
        unbindPause();
        stopDark();
        return;
      }
      startDark(page);
      followPlayer(page);
      bindPause(page);
    },
    teardown() {
      clearInterval(osd.timer);
      unbindPause();
      stopDark();
    },
  });
})();
