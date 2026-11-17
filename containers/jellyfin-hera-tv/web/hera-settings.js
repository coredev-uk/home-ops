/*
 * Hera TV: the Settings app (user preferences) in the Apple TV app's Settings idiom.
 *
 * Jellyfin's `#/mypreferencesmenu` is a plain list of links. This module draws a Settings app
 * in its place: a sidebar of sections and, beside it, inset grouped lists whose rows are
 * switches, pickers and links. Every change saves the moment it is made (user configuration
 * through the server, a quiet "Saved" capsule as confirmation); nothing has a Save button.
 *
 * What is saved where:
 *  - user configuration (`Users/Configuration`): autoplay, audio and subtitle preferences,
 *    Recently Added filters. These follow the user to every device.
 *  - Hera's appearance: HeraTV.kit.appearance (display-preferences record + localStorage).
 *  - layout and skip-intro/credits behaviour: localStorage, exactly where Jellyfin's own
 *    pages keep them (they are per browser by design: a TV and a laptop differ).
 * The stock page's own markup is kept (hidden): its links to other pages and anything another
 * plugin adds to it are mirrored into the "More" section, so nothing is lost.
 */
(() => {
  "use strict";

  const kit = window.HeraTV && window.HeraTV.kit;
  if (!kit) return;
  const { el, icon, api, userId, getJSON, appearance, isTv } = kit;

  const PAGE_ID = "myPreferencesMenuPage";
  const SECTION_KEY = "hera-settings-section";

  // Jellyfin's stock pages this app links to, by what each one still does that we do not.
  const STOCK = {
    display: "#/mypreferencesdisplay",
    home: "#/mypreferenceshome",
    playback: "#/mypreferencesplayback",
    subtitles: "#/mypreferencessubtitles",
    controls: "#/mypreferencescontrols",
    profile: "#/userprofile",
    quickconnect: "#/quickconnect",
  };

  const SUBTITLE_MODES = [
    ["Default", "Default", "The file's default and forced subtitle tracks."],
    ["Smart", "Smart", "Subtitles in your language, only when the audio is in another."],
    ["Always", "Always on", "Subtitles in your language with every title."],
    ["OnlyForced", "Forced only", "Only the forced subtitles a title marks."],
    ["None", "Off", "Subtitles never load on their own."],
  ];
  const SEGMENT_ACTIONS = [
    ["AskToSkip", "Ask to skip", "A Skip button appears; nothing happens until you press it."],
    ["Skip", "Skip automatically", "Playback jumps past it without asking."],
    ["None", "Do nothing", "Play it through."],
  ];

  const LAYOUTS = [
    ["auto", "Automatic"],
    ["desktop", "Desktop"],
    ["tv", "TV"],
  ];

  // The web client's display languages (its own Display page lists these; "" is Automatic).
  const UI_LANGUAGES = [
    ["af", "Afrikaans"],
    ["ar", "العربية"],
    ["be-BY", "Беларуская"],
    ["bg-BG", "Български"],
    ["bn_BD", "বাংলা (বাংলাদেশ)"],
    ["ca", "Català"],
    ["cs", "Čeština"],
    ["cy", "Cymraeg"],
    ["da", "Dansk"],
    ["de", "Deutsch"],
    ["el", "Ελληνικά"],
    ["en-GB", "English (United Kingdom)"],
    ["en-US", "English"],
    ["eo", "Esperanto"],
    ["es", "Español"],
    ["es_419", "Español americano"],
    ["es-AR", "Español (Argentina)"],
    ["es_DO", "Español (Dominicana)"],
    ["es-MX", "Español (México)"],
    ["et", "Eesti"],
    ["eu", "Euskara"],
    ["fa", "فارسی"],
    ["fi", "Suomi"],
    ["fil", "Filipino"],
    ["fr", "Français"],
    ["fr-CA", "Français (Canada)"],
    ["gl", "Galego"],
    ["gsw", "Schwiizerdütsch"],
    ["he", "עִבְרִית"],
    ["hi-IN", "हिन्दी"],
    ["hr", "Hrvatski"],
    ["hu", "Magyar"],
    ["id", "Bahasa Indonesia"],
    ["is-IS", "Íslenska"],
    ["it", "Italiano"],
    ["ja", "日本語"],
    ["kk", "Qazaqşa"],
    ["ko", "한국어"],
    ["lt-LT", "Lietuvių"],
    ["lv", "Latviešu"],
    ["mk", "Македонски"],
    ["ml", "മലയാളം"],
    ["mr", "मराठी"],
    ["ms", "Bahasa Melayu"],
    ["nb", "Norsk bokmål"],
    ["ne", "नेपाली"],
    ["nl", "Nederlands"],
    ["nn", "Norsk nynorsk"],
    ["pa", "ਪੰਜਾਬੀ"],
    ["pl", "Polski"],
    ["pr", "Pirate"],
    ["pt", "Português"],
    ["pt-BR", "Português (Brasil)"],
    ["pt-PT", "Português (Portugal)"],
    ["ro", "Românește"],
    ["ru", "Русский"],
    ["sk", "Slovenčina"],
    ["sl-SI", "Slovenščina"],
    ["sq", "Shqip"],
    ["sr", "Српски"],
    ["sv", "Svenska"],
    ["ta", "தமிழ்"],
    ["te", "తెలుగు"],
    ["th", "ภาษาไทย"],
    ["tr", "Türkçe"],
    ["uk", "Українська"],
    ["ur_PK", "اُردُو"],
    ["vi", "Tiếng Việt"],
    ["zh-CN", "汉语 (简化字)"],
    ["zh-TW", "漢語 (繁体字)"],
  ];

  let ctx = null; // the mounted app, if any
  let mountToken = 0;
  let saveChain = Promise.resolve();

  // ---------- data ----------------------------------------------------------------------

  const loadUser = (id) => getJSON(`Users/${id}`);

  /** Saves run one after another: each is a read-modify-write of the whole configuration. */
  const queued = (task) => {
    const run = saveChain.then(task);
    saveChain = run.catch(() => {});
    return run;
  };

  const saveConfig = (change) =>
    queued(async () => {
      const user = await loadUser(ctx.user.Id);
      const config = { ...user.Configuration, ...change };
      await api().updateUserConfiguration(user.Id, config);
      ctx.user = { ...user, Configuration: config };
    });

  // Jellyfin keeps these two per browser: the layout under a bare key, a segment's behaviour
  // under "<userId>-segmentTypeAction__<Type>" (see its media-segment settings).
  const segmentKey = (type) => `${ctx.user.Id}-segmentTypeAction__${type}`;
  const readSegment = (type) => {
    try {
      return localStorage.getItem(segmentKey(type)) || "AskToSkip";
    } catch {
      return "AskToSkip";
    }
  };
  // The display language lives with the user's other per-browser settings: "<userId>-language".
  const languageKey = () => `${ctx.user.Id}-language`;
  const readLanguage = () => {
    try {
      return localStorage.getItem(languageKey()) || "";
    } catch {
      return "";
    }
  };
  const readLayout = () => {
    try {
      const value = localStorage.getItem("layout");
      return value === "desktop" || value === "tv" ? value : "auto";
    } catch {
      return "auto";
    }
  };

  const languages = () => {
    const seen = new Map();
    for (const culture of ctx.cultures) {
      const code = culture.ThreeLetterISOLanguageName;
      if (code && culture.DisplayName && !seen.has(code)) seen.set(code, culture.DisplayName);
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => [code, name]);
  };
  const languageName = (code) => {
    if (!code) return "No preference";
    const culture = ctx.cultures.find(
      (c) => c.ThreeLetterISOLanguageName === code || (c.ThreeLetterISOLanguageNames || []).includes(code) || c.TwoLetterISOLanguageName === code,
    );
    return culture ? culture.DisplayName : code;
  };

  // ---------- feedback --------------------------------------------------------------------

  let toastTimer = 0;
  const say = (message, tone) => {
    const toast = ctx && ctx.toast;
    if (!toast) return;
    toast.replaceChildren(icon(tone === "error" ? "error_outline" : "check"), el("span", { text: message }));
    toast.classList.toggle("is-error", tone === "error");
    toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-on"), tone === "error" ? 4000 : 1800);
  };
  const saved = () => say("Saved");
  const failed = () => say("Couldn't save. Check your connection and try again.", "error");

  // ---------- pieces ----------------------------------------------------------------------

  const withClass = (node, name) => {
    node.classList.add(name);
    return node;
  };

  const avatar = (user, size, extra = "") =>
    user.PrimaryImageTag
      ? el("img", {
          class: `hera-set-avatar ${extra}`.trim(),
          alt: "",
          src: api().getUrl(`Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: size * 2, quality: 90 }),
        })
      : el("span", { class: `hera-set-avatar ${extra}`.trim(), "aria-hidden": "true", text: (user.Name || "?").slice(0, 1).toUpperCase() });

  const button = (label, { primary = false, onclick, type = "button", iconName } = {}) => {
    const node = el("button", { class: `hera-set-btn${primary ? " hera-set-btn--primary" : ""}`, type }, [
      iconName ? icon(iconName) : null,
      el("span", { text: label }),
    ]);
    if (onclick) node.addEventListener("click", onclick);
    return node;
  };

  /** One row of a grouped list. A link when `href` is given, a button otherwise. */
  const row = ({ icon: iconName, label, description, value, chevron, href, onclick }) => {
    const children = [
      iconName ? el("span", { class: "hera-set-row__icon" }, icon(iconName)) : null,
      el("span", { class: "hera-set-row__text" }, [
        el("span", { class: "hera-set-row__label", text: label }),
        description ? el("span", { class: "hera-set-row__desc", text: description }) : null,
      ]),
      value !== undefined ? el("span", { class: "hera-set-row__value", text: value }) : null,
      chevron ? withClass(icon("chevron_right"), "hera-set-row__chev") : null,
    ];
    const node = href ? el("a", { class: "hera-set-row", href }, children) : el("button", { class: "hera-set-row", type: "button" }, children);
    if (onclick) node.addEventListener("click", onclick);
    return node;
  };

  const switchRow = ({ icon: iconName, label, description, checked, save }) => {
    const track = el("span", { class: "hera-set-switch", "aria-hidden": "true" }, el("span", { class: "hera-set-switch__knob" }));
    const node = el("button", { class: "hera-set-row", type: "button", role: "switch", "aria-checked": String(!!checked) }, [
      iconName ? el("span", { class: "hera-set-row__icon" }, icon(iconName)) : null,
      el("span", { class: "hera-set-row__text" }, [
        el("span", { class: "hera-set-row__label", text: label }),
        description ? el("span", { class: "hera-set-row__desc", text: description }) : null,
      ]),
      track,
    ]);
    node.addEventListener("click", async () => {
      const next = node.getAttribute("aria-checked") !== "true";
      node.setAttribute("aria-checked", String(next));
      try {
        await save(next);
        saved();
      } catch (error) {
        console.error("[Hera TV:settings]", error);
        node.setAttribute("aria-checked", String(!next));
        failed();
      }
    });
    return node;
  };

  /** Two or three exclusive choices on one row, as a segmented control. */
  const segmentedRow = ({ icon: iconName, label, description, options, value, save }) => {
    const group = el("div", { class: "hera-set-seg", role: "radiogroup", "aria-label": label });
    const buttons = options.map(([key, text]) =>
      el("button", { class: "hera-set-seg__option", type: "button", role: "radio", "aria-checked": String(key === value), text }),
    );
    buttons.forEach((node, i) => {
      node.addEventListener("click", async () => {
        const key = options[i][0];
        if (node.getAttribute("aria-checked") === "true") return;
        const previous = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
        buttons.forEach((b, j) => b.setAttribute("aria-checked", String(j === i)));
        try {
          await save(key);
          saved();
        } catch (error) {
          console.error("[Hera TV:settings]", error);
          buttons.forEach((b, j) => b.setAttribute("aria-checked", String(j === previous)));
          failed();
        }
      });
    });
    group.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const at = buttons.indexOf(document.activeElement);
      const to = buttons[at + (e.key === "ArrowRight" ? 1 : -1)];
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      to.focus();
    });
    group.append(...buttons);
    return el("div", { class: "hera-set-row hera-set-row--static" }, [
      iconName ? el("span", { class: "hera-set-row__icon" }, icon(iconName)) : null,
      el("span", { class: "hera-set-row__text" }, [
        el("span", { class: "hera-set-row__label", text: label }),
        description ? el("span", { class: "hera-set-row__desc", text: description }) : null,
      ]),
      group,
    ]);
  };

  /** A row showing its current value that opens a list of choices. */
  const pickRow = ({ icon: iconName, label, description, options, get, save, searchable }) => {
    const all = () => (typeof options === "function" ? options() : options);
    const nameOf = (value) => {
      const found = all().find(([key]) => key === value);
      return found ? found[1] : value;
    };
    const node = row({ icon: iconName, label, description, value: nameOf(get()), chevron: true });
    node.setAttribute("aria-haspopup", "dialog");
    node.addEventListener("click", () =>
      openPicker({
        title: label,
        options: all(),
        value: get(),
        searchable,
        onPick: async (value) => {
          try {
            await save(value);
            node.querySelector(".hera-set-row__value").textContent = nameOf(value);
            saved();
          } catch (error) {
            console.error("[Hera TV:settings]", error);
            failed();
          }
        },
      }),
    );
    return node;
  };

  const group = ({ title, rows, footer }) => {
    const foot = footer ? el("p", { class: "hera-set-group__foot", text: footer }) : null;
    const node = el("section", { class: "hera-set-group", "aria-label": title || undefined }, [
      title ? el("h2", { class: "hera-set-group__title", text: title }) : null,
      el("div", { class: "hera-set-list" }, rows.filter(Boolean)),
      foot,
    ]);
    node.foot = foot;
    return node;
  };

  // ---------- sheets and pickers -------------------------------------------------------------

  /** A glass sheet over the page. Focus returns to what opened it. */
  const sheet = ({ title, body }) => {
    const opener = document.activeElement;
    const close = el("button", { class: "hera-set-sheet__close", type: "button", "aria-label": "Close" }, icon("close"));
    const panel = el("div", { class: "hera-set-sheet__panel" }, [
      el("header", { class: "hera-set-sheet__head" }, [el("h2", { class: "hera-set-sheet__title", text: title }), close]),
      body,
    ]);
    const dialog = el("dialog", { class: "hera-set-sheet", "aria-label": title }, panel);
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    // Back belongs to the sheet while it is open: Jellyfin would otherwise also leave the page.
    // webOS (461) and Tizen (10009) remotes send their own Back keys.
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.keyCode === 461 || e.keyCode === 10009 || e.key === "GoBack") {
        e.preventDefault();
        e.stopPropagation();
        dialog.close();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (opener && opener.isConnected) opener.focus();
    });
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  };

  const openPicker = ({ title, options, value, onPick, searchable }) => {
    const list = el("div", { class: "hera-set-options", role: "listbox", "aria-label": title });
    const items = options.map(([key, label, description]) => {
      const selected = key === value;
      const node = el("button", { class: "hera-set-option", type: "button", role: "option", "aria-selected": String(selected), "data-search": label.toLowerCase() }, [
        el("span", { class: "hera-set-option__text" }, [
          el("span", { class: "hera-set-option__label", text: label }),
          description ? el("span", { class: "hera-set-option__desc", text: description }) : null,
        ]),
        icon("check"),
      ]);
      node.addEventListener("click", () => {
        dialog.close();
        if (key !== value) onPick(key);
      });
      return node;
    });
    list.append(...items);

    let search = null;
    if (searchable) {
      search = el("input", { class: "hera-set-input hera-set-search", type: "search", placeholder: "Search", "aria-label": `Search ${title.toLowerCase()}`, autocomplete: "off" });
      search.addEventListener("input", () => {
        const query = search.value.trim().toLowerCase();
        items.forEach((node) => (node.hidden = !!query && !node.dataset.search.includes(query)));
      });
    }
    const body = el("div", { class: "hera-set-sheet__body" }, [search, list]);
    const dialog = sheet({ title, body });
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const visible = items.filter((node) => !node.hidden);
      const at = visible.indexOf(document.activeElement);
      if (e.key === "ArrowUp" && at <= 0 && search) {
        e.preventDefault();
        search.focus();
        return;
      }
      const to = visible[e.key === "ArrowDown" ? Math.min(at + 1, visible.length - 1) : Math.max(at - 1, 0)];
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      to.focus();
    });
    // Start on the current choice, so a long list opens where you are.
    const current = items.find((node) => node.getAttribute("aria-selected") === "true");
    const first = current || items[0];
    if (first && !(searchable && !current)) {
      first.focus();
      first.scrollIntoView({ block: "center" });
    } else if (search) {
      search.focus();
    }
  };

  const field = ({ label, type = "text", autocomplete, inputmode, maxlength, placeholder }) => {
    const input = el("input", { class: "hera-set-input", type, autocomplete, inputmode, maxlength, placeholder, "aria-label": label });
    return { input, node: el("label", { class: "hera-set-field" }, [el("span", { class: "hera-set-field__label", text: label }), input]) };
  };

  // ---------- profile actions ---------------------------------------------------------------

  const openQuickConnect = () => {
    const code = field({ label: "Quick Connect code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "000000" });
    const status = el("p", { class: "hera-set-status", role: "status", text: "Enter the six-digit code a TV or phone shows to sign it in as you." });
    const form = el("form", { class: "hera-set-form" }, [code.node, status, button("Sign In", { primary: true, type: "submit" })]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = code.input.value.trim();
      if (!/^\d{6}$/.test(value)) {
        status.textContent = "The code is six digits.";
        status.classList.add("is-error");
        code.input.focus();
        return;
      }
      status.classList.remove("is-error");
      try {
        await api().ajax({ type: "POST", url: api().getUrl("QuickConnect/Authorize", { code: value }) });
        status.textContent = "Signed in. The device continues on its own.";
        code.input.value = "";
      } catch {
        status.textContent = "That code has expired or was mistyped. Ask the device for a new one.";
        status.classList.add("is-error");
      }
    });
    const dialog = sheet({ title: "Quick Connect", body: el("div", { class: "hera-set-sheet__body" }, form) });
    code.input.focus();
    return dialog;
  };

  const openPassword = () => {
    const current = field({ label: "Current password", type: "password", autocomplete: "current-password" });
    const next = field({ label: "New password", type: "password", autocomplete: "new-password" });
    const again = field({ label: "Confirm new password", type: "password", autocomplete: "new-password" });
    const status = el("p", { class: "hera-set-status", role: "status" });
    const form = el("form", { class: "hera-set-form" }, [current.node, next.node, again.node, status, button("Change Password", { primary: true, type: "submit" })]);
    const problem = (message) => {
      status.textContent = message;
      status.classList.add("is-error");
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      status.classList.remove("is-error");
      if (!next.input.value) return problem("Enter a new password.");
      if (next.input.value !== again.input.value) return problem("The two new passwords don't match.");
      try {
        await api().updateUserPassword(ctx.user.Id, current.input.value, next.input.value);
        dialog.close();
        say("Password changed");
      } catch {
        problem("The current password is wrong, or the new one isn't allowed.");
      }
    });
    const dialog = sheet({ title: "Password", body: el("div", { class: "hera-set-sheet__body" }, form) });
    current.input.focus();
  };

  const pickPhoto = () => {
    const input = el("input", { type: "file", accept: "image/*", hidden: true });
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        await api().uploadUserImage(ctx.user.Id, "Primary", file);
        await refreshUser();
        saved();
      } catch (error) {
        console.error("[Hera TV:settings]", error);
        say("That image couldn't be used. Try a JPEG or PNG.", "error");
      }
    });
    document.body.append(input);
    input.click();
  };

  const removePhoto = async () => {
    try {
      await api().deleteUserImage(ctx.user.Id, "Primary");
      await refreshUser();
      saved();
    } catch (error) {
      console.error("[Hera TV:settings]", error);
      failed();
    }
  };

  const refreshUser = async () => {
    ctx.user = await loadUser(ctx.user.Id);
    renderNav();
    renderPane();
  };

  // ---------- sections ----------------------------------------------------------------------

  const isLocalAccount = () => /DefaultAuthenticationProvider/.test((ctx.user.Policy && ctx.user.Policy.AuthenticationProviderId) || "");
  const isAdmin = () => !!(ctx.user.Policy && ctx.user.Policy.IsAdministrator);
  const config = () => ctx.user.Configuration || {};

  const sections = [
    {
      id: "profile",
      icon: "person",
      label: "Profile",
      build() {
        const user = ctx.user;
        const head = el("header", { class: "hera-set-profile" }, [
          avatar(user, 96, "hera-set-avatar--xl"),
          el("div", { class: "hera-set-profile__who" }, [
            el("h1", { class: "hera-set-profile__name", text: user.Name }),
            el("p", { class: "hera-set-profile__role", text: isAdmin() ? "Administrator" : "Member" }),
            el("div", { class: "hera-set-profile__actions" }, [
              button(user.PrimaryImageTag ? "Change Photo" : "Add Photo", { onclick: pickPhoto, iconName: "photo_camera" }),
              user.PrimaryImageTag ? button("Remove", { onclick: removePhoto }) : null,
            ]),
          ]),
        ]);
        const account = [
          ctx.quickConnect
            ? row({ icon: "devices", label: "Quick Connect", description: "Sign in a TV or phone with its code", chevron: true, onclick: openQuickConnect })
            : null,
          isLocalAccount() ? row({ icon: "lock", label: "Password", chevron: true, onclick: openPassword }) : null,
        ];
        return [
          head,
          account.some(Boolean) ? group({ title: "Account", rows: account }) : null,
          group({
            rows: [
              row({
                icon: "logout",
                label: "Sign Out",
                onclick: () => {
                  if (window.Dashboard && window.Dashboard.logout) window.Dashboard.logout();
                },
              }),
            ],
          }),
        ];
      },
    },
    {
      id: "appearance",
      icon: "contrast",
      label: "Appearance",
      title: "Appearance",
      build() {
        // These two are read when the client starts, so each says so and offers the reload.
        const needsReload = (list, what) => {
          list.foot.replaceChildren(document.createTextNode(`${what} changes after Hera TV reloads. `), button("Reload Now", { onclick: () => window.location.reload() }));
        };
        const display = group({
          title: "Display",
          rows: [
            segmentedRow({
              icon: "contrast",
              label: "Appearance",
              description: "Automatic follows this device.",
              options: kit.appearances.map(([key, text]) => [key, text]),
              value: appearance.pref,
              save: (key) => appearance.set(key),
            }),
            segmentedRow({
              icon: "tv",
              label: "Layout",
              description: "Desktop suits a mouse; TV suits a remote.",
              options: LAYOUTS,
              value: readLayout(),
              save: async (key) => {
                if (key === "auto") localStorage.removeItem("layout");
                else localStorage.setItem("layout", key);
                needsReload(display, "Layout");
              },
            }),
          ],
          footer: "Layout is remembered on this browser only.",
        });
        const language = group({
          title: "Language",
          rows: [
            pickRow({
              icon: "language",
              label: "Language",
              description: "English (United Kingdom) spells Favourites and Films.",
              options: [["", "Automatic"], ...UI_LANGUAGES],
              get: readLanguage,
              save: async (value) => {
                if (value) localStorage.setItem(languageKey(), value);
                else localStorage.removeItem(languageKey());
                needsReload(language, "Language");
              },
              searchable: true,
            }),
          ],
          footer: "Remembered on this browser only.",
        });
        return [display, language, group({ rows: [row({ icon: "tune", label: "More display options", description: "Date and time, item details, themes", href: `${STOCK.display}?userId=${ctx.user.Id}`, chevron: true })] })];
      },
    },
    {
      id: "playback",
      icon: "play_circle",
      label: "Playback",
      title: "Playback",
      build() {
        const c = config();
        return [
          group({
            title: "Episodes",
            rows: [
              switchRow({
                icon: "skip_next",
                label: "Autoplay next episode",
                description: "Continue to the next episode when one ends.",
                checked: c.EnableNextEpisodeAutoPlay,
                save: (v) => saveConfig({ EnableNextEpisodeAutoPlay: v }),
              }),
            ],
          }),
          group({
            title: "Audio",
            rows: [
              pickRow({
                icon: "translate",
                label: "Preferred audio language",
                options: () => [["", "No preference"], ...languages()],
                get: () => config().AudioLanguagePreference || "",
                save: (v) => saveConfig({ AudioLanguagePreference: v }),
                searchable: true,
              }),
              switchRow({
                icon: "graphic_eq",
                label: "Play default audio track",
                description: "Use the file's default track, whatever its language.",
                checked: c.PlayDefaultAudioTrack,
                save: (v) => saveConfig({ PlayDefaultAudioTrack: v }),
              }),
              switchRow({
                icon: "history",
                label: "Remember audio choice",
                description: "Keep the track you pick for the next episode.",
                checked: c.RememberAudioSelections,
                save: (v) => saveConfig({ RememberAudioSelections: v }),
              }),
            ],
          }),
          group({
            title: "Skipping",
            rows: ["Intro", "Outro"].map((type) =>
              pickRow({
                icon: type === "Intro" ? "fast_forward" : "movie",
                label: type === "Intro" ? "Intros" : "Credits",
                options: SEGMENT_ACTIONS,
                get: () => readSegment(type),
                save: async (v) => localStorage.setItem(segmentKey(type), v),
              }),
            ),
            footer: "Remembered on this browser only.",
          }),
          group({ rows: [row({ icon: "tune", label: "More playback options", description: "Quality, skip length, transcoding", href: `${STOCK.playback}?userId=${ctx.user.Id}`, chevron: true })] }),
        ];
      },
    },
    {
      id: "subtitles",
      icon: "closed_caption",
      label: "Subtitles",
      title: "Subtitles",
      build() {
        const c = config();
        return [
          group({
            rows: [
              pickRow({
                icon: "subtitles",
                label: "Subtitle mode",
                options: SUBTITLE_MODES,
                get: () => config().SubtitleMode || "Default",
                save: (v) => saveConfig({ SubtitleMode: v }),
              }),
              pickRow({
                icon: "translate",
                label: "Preferred subtitle language",
                options: () => [["", "No preference"], ...languages()],
                get: () => config().SubtitleLanguagePreference || "",
                save: (v) => saveConfig({ SubtitleLanguagePreference: v }),
                searchable: true,
              }),
              switchRow({
                icon: "history",
                label: "Remember subtitle choice",
                description: "Keep the track you pick for the next episode.",
                checked: c.RememberSubtitleSelections,
                save: (v) => saveConfig({ RememberSubtitleSelections: v }),
              }),
            ],
          }),
          group({ rows: [row({ icon: "format_size", label: "Subtitle appearance", description: "Size, colour, font and position", href: `${STOCK.subtitles}?userId=${ctx.user.Id}`, chevron: true })] }),
        ];
      },
    },
    {
      id: "home",
      icon: "home",
      label: "Home",
      title: "Home",
      build() {
        const c = config();
        const excluded = () => new Set(config().LatestItemsExcludes || []);
        const libraries = ctx.views.map((view) =>
          switchRow({
            icon: view.CollectionType === "movies" ? "movie" : view.CollectionType === "tvshows" ? "tv" : view.CollectionType === "music" ? "library_music" : "video_library",
            label: view.Name,
            checked: !excluded().has(view.Id),
            save: (on) => {
              const next = excluded();
              if (on) next.delete(view.Id);
              else next.add(view.Id);
              return saveConfig({ LatestItemsExcludes: [...next] });
            },
          }),
        );
        return [
          group({
            title: "Recently Added",
            rows: [
              switchRow({
                icon: "visibility_off",
                label: "Unwatched only",
                description: "Hide titles you have already watched.",
                checked: c.HidePlayedInLatest,
                save: (v) => saveConfig({ HidePlayedInLatest: v }),
              }),
            ],
          }),
          libraries.length ? group({ title: "Libraries in Recently Added", rows: libraries }) : null,
          group({ rows: [row({ icon: "tune", label: "More home screen options", description: "Home sections and library order", href: `${STOCK.home}?userId=${ctx.user.Id}`, chevron: true })] }),
        ];
      },
    },
    {
      id: "more",
      icon: "more_horiz",
      label: "More",
      title: "More",
      build() {
        const own = [
          row({ icon: "gamepad", label: "Controls", description: "Gamepad and smooth scrolling", href: `${STOCK.controls}?userId=${ctx.user.Id}`, chevron: true }),
          row({ icon: "person", label: "Profile page", href: `${STOCK.profile}?userId=${ctx.user.Id}`, chevron: true }),
        ];
        const extras = stockExtras();
        const mirror = (item) =>
          row({
            icon: item.icon,
            label: item.label,
            chevron: true,
            href: item.href || undefined,
            onclick: item.href ? undefined : (e) => {
              e.preventDefault();
              item.node.click();
            },
          });
        const admin = extras.filter((item) => item.admin).map(mirror);
        // Hera TV's own page in the Dashboard: Seerr and Maintainerr setup, and the home switches.
        if (isAdmin()) {
          admin.push(
            row({
              icon: "tv",
              label: "Hera TV",
              description: "Seerr, Maintainerr, and what Home and Discover show",
              chevron: true,
              href: "#/configurationpage?name=HeraTV",
            }),
          );
        }
        const plugins = extras.filter((item) => !item.admin).map(mirror);
        return [
          group({ title: "Settings", rows: own }),
          plugins.length ? group({ title: "Plugins", rows: plugins }) : null,
          admin.length ? group({ title: "Administration", rows: admin }) : null,
        ];
      },
    },
  ];

  // Links on Jellyfin's own menu that this app does not draw itself: Dashboard and Metadata
  // Manager for admins, and whatever plugins add. Plugin links without a destination open
  // their own panel when the hidden original is clicked.
  const KNOWN = ["userprofile", "quickconnect", "mypreferencesdisplay", "mypreferenceshome", "mypreferencesplayback", "mypreferencessubtitles", "mypreferencescontrols"];
  const stockExtras = () => {
    const out = [];
    ctx.page.querySelectorAll(".readOnlyContent a.listItem-border").forEach((node) => {
      if (ctx.root.contains(node)) return;
      const href = node.getAttribute("href") || "";
      const label = (node.querySelector(".listItemBodyText") || node).textContent.trim();
      if (!label || /^sign out$/i.test(label) || KNOWN.some((name) => href.includes(`#/${name}`))) return;
      const mark = node.querySelector(".listItemIcon");
      const iconName = mark ? [...mark.classList].filter((c) => !/^(material-icons|listItemIcon|listItemIcon-transparent)$/.test(c)).pop() : null;
      out.push({ label, href: href && href !== "#" ? href : null, node, icon: iconName || "chevron_right", admin: !!node.closest(".adminSection") });
    });
    return out;
  };

  // ---------- shell -------------------------------------------------------------------------

  const renderNav = () => {
    const user = ctx.user;
    const items = sections.map((section) => {
      const selected = section.id === ctx.section;
      const profile = section.id === "profile";
      const node = el(
        "button",
        {
          class: `hera-set-nav__item${profile ? " hera-set-nav__item--profile" : ""}`,
          type: "button",
          "aria-current": selected ? "page" : undefined,
          "data-section": section.id,
        },
        profile
          ? [
              avatar(user, 56),
              el("span", { class: "hera-set-nav__who" }, [
                el("span", { class: "hera-set-nav__name", text: user.Name }),
                el("span", { class: "hera-set-nav__role", text: isAdmin() ? "Administrator" : "Member" }),
              ]),
            ]
          : [icon(section.icon), el("span", { text: section.label })],
      );
      node.addEventListener("click", () => select(section.id));
      return node;
    });
    ctx.nav.replaceChildren(...items);
  };

  const renderPane = () => {
    const section = sections.find((s) => s.id === ctx.section) || sections[0];
    const nodes = section.build().filter(Boolean);
    const title = section.title ? el("h1", { class: "hera-set-title", text: section.title }) : null;
    ctx.pane.replaceChildren(...[title, ...nodes].filter(Boolean));
    // One authored moment: the pane settles in when the section changes.
    ctx.pane.classList.remove("is-in");
    void ctx.pane.offsetWidth;
    ctx.pane.classList.add("is-in");
  };

  const select = (id) => {
    if (id === ctx.section) return;
    ctx.section = id;
    try {
      sessionStorage.setItem(SECTION_KEY, id);
    } catch {
      /* the choice just isn't remembered */
    }
    ctx.nav.querySelectorAll(".hera-set-nav__item").forEach((node) => {
      if (node.dataset.section === id) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    });
    renderPane();
  };

  const stockReady = async (page) => {
    for (let i = 0; i < 30; i++) {
      if (page.querySelector(".readOnlyContent a.listItem-border")) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const unmount = () => {
    if (!ctx) return;
    document.querySelectorAll(".hera-set-sheet").forEach((dialog) => dialog.close());
    if (ctx.observer) ctx.observer.disconnect();
    if (ctx.unsubscribe) ctx.unsubscribe();
    ctx.root.remove();
    ctx.page.classList.remove("hera-set-page");
    clearTimeout(toastTimer);
    ctx = null;
  };

  const mount = async (page, user) => {
    const token = ++mountToken;
    page.classList.add("hera-set-page");
    await stockReady(page);
    const [full, cultures, views, quickConnect] = await Promise.all([
      loadUser(user),
      getJSON("Localization/Cultures").catch(() => []),
      getJSON("UserViews", { userId: user }).then((r) => (r && r.Items) || []).catch(() => []),
      getJSON("QuickConnect/Enabled").catch(() => false),
    ]);
    if (token !== mountToken || !page.isConnected) return;
    unmount();
    let remembered = null;
    try {
      remembered = sessionStorage.getItem(SECTION_KEY);
    } catch {
      /* default */
    }
    const nav = el("nav", { class: "hera-set__nav", "aria-label": "Settings sections" });
    const pane = el("main", { class: "hera-set__pane" });
    const toast = el("div", { class: "hera-set__toast", role: "status", "aria-live": "polite" });
    const root = el("div", { class: "hera-set" }, [nav, pane, toast]);
    ctx = {
      page,
      root,
      nav,
      pane,
      toast,
      user: full,
      cultures: cultures || [],
      views,
      quickConnect: quickConnect === true,
      section: sections.some((s) => s.id === remembered) ? remembered : "profile",
      mountedAt: Date.now(),
    };
    nav.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const buttons = [...nav.querySelectorAll("button")];
      const to = buttons[buttons.indexOf(document.activeElement) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      to.focus();
    });
    page.append(root);
    renderNav();
    renderPane();
    // Plugins add their menu links after the page first draws; keep "More" current.
    const stock = page.querySelector(".readOnlyContent");
    if (stock) {
      let pending = false;
      ctx.observer = new MutationObserver(() => {
        if (pending || !ctx || ctx.section !== "more") return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          if (ctx && ctx.section === "more") renderPane();
        });
      });
      ctx.observer.observe(stock, { childList: true, subtree: true });
    }
    // The Control Center can change appearance too; the segmented row follows unless it is being used.
    ctx.unsubscribe = appearance.subscribe(() => {
      if (ctx && ctx.section === "appearance" && !ctx.pane.contains(document.activeElement)) renderPane();
    });
    // A remote starts on the section list, as tvOS Settings does.
    if (isTv()) requestAnimationFrame(() => nav.querySelector('[aria-current="page"]') && nav.querySelector('[aria-current="page"]').focus());
  };

  // The stock subpages (Display, Playback, Subtitles, ...) lead back to the Settings app.
  const mountBackLink = (page) => {
    if (!page.classList.contains("userPreferencesPage")) return;
    const host = [...page.children].find((child) => child.classList.contains("padded-left"));
    if (!host || host.querySelector(".hera-set-back")) return;
    host.prepend(el("a", { class: "hera-set-back", href: "#/mypreferencesmenu" }, [icon("chevron_left"), el("span", { text: "Settings" })]));
  };

  window.HeraTV.register({
    name: "settings",
    async onView(page, { params }) {
      if (page.id !== PAGE_ID) {
        unmount();
        mountBackLink(page);
        return;
      }
      // Someone else's preferences (an admin's view of another account) keep Jellyfin's page.
      const target = params.get("userId");
      if (target && target !== userId()) return;
      // viewshow and the hashchange fallback both land here; one mount serves both.
      if (ctx && ctx.page === page && ctx.root.isConnected && Date.now() - ctx.mountedAt < 1500) return;
      try {
        await mount(page, userId());
      } catch (error) {
        console.error("[Hera TV:settings]", error);
        // Better Jellyfin's own list than an empty page.
        page.classList.remove("hera-set-page");
      }
    },
    teardown() {
      mountToken++;
      unmount();
    },
  });
})();
