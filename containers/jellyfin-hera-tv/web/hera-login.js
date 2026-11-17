/* Hera TV: sign-in page. Registers with window.HeraTV (hera-tv.js). */
(() => {
  "use strict";
  const core = window.HeraTV;
  if (!core?.kit) return;
  const { el, icon } = core.kit;

  const root = document.documentElement;
  const userId = () => window.ApiClient?.getCurrentUserId?.() || "";
  const CACHE_KEY = "hera-login";
  const FORM_ID = "heraManualLogin";

  /** The server's name and whether the sign-in disclaimer carries a single sign-on link, from the last visit. */
  const readCache = () => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch {
      return {};
    }
  };
  const writeCache = (value) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
      /* private mode: the page just waits for the network */
    }
  };

  const publicJSON = async (path) => {
    const response = await fetch(new URL(`../${path}`, document.baseURI), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };

  let login = null;
  const cleanups = [];

  /* ---- Quick Connect dialog: the code, large, with what to do with it ------------------ */

  const enhanceQuickConnect = (dialog) => {
    if (dialog.dataset.heraQuick) return;
    const text = dialog.querySelector(".dialogContentInner .text");
    const code = text?.textContent.match(/\d[\d\s]{3,}\d/)?.[0].replace(/\s+/g, "");
    if (!text || !code) return;
    dialog.dataset.heraQuick = "1";
    const grouped = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
    text.replaceChildren(
      el("div", { class: "hera-qc__code", role: "text", "aria-label": `Code ${code.split("").join(" ")}`, text: grouped }),
      el("p", { class: "hera-qc__hint", text: "Open Quick Connect on a device that is already signed in, and enter this code." }),
    );
  };

  // Dialogs Jellyfin opens while nobody is signed in: Quick Connect, and alerts such as a failed sign-in.
  const watchDialogs = () => {
    const seen = (node) => {
      if (!(node instanceof HTMLElement) || !root.classList.contains("hera-signed-out")) return;
      const dialog = node.classList.contains("formDialog") ? node : node.querySelector?.(".formDialog");
      if (!dialog) return;
      dialog.classList.add("hera-auth-dialog");
      if (dialog.id === "quickConnectAlert") enhanceQuickConnect(dialog);
    };
    const observer = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(seen)));
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  };
  cleanups.push(watchDialogs());

  /* ---- The sign-in page ------------------------------------------------------------- */

  const build = (page) => {
    const stack = page.querySelector(".margin-auto-y");
    const form = page.querySelector(".manualLoginForm");
    const visual = page.querySelector(".visualLoginForm");
    const actions = page.querySelector(".readOnlyContent");
    if (!stack || !form || !visual || !actions) return null;

    const cached = readCache();
    const state = {
      page,
      name: cached.name || "",
      sso: cached.sso ?? null, // null until we know whether there is a single sign-on button to lead with
      open: false,
      users: false,
      stopped: false,
    };

    const name = el("h1", { class: "hera-login__name", text: state.name });
    const brand = el("header", { class: "hera-login__brand" }, [
      name,
      el("p", { class: "hera-login__lede", text: "Sign in to start watching" }),
    ]);
    page.querySelectorAll(".hera-login__brand, .hera-login__toggle").forEach((n) => n.remove());
    stack.classList.add("hera-login__stack");
    stack.prepend(brand);

    // One column in reading order, so Tab and the remote's arrows meet the single sign-on button
    // first, then Quick Connect, then the password route. Jellyfin finds every one of these
    // elements through the page, so moving them keeps its handlers.
    form.id = FORM_ID;
    const disclaimer = page.querySelector(".loginDisclaimerContainer");
    if (disclaimer) actions.prepend(disclaimer);
    stack.insertBefore(actions, form);

    const toggle = el(
      "button",
      { type: "button", class: "hera-login__toggle", "aria-expanded": "false", "aria-controls": FORM_ID },
      [el("span", { text: "Sign in with a password" }), icon("expand_more")],
    );
    const quick = actions.querySelector(".btnQuick");
    if (quick) quick.after(toggle);
    else actions.append(toggle);

    // Forgotten passwords only matter once the password form is open: it lives inside it.
    const forgot = actions.querySelector(".btnForgotPassword");
    const submit = form.querySelector(".button-submit");
    if (forgot && submit) {
      forgot.classList.add("hera-login__quiet");
      submit.after(forgot);
    }
    page.querySelectorAll(".btnSelectServer").forEach((b) => b.classList.add("hera-login__quiet"));

    const field = () => form.querySelector("#txtManualName");

    const render = () => {
      const bare = state.sso === false;
      page.classList.add("hera-login");
      page.classList.toggle("hera-login--pending", state.sso === null);
      page.classList.toggle("hera-login--sso", state.sso === true);
      page.classList.toggle("hera-login--users", state.users);
      page.classList.toggle("hera-login--form", state.open || bare || state.users);
      page.classList.toggle("hera-login--open", state.open);
      toggle.setAttribute("aria-expanded", String(state.open));
    };

    const setOpen = (open, focus) => {
      state.open = open;
      render();
      if (open && focus) requestAnimationFrame(() => field()?.focus());
      if (!open) {
        const password = form.querySelector("#txtManualPassword");
        if (password) password.value = "";
        if (focus) toggle.focus();
      }
    };

    const onToggle = () => setOpen(!state.open, true);
    const onKey = (event) => {
      if (event.key !== "Escape" || !state.open || state.sso !== true) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, true);
    };
    toggle.addEventListener("click", onToggle);
    form.addEventListener("keydown", onKey);

    // A server that lists its users shows cards; Jellyfin swaps the form in and out itself.
    const syncUsers = () => {
      state.users = !visual.classList.contains("hide");
      render();
    };
    const usersObserver = new MutationObserver(syncUsers);
    usersObserver.observe(visual, { attributes: true, attributeFilter: ["class"] });
    syncUsers();

    // The remote needs something to move from: HyperionID leads. Jellyfin draws that button
    // after its own request for the branding, so wait for it.
    let focused = false;
    const focusLead = () => {
      if (focused || state.stopped || !core.kit.isTv()) return;
      const lead = actions.querySelector(".sso-login button");
      if (!lead || state.sso === null) return;
      focused = true;
      if (!document.activeElement?.matches?.("input")) lead.focus({ preventScroll: true });
    };
    const disclaimerObserver = new MutationObserver(focusLead);
    const disclaimerBox = page.querySelector(".loginDisclaimer");
    if (disclaimerBox) disclaimerObserver.observe(disclaimerBox, { childList: true });

    Promise.allSettled([publicJSON("System/Info/Public"), publicJSON("Branding/Configuration")]).then(([info, branding]) => {
      if (state.stopped) return;
      if (info.status === "fulfilled" && info.value?.ServerName) state.name = info.value.ServerName;
      // With no single sign-on button the password form is the only way in: show it. A failed
      // lookup is not cached, so one hiccup does not decide the next visit.
      if (branding.status === "fulfilled") {
        state.sso = /<(button|a)[\s>]/i.test(branding.value?.LoginDisclaimer || "");
        writeCache({ name: state.name, sso: state.sso });
      } else if (state.sso === null) {
        state.sso = false;
      }
      name.textContent = state.name || "Sign in";
      render();
      focusLead();
    });

    render();

    return {
      page,
      reset() {
        setOpen(false, false);
      },
      destroy() {
        state.stopped = true;
        toggle.removeEventListener("click", onToggle);
        form.removeEventListener("keydown", onKey);
        usersObserver.disconnect();
        disclaimerObserver.disconnect();
        const password = form.querySelector("#txtManualPassword");
        if (password) password.value = "";
        brand.remove();
        stack.classList.remove("hera-login__stack");
        toggle.remove();
        page.classList.remove("hera-login", "hera-login--pending", "hera-login--sso", "hera-login--users", "hera-login--form", "hera-login--open");
      },
    };
  };

  /** The forgot-password, reset, add-server and select-server pages: signed-out standalone pages. */
  let authPage = null;
  const markAuth = (page) => {
    if (authPage === page) return;
    authPage?.classList.remove("hera-auth");
    authPage = page;
    authPage?.classList.add("hera-auth");
  };

  const leave = () => {
    login?.destroy();
    login = null;
  };

  const show = (page) => {
    const isLogin = page?.id === "loginPage";
    const signedOut = !!page?.classList.contains("standalonePage") && (isLogin || !userId());
    root.classList.toggle("hera-signed-out", signedOut);
    markAuth(signedOut && !isLogin ? page : null);
    if (!isLogin) return leave();
    if (login?.page === page) return login.reset();
    leave();
    login = build(page);
  };

  const onViewShow = (event) => {
    const page = event.target?.closest?.(".page") || event.target;
    if (page instanceof HTMLElement) show(page);
  };
  document.addEventListener("viewshow", onViewShow);
  cleanups.push(() => document.removeEventListener("viewshow", onViewShow));

  // The page may already be showing when this script arrives.
  show(document.querySelector(".page:not(.hide)"));

  core.register({
    name: "login",
    teardown() {
      leave();
      root.classList.remove("hera-signed-out");
      markAuth(null);
      cleanups.splice(0).forEach((fn) => fn());
    },
  });
})();
