/*
 * Hera TV: Seerr as an extension of the library. Registers with window.HeraTV (hera-tv.js) and
 * builds on the title sheet and cards in hera-discover.js.
 *  - People: on a person's page, their role and a "More" on the biography, then a filmography
 *    from Seerr: "In Your Library" first, then Films / TV Shows (or what they directed, wrote,
 *    produced), each card showing Seerr's state and opening the title sheet to request. A person
 *    only Seerr knows is shown by the same renderer at #/home?hera=person&tmdb=<id>.
 *  - Film and series pages: a "More Like This" row of the library's own similar titles and
 *    Seerr's recommendations, the ones not in the library requestable.
 *  - Collection (box set) pages: the films the library lacks join the collection's own shelf
 *    in release order, dimmed, opening the title sheet, with "Request Missing" by its title.
 * Everything goes through the plugin's server: the Seerr key never reaches the browser, and
 * requests are made as the viewer's own Seerr account. With Seerr off, Jellyfin's stock sections stay.
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

  const discover = () => HT.discover;

  // ---------- data ----------------------------------------------------------------------

  const memo = new Map();
  const cached = (key, load, ttl) => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = Promise.resolve(load()).catch((error) => {
      memo.delete(key);
      throw error;
    });
    memo.set(key, { at: Date.now(), promise });
    return promise;
  };

  const fetchPerson = (tmdbId) => cached(`person:${tmdbId}`, () => kit.hera(`discover/person/${tmdbId}`), 2 * 60 * 1000);
  const fetchRelated = (type, tmdbId) =>
    cached(`related:${type}:${tmdbId}`, () => kit.hera(`discover/titles/${type}/${tmdbId}/related`), 5 * 60 * 1000);
  const fetchCollection = (id) => cached(`collection:${id}`, () => kit.hera(`discover/collections/${id}`), 60 * 1000);

  const errorStatus = (error) => error?.status ?? error?.response?.status ?? null;
  const errorMessage = async (error) => {
    try {
      const body = await (error?.json ? error.json() : null);
      return body?.message || null;
    } catch {
      return null;
    }
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const kindText = (item) => (item.mediaType === "tv" ? "TV Show" : "Film");
  const detailsHref = (id) => `#/details?id=${id}`;
  const poster = (id) => kit.imageUrl(id, "Primary", { maxWidth: 400 });

  /** A card for something the library holds: its own artwork, a link to its page. */
  const libraryCard = ({ id, title, subtitle, badge }) =>
    kit.card({ href: detailsHref(id), image: poster(id), title, subtitle, badge });

  // ---------- expandable text -----------------------------------------------------------

  // A biography is clamped to three lines; "More" opens it, only when something is hidden.
  const addMore = (text) => {
    if (text.nextElementSibling?.classList.contains("hera-more")) return;
    if (text.scrollHeight <= text.clientHeight + 1) return;
    const button = el("button", { type: "button", class: "hera-more", "aria-expanded": "false", text: "More" });
    button.addEventListener("click", () => {
      const open = text.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? "Less" : "More";
    });
    text.after(button);
  };

  // ---------- filmography ---------------------------------------------------------------

  // Crew jobs worth a row of their own; everything else (grips, gaffers, thanks) is left out.
  const JOB_KIND = {
    Director: "directed",
    "Co-Director": "directed",
    Creator: "created",
    Writer: "written",
    Screenplay: "written",
    Story: "written",
    Teleplay: "written",
    Novel: "written",
    "Original Story": "written",
    Producer: "produced",
    "Executive Producer": "produced",
    "Original Music Composer": "composed",
    Composer: "composed",
  };
  const SECTION_TITLE = {
    films: "Films",
    tv: "TV Shows",
    acting: "Acting",
    directed: "Directed",
    created: "Created",
    written: "Written",
    produced: "Produced",
    composed: "Composed",
    appearances: "Appearances",
  };
  // What a person is known for decides which rows lead. An actor's producer credits are noise;
  // for a producer they are the point.
  const PRIMARY = { Acting: "acting", Directing: "directed", Writing: "written", Production: "produced", Sound: "composed", Creator: "created" };
  const ORDER = {
    acting: ["films", "tv", "directed", "created", "written"],
    directed: ["directed", "created", "written", "produced", "acting"],
    created: ["created", "directed", "written", "produced", "acting"],
    written: ["written", "created", "directed", "produced", "acting"],
    produced: ["produced", "directed", "created", "written", "acting"],
    composed: ["composed", "acting"],
  };
  const MAX_CARDS = 80;

  const SORTS = {
    popular: (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
    newest: (a, b) => (b.date || "").localeCompare(a.date || ""),
  };

  const creditKey = (credit) => `${credit.mediaType}:${credit.tmdbId}`;

  const KIND_LABEL = { directed: "Director", created: "Creator", written: "Writer", produced: "Producer", composed: "Composer" };

  // The kinds of work a crew credit stands for, most important first.
  const crewKinds = (credit) => {
    const kinds = new Set((credit.roles ?? []).map((role) => JOB_KIND[role]).filter(Boolean));
    return Object.keys(KIND_LABEL).filter((kind) => kinds.has(kind));
  };
  const crewLabel = (credit) => {
    const labels = crewKinds(credit).map((kind) => KIND_LABEL[kind]);
    return labels.length ? labels.slice(0, 2).join(" & ") : credit.roles?.[0];
  };

  /**
   * The filmography of a person: `data` is the server's person record, `extras` the Jellyfin
   * films and shows the library credits to them (which cover what Seerr's TMDB credits miss).
   * Returns `{ node, covers }`; `covers` is the set of Jellyfin ids the library row shows.
   */
  const buildFilms = (data, extras = []) => {
    const cast = data.cast ?? [];
    const crew = data.crew ?? [];
    const primary = PRIMARY[data.knownFor] ?? "acting";

    const library = new Map();
    // On a crew person's page the job they are known for outranks a cameo.
    for (const credit of primary === "acting" ? [...cast, ...crew] : [...crew, ...cast]) {
      if (!credit.jellyfinId || library.has(creditKey(credit))) continue;
      library.set(creditKey(credit), {
        id: credit.jellyfinId,
        mediaType: credit.mediaType,
        title: credit.title,
        year: credit.year,
        date: credit.releaseDate,
        popularity: credit.popularity,
        role: crew.includes(credit) ? crewLabel(credit) : credit.roles?.[0],
      });
    }
    const held = new Set([...library.values()].map((entry) => entry.id));
    for (const item of extras) {
      if (held.has(item.Id)) continue;
      const mediaType = item.Type === "Series" ? "tv" : "movie";
      const key = item.ProviderIds?.Tmdb ? `${mediaType}:${item.ProviderIds.Tmdb}` : `jellyfin:${item.Id}`;
      if (library.has(key)) continue;
      library.set(key, {
        id: item.Id,
        mediaType,
        title: item.Name,
        year: item.ProductionYear ? String(item.ProductionYear) : null,
        date: item.PremiereDate?.slice(0, 10),
        popularity: 0,
      });
    }

    const rows = {};
    const put = (section, credit) => (rows[section] ??= []).push(credit);
    for (const credit of cast) {
      if (library.has(creditKey(credit))) continue;
      if (credit.appearance) put("appearances", credit);
      else put(primary === "acting" ? (credit.mediaType === "tv" ? "tv" : "films") : "acting", credit);
    }
    for (const credit of crew) {
      if (library.has(creditKey(credit))) continue;
      for (const kind of crewKinds(credit)) put(kind, credit);
    }
    // A title shows once, in the first row that has it: a director's films are also the ones they wrote.
    const seen = new Set();
    const order = [...(ORDER[primary] ?? ORDER.acting), "appearances"].filter((section) => {
      rows[section] = (rows[section] ?? []).filter((credit) => !seen.has(creditKey(credit)));
      rows[section].forEach((credit) => seen.add(creditKey(credit)));
      return rows[section].length > 0;
    });

    const node = el("div", { class: "hera-films hera-seerr" });
    let sort = "popular";

    const sortBar = el(
      "div",
      { class: "hera-films__sort", role: "group", "aria-label": "Sort by" },
      [["popular", "Popular"], ["newest", "Newest"]].map(([key, label]) =>
        el("button", {
          type: "button",
          class: "hera-films__sort-button",
          "data-sort": key,
          "aria-pressed": String(key === sort),
          text: label,
          onclick: () => {
            if (sort === key) return;
            sort = key;
            render();
            sortBar.querySelector(`[data-sort="${key}"]`).focus({ preventScroll: true });
          },
        }),
      ),
    );

    const creditSubtitle = (credit, section) => {
      const crewRow = section !== "films" && section !== "tv" && section !== "acting" && section !== "appearances";
      const label = crewRow ? crewLabel(credit) : section === "appearances" ? null : credit.roles?.[0];
      // Mixed rows (Directed, Written) hold shows as well as films.
      return [label || kindText(credit), credit.year, crewRow && credit.mediaType === "tv" ? "TV Show" : null].filter(Boolean).join(" · ");
    };

    const render = () => {
      const sorter = SORTS[sort];
      const shelves = [];
      const ranked = [...library.values()].sort(sorter);
      if (ranked.length) {
        shelves.push(
          kit.shelf({
            id: "seerr-person-library",
            title: "In Your Library",
            cards: ranked.map((entry) =>
              libraryCard({ id: entry.id, title: entry.title, subtitle: [entry.role || kindText(entry), entry.year].filter(Boolean).join(" · ") }),
            ),
          }),
        );
      }
      for (const section of order) {
        shelves.push(
          kit.shelf({
            id: `seerr-person-${section}`,
            title: SECTION_TITLE[section],
            cards: [...rows[section]]
              .map((credit) => ({ ...credit, date: credit.releaseDate }))
              .sort(sorter)
              .slice(0, MAX_CARDS)
              .map((credit) => discover().itemCard(credit, { subtitle: creditSubtitle(credit, section) })),
          }),
        );
      }
      node.replaceChildren(...shelves);
      const total = ranked.length + order.reduce((sum, section) => sum + rows[section].length, 0);
      if (shelves.length && total > 6) shelves[0].querySelector(".hera-row__head").append(sortBar);
    };
    render();
    return { node, covers: new Set([...library.values()].map((entry) => entry.id)), empty: !node.children.length };
  };

  // ---------- Jellyfin person pages -----------------------------------------------------

  const personItems = (id) =>
    kit
      .getJSON(`Users/${kit.userId()}/Items`, {
        PersonIds: id,
        IncludeItemTypes: "Movie,Series",
        Recursive: true,
        Fields: "ProviderIds,PremiereDate",
      })
      .then((result) => result?.Items ?? [])
      .catch(() => []);

  const stockWatch = { observer: null, timer: 0 };
  const stopStockWatch = () => {
    stockWatch.observer?.disconnect();
    stockWatch.observer = null;
    clearTimeout(stockWatch.timer);
  };

  // Jellyfin's own Movies and Shows sections on a person's page are hidden once the library row
  // holds every title in them; its Episodes section (what Seerr doesn't list) always stays.
  const coverStock = (page, held) => {
    stopStockWatch();
    const cover = () => {
      for (const section of page.querySelectorAll("#childrenContent > .verticalSection")) {
        const cards = [...section.querySelectorAll(".card[data-id]")];
        const covered = cards.length > 0 && cards.every((card) => /^(Movie|Series)$/.test(card.dataset.type) && held.has(card.dataset.id));
        section.classList.toggle("hera-seerr-covered", covered);
      }
    };
    cover();
    const children = page.querySelector("#childrenContent");
    if (!children) return;
    stockWatch.observer = new MutationObserver(cover);
    stockWatch.observer.observe(children, { childList: true, subtree: true });
    stockWatch.timer = setTimeout(stopStockWatch, 10000);
  };

  const mountPerson = async (page, item, tmdbId) => {
    const [data, extras] = await Promise.all([fetchPerson(tmdbId), personItems(item.Id)]);
    if (!isCurrent(page, item.Id) || page.querySelector('[data-hera-seerr="films"]')) return;

    const info = page.querySelector(".detailRibbon .infoWrapper");
    info?.querySelector(".hera-person-role")?.remove();
    if (data.role) info?.querySelector(".nameContainer")?.after(el("p", { class: "hera-person-role", text: data.role }));
    watchBio(info);

    const films = buildFilms(data, extras);
    if (films.empty) return;
    films.node.dataset.heraSeerr = "films";
    const host = page.querySelector(".detailPagePrimaryContent .detailSection");
    if (!host) return;
    host.insertBefore(films.node, host.querySelector("#listChildrenCollapsible"));
    coverStock(page, films.covers);
  };

  // The stock page's biography is drawn by hera-tv.js a moment after the page shows.
  const bioWatch = { observer: null, timer: 0 };
  const watchBio = (info) => {
    bioWatch.observer?.disconnect();
    clearTimeout(bioWatch.timer);
    if (!info) return;
    const place = () => {
      const text = info.querySelector(".hera-detail-overview");
      if (!text) return false;
      addMore(text);
      return true;
    };
    if (place()) return;
    bioWatch.observer = new MutationObserver(() => place() && bioWatch.observer.disconnect());
    bioWatch.observer.observe(info, { childList: true });
    bioWatch.timer = setTimeout(() => bioWatch.observer?.disconnect(), 6000);
  };

  // ---------- a person only Seerr knows -------------------------------------------------

  const view = { root: null, abort: null, tmdb: null, classWatch: null };

  const wantedPerson = () => {
    const [path, query = ""] = window.location.hash.split("?");
    if (!path.startsWith("#/home")) return null;
    const params = new URLSearchParams(query);
    return params.get("hera") === "person" && /^\d+$/.test(params.get("tmdb") || "") ? params.get("tmdb") : null;
  };

  const longDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const buildHeader = (data) => {
    const meta = [
      data.role,
      data.birthday ? `Born ${longDate(data.birthday)}` : null,
      data.deathday ? `Died ${longDate(data.deathday)}` : null,
      data.placeOfBirth,
    ].filter(Boolean);
    const bio = data.biography?.trim() ? el("p", { class: "hera-pv__bio", text: data.biography.trim() }) : null;
    const head = el("header", { class: "hera-pv__head" }, [
      data.profile
        ? el("img", { class: "hera-pv__portrait", src: data.profile, alt: "" })
        : el("span", { class: "hera-pv__portrait hera-pv__portrait--empty", "aria-hidden": "true" }, icon("person")),
      el("div", { class: "hera-pv__who" }, [
        el("h1", { class: "hera-pv__name", text: data.name }),
        meta.length ? el("p", { class: "hera-pv__meta" }, meta.map((text) => el("span", { text }))) : null,
        bio,
      ]),
    ]);
    return { head, bio };
  };

  const stripHomeClass = () => {
    view.classWatch?.disconnect();
    // The home page marks the root for its hero; there is none here, and its header tokens would be wrong on the page's ground.
    root.classList.remove("hera-home");
    view.classWatch = new MutationObserver(() => root.classList.contains("hera-home") && root.classList.remove("hera-home"));
    view.classWatch.observe(root, { attributes: true, attributeFilter: ["class"] });
  };

  const unmountView = () => {
    view.abort?.abort();
    view.abort = null;
    view.root?.remove();
    view.root = null;
    view.tmdb = null;
    view.classWatch?.disconnect();
    view.classWatch = null;
    root.classList.remove("hera-person-on");
  };

  const mountView = async (page, tmdb) => {
    const host = page.querySelector("#homeTab");
    if (!host) return;
    unmountView();
    const abort = (view.abort = new AbortController());
    view.tmdb = tmdb;
    view.root = el("div", { class: "hera-pv hera-seerr", "data-hera-person": tmdb }, [
      el("p", { class: "hera-pv__status", role: "status", text: "Loading…" }),
    ]);
    host.append(view.root);
    root.classList.add("hera-person-on");
    stripHomeClass();
    window.scrollTo(0, 0);
    const mine = view.root;

    try {
      const data = await fetchPerson(tmdb);
      if (abort.signal.aborted) return;
      // Someone the library has has a page of their own.
      if (data.jellyfinId) {
        window.location.replace(`${window.location.pathname}${window.location.search}${detailsHref(data.jellyfinId)}`);
        return;
      }
      const { head, bio } = buildHeader(data);
      const films = buildFilms(data);
      mine.replaceChildren(head, films.empty ? el("p", { class: "hera-pv__status", text: "Seerr has no titles for this person." }) : films.node);
      document.title = data.name;
      if (bio) requestAnimationFrame(() => addMore(bio));
      // A remote needs focus somewhere. The TV layout scrolls focus into view as it lands; while
      // focus is still on that first card, bring the person's header back.
      if (kit.isTv()) {
        const first = mine.querySelector(".hera-card");
        first?.focus({ preventScroll: true });
        setTimeout(() => document.activeElement === first && window.scrollTo(0, 0), 400);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error("[Hera TV:seerr]", error);
      mine.replaceChildren(el("p", { class: "hera-pv__status", role: "alert", text: "Couldn't load this person. Try again in a moment." }));
    }
  };

  const syncView = async (page) => {
    const tmdb = wantedPerson();
    if (!tmdb || page?.id !== "indexPage" || !kit.userId()) {
      if (view.root) unmountView();
      return;
    }
    if (view.tmdb === tmdb && view.root?.isConnected) return;
    const ints = await kit.integrations();
    if (wantedPerson() !== tmdb) return;
    if (!ints.seerr || !discover()) {
      kit.go("#/home");
      return;
    }
    if (view.tmdb === tmdb && view.root?.isConnected) return;
    await mountView(page, tmdb);
  };

  // ---------- More Like This ------------------------------------------------------------

  const mountRelated = async (page, item, tmdbId) => {
    const type = item.Type === "Series" ? "tv" : "movie";
    const [related, similar] = await Promise.all([
      fetchRelated(type, tmdbId).catch(() => null),
      kit
        .getJSON(`Items/${item.Id}/Similar`, { userId: kit.userId(), limit: 12, fields: "ProviderIds,PremiereDate" })
        .then((result) => result?.Items ?? [])
        .catch(() => []),
    ]);
    if (!isCurrent(page, item.Id)) return;
    // Seerr unreachable: Jellyfin's own row stays as it is.
    if (!related?.results?.length) return;

    // Seerr's recommendations in the order it ranks them, each marked when the library holds it;
    // then Jellyfin's own similar titles that Seerr didn't name, so the stock row loses nothing.
    const held = new Set();
    const cards = [];
    const addLibrary = (id, title, year, kind) => {
      if (held.has(id)) return;
      held.add(id);
      cards.push(libraryCard({ id, title, subtitle: [year, kind].filter(Boolean).join(" · "), badge: "In Library" }));
    };
    for (const other of related.results) {
      if (other.jellyfinId) addLibrary(other.jellyfinId, other.title, other.year, kindText(other));
      else cards.push(discover().itemCard(other));
    }
    for (const other of similar) addLibrary(other.Id, other.Name, other.ProductionYear, other.Type === "Series" ? "TV Show" : "Film");

    // Jellyfin keeps earlier detail pages in the document, hidden: look only inside this one.
    const host = page.querySelector(".detailPageSecondaryContainer");
    if (!host) return;
    const row = kit.shelf({ id: "seerr-related", title: "More Like This", cards });
    row.classList.add("hera-seerr");
    row.dataset.heraSeerr = "related";
    page.querySelector('[data-hera-seerr="related"]')?.remove();
    host.insertBefore(row, host.querySelector("#similarCollapsible"));
    page.querySelector("#similarCollapsible")?.classList.add("hera-seerr-covered");
  };

  // ---------- collections ---------------------------------------------------------------

  const futureText = (film) => {
    if (!film.releaseDate) return "To be announced";
    const date = new Date(`${film.releaseDate}T00:00:00`);
    return date > new Date() ? date.toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : film.year;
  };

  // Seerr's id for a box set: its own TMDB id, else the one collection all its films belong to.
  const collectionIdOf = async (item) => {
    if (item.ProviderIds?.Tmdb) return item.ProviderIds.Tmdb;
    const children = await kit
      .getJSON(`Users/${kit.userId()}/Items`, { ParentId: item.Id, Fields: "ProviderIds" })
      .then((result) => result?.Items ?? [])
      .catch(() => []);
    const ids = new Set(children.map((child) => child.ProviderIds?.TmdbCollection).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : null;
  };

  const MISSING_STATUS = { pending: "Requested", processing: "Processing", partial: "Partly Available" };

  // A film the library lacks, on the collection's own shelf in its place: its TMDB art dimmed,
  // and Request (the title sheet) where a library film has Play. `onClose` runs when the sheet
  // closes, so a request made there shows on the shelf.
  const missingCard = (film, onClose) => {
    const status = MISSING_STATUS[film.status] ?? "Not in Your Library";
    const card = kit.shelfCard({
      image: film.backdrop ?? film.poster,
      numbered: true,
      name: film.title,
      overview: film.overview,
      meta: [futureText(film), status].filter(Boolean).join(" · "),
      className: "is-missing",
      label: `${film.title}, ${futureText(film)}, ${status}`,
      action: {
        icon: MISSING_STATUS[film.status] ? "schedule" : "add",
        run: (event) => discover().openTitle(film, { opener: event.currentTarget, onClose: () => onClose(film) }),
      },
    });
    card.dataset.heraSeerr = "collection";
    card.dataset.heraTmdb = String(film.tmdbId);
    return card;
  };

  const mountCollection = async (page, item) => {
    const [collectionId, ints, handle] = await Promise.all([collectionIdOf(item), kit.integrations(), kit.collectionShelf(page, item.Id)]);
    if (!collectionId || !handle || !isCurrent(page, item.Id)) return;
    const data = await fetchCollection(collectionId).catch(() => null);
    if (!data || !isCurrent(page, item.Id) || !handle.section.isConnected || handle.section.querySelector('[data-hera-seerr="collection"]')) return;

    let current = data;
    let notice = null;
    let busy = false;

    const paint = () => {
      handle.section.querySelectorAll('[data-hera-seerr="collection"]').forEach((node) => node.remove());
      const missing = current.parts.filter((film) => !film.jellyfinId);
      for (const film of missing) handle.place(missingCard(film, refresh), film.releaseDate);
      handle.refit();
      const count = current.requestable.length;
      if (ints.seerrLinked && count) {
        handle.head.append(
          el(
            "button",
            {
              type: "button",
              class: "hera-btn hera-btn--glass hera-btn--text hera-seerr__action",
              "data-hera-seerr": "collection",
              disabled: busy,
              "aria-busy": busy ? "true" : null,
              onclick: requestMissing,
            },
            [icon(busy ? "hourglass_top" : "add"), busy ? "Requesting…" : `Request ${count === 1 ? "Missing Film" : `${count} Missing Films`}`],
          ),
        );
      }
      if (notice) {
        handle.shelf.after(
          el("p", { class: `hera-note hera-note--${notice.tone}`, role: notice.tone === "error" ? "alert" : "status", "data-hera-seerr": "collection" }, [
            icon(notice.tone === "error" ? "error_outline" : "check_circle"),
            notice.text,
          ]),
        );
      }
    };

    // After the title sheet closes: fetch the collection again and repaint, keeping focus on the
    // film that was open.
    const refresh = async (film) => {
      memo.delete(`collection:${data.id}`);
      try {
        current = await fetchCollection(data.id);
      } catch {
        return;
      }
      if (busy || !handle.section.isConnected) return;
      const hadFocus = handle.section.contains(document.activeElement);
      paint();
      if (hadFocus) handle.shelf.querySelector(`[data-hera-tmdb="${film.tmdbId}"]`)?.focus({ preventScroll: true });
    };

    const requestMissing = async () => {
      if (busy) return;
      busy = true;
      notice = null;
      paint();
      try {
        const result = await kit.hera(`discover/collections/${data.id}/request`, { method: "POST" });
        notice = result.failed
          ? { tone: "error", text: `Requested ${plural(result.requested, "film")}; ${plural(result.failed, "film")} couldn't be sent.` }
          : { tone: "ok", text: `Requested ${plural(result.requested, "film")}.` };
      } catch (error) {
        notice = { tone: "error", text: errorStatus(error) === 403 ? "Your Jellyfin account isn't linked to Seerr." : (await errorMessage(error)) || "Couldn't send the request. Try again in a moment." };
      }
      memo.delete(`collection:${data.id}`);
      try {
        current = await fetchCollection(data.id);
      } catch {
        /* the cards keep their last state */
      }
      busy = false;
      if (!handle.section.isConnected) return;
      paint();
      handle.head.querySelector(".hera-seerr__action")?.focus({ preventScroll: true });
    };

    paint();
    // Missing films before the next one push it along; bring it back into view.
    handle.reveal();
  };

  // ---------- detail pages --------------------------------------------------------------

  const isCurrent = (page, itemId) => kit.itemIdFromHash() === itemId && !page.classList.contains("hide");

  // Jellyfin reuses one page element for every item; what was added for the last one goes first.
  const clean = (page, itemId) => {
    if (page.dataset.heraSeerrItem === itemId) return;
    page.dataset.heraSeerrItem = itemId || "";
    stopStockWatch();
    page.querySelectorAll("[data-hera-seerr]").forEach((node) => node.remove());
    page.querySelectorAll(".hera-person-role, .hera-more").forEach((node) => node.remove());
    page.querySelectorAll(".hera-seerr-covered").forEach((node) => node.classList.remove("hera-seerr-covered"));
  };

  const busy = new Set();

  const onDetails = async (page, itemId) => {
    clean(page, itemId);
    const ints = await kit.integrations();
    if (!ints.seerr || !discover()) return;
    const item = await kit.api().getItem(kit.userId(), itemId);
    if (!item || !isCurrent(page, itemId)) return;
    const tmdbId = item.ProviderIds?.Tmdb;
    const key = `${item.Type}:${itemId}`;
    if (busy.has(key)) return;
    busy.add(key);
    try {
      if (item.Type === "Person" && tmdbId) await mountPerson(page, item, tmdbId);
      else if ((item.Type === "Movie" || item.Type === "Series") && tmdbId) await mountRelated(page, item, tmdbId);
      else if (item.Type === "BoxSet") await mountCollection(page, item);
    } finally {
      busy.delete(key);
    }
  };

  const onHash = () => requestAnimationFrame(() => syncView(document.querySelector(".page:not(.hide)")));

  const start = () => {
    listen(window, "hashchange", onHash);
  };

  HT.register({
    name: "seerr",
    async onView(page, { itemId }) {
      if (!kit.userId()) return;
      await syncView(page);
      if (page.id === "itemDetailPage" && itemId) await onDetails(page, itemId);
    },
    teardown() {
      unmountView();
      stopStockWatch();
      bioWatch.observer?.disconnect();
      clearTimeout(bioWatch.timer);
      document.querySelectorAll("[data-hera-seerr], .hera-person-role, .hera-more").forEach((node) => node.remove());
      document.querySelectorAll(".hera-seerr-covered").forEach((node) => node.classList.remove("hera-seerr-covered"));
      cleanups.splice(0).forEach((fn) => fn());
    },
  });

  start();
})();
