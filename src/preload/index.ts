/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webFrame } from "electron";

/*
  The bridge between the web app and the desktop shell. Deliberately tiny: the web app
  can tell it is running on the desktop (window.anothernotes is undefined in a browser)
  and which version, and it can sign in: with an email and password or a child's PIN
  (signin.ts in the main process, which checks every argument), or through the browser
  (auth.ts). Nothing else is exposed, and every call is a fixed channel. This file runs
  sandboxed, with context isolation, so the page never sees Node.
*/

const VERSION_FLAG = "--anothernotes-version=";
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_FLAG));

contextBridge.exposeInMainWorld(
  "anothernotes",
  Object.freeze({
    platform: process.platform,
    version: versionArg ? versionArg.slice(VERSION_FLAG.length) : "",
    auth: Object.freeze({
      /** Sign in with an email and password; on success the window moves to the dashboard. */
      signIn: (form: { email: string; password: string }): Promise<unknown> =>
        ipcRenderer.invoke("auth:sign-in", { email: form?.email, password: form?.password }),
      /** Sign in to a child's profile with its username and PIN. */
      signInWithPin: (form: { username: string; pin: string }): Promise<unknown> =>
        ipcRenderer.invoke("auth:sign-in-with-pin", { username: form?.username, pin: form?.pin }),
      /** Sign in through the system browser; the app comes back signed in on its own. */
      signInWithBrowser: (): Promise<void> => ipcRenderer.invoke("auth:sign-in-with-browser"),
      /** Show the app's sign-in screen in this window. */
      signInHere: (): Promise<void> => ipcRenderer.invoke("auth:sign-in-here"),
      /** Forget a browser sign-in that was started and not finished. */
      cancelBrowserSignIn: (): Promise<void> => ipcRenderer.invoke("auth:cancel-browser-sign-in"),
    }),
  }),
);

/*
  The window's tab bar sits over the content column, starting where the web app's
  sidebar ends (windows.ts). The page is the only one that knows where that is, so this
  reports it, and the sidebar's colour, whenever either changes: the sidebar resized or
  folded away, the theme switched, another page shown. -1 means the page has no sidebar.
  It also reports a dialog's backdrop while one is open (a full-window layer the web app
  dims itself with), so the tab bar, which sits above the page, can be dimmed with it.
*/
function reportChrome(): void {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = (): void => {
    timer = undefined;
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    const shell = document.querySelector(".peer ~ main");
    let right = -1;
    if (shell) {
      const box = sidebar?.getBoundingClientRect();
      right = box && box.width > 0 && box.right > 0 ? Math.round(box.right) : 0;
    }
    const painted = sidebar ?? document.body;
    const background = painted ? getComputedStyle(painted).backgroundColor : "";
    let scrim = "";
    for (const el of Array.from(document.querySelectorAll('[data-state="open"]'))) {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" || /rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor)) continue;
      const box = el.getBoundingClientRect();
      if (box.left <= 0 && box.top <= 0 && box.right >= innerWidth - 1 && box.bottom >= innerHeight - 1) {
        scrim = style.backgroundColor;
        break;
      }
    }
    const state = { right, background, scrim, dark: document.documentElement.classList.contains("dark") };
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    ipcRenderer.send("chrome:layout", state);
  };
  const soon = (): void => {
    if (timer === undefined) timer = setTimeout(report, 60);
  };
  new MutationObserver(soon).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-state", "data-collapsible", "data-scroll-locked"],
  });
  window.addEventListener("resize", soon);
  document.addEventListener("transitionend", soon, true);
  report();
}

/*
  document.cookie on the bundled web app. Chromium keeps cookies only for http(s), so on
  the app's own scheme (app://anothernotes) every cookie the web app sets is dropped, and
  the preferences it keeps there (the sidebar docked or not) reset at each launch. This
  gives the page a small cookie store in its localStorage instead, installed in the
  page's own world before any of its scripts run. The server's cookies are unaffected:
  they never reach the page (server.ts keeps them in the main process).
*/
if (location.protocol === "app:") {
  contextBridge.executeInMainWorld({
    func: () => {
      const KEY = "__anothernotes_cookies";
      type Jar = Record<string, { value: string; expires: number | null }>;
      const load = (): Jar => {
        try {
          return JSON.parse(localStorage.getItem(KEY) || "{}") as Jar;
        } catch {
          return {};
        }
      };
      const save = (jar: Jar): void => {
        try {
          localStorage.setItem(KEY, JSON.stringify(jar));
        } catch {
          /* storage full or blocked: the cookie lasts as long as the page */
        }
      };
      const live = (jar: Jar): Jar => {
        const now = Date.now();
        for (const name of Object.keys(jar)) {
          const expires = jar[name].expires;
          if (expires !== null && expires <= now) delete jar[name];
        }
        return jar;
      };
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        get(): string {
          const jar = live(load());
          return Object.keys(jar)
            .map((name) => `${name}=${jar[name].value}`)
            .join("; ");
        },
        set(line: string) {
          const [pair, ...attributes] = String(line).split(";");
          const eq = pair.indexOf("=");
          if (eq <= 0) return;
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          let expires: number | null = null;
          for (const attribute of attributes) {
            const [key, ...rest] = attribute.split("=");
            const k = key.trim().toLowerCase();
            const v = rest.join("=").trim();
            if (k === "max-age") expires = Date.now() + Number(v) * 1000;
            else if (k === "expires" && expires === null) expires = Date.parse(v);
          }
          const jar = live(load());
          if (expires !== null && (Number.isNaN(expires) || expires <= Date.now())) delete jar[name];
          else jar[name] = { value, expires };
          save(jar);
        },
      });
    },
  });
}

/*
  Room in the web app's layout for the window's chrome, in place before the web app
  draws anything (a style added after its first paint would make the page jump). The
  selectors are the sidebar component's: its header, above whose brand block the window
  buttons sit and whose strip moves the window, and the inset content card, which starts
  below the tab bar (44px, TOOLBAR_HEIGHT in windows.ts).
*/
const SHELL_CSS = `
  @media (min-width: 768px) {
    .peer ~ main { margin-top: 44px !important; height: calc(100svh - 44px - 0.5rem) !important; min-height: 0 !important; }
    [data-sidebar="header"] { padding-top: ${process.platform === "darwin" ? 40 : 8}px !important; -webkit-app-region: drag; }
    [data-sidebar="header"] :is(a, button, input, select, textarea, [role="button"], [role="combobox"], [tabindex]) {
      -webkit-app-region: no-drag;
    }
  }
`;

/*
  Links routed before the page follows them. Notes and learning sessions open in tabs
  and everything else in the home page (windows.ts), so a link that leads across that
  line is handed to the app instead: a note clicked in the home page's sidebar opens in
  its tab while the home page stays as it was, and "Dashboard" clicked in a note's tab
  shows the home page while the tab keeps its note. Links within the page's own side of
  the line, and anything the page handles itself, go on as usual. The app says which
  role this page has (home, note, or a page out of sight, which routes nothing).
*/
let role = "";
ipcRenderer.on("tabs:role", (_event, value: unknown) => {
  role = typeof value === "string" ? value : "";
});

/** The note or session a path shows (the same rule as noteKey in windows.ts), or null. */
function noteOf(pathname: string): string | null {
  const where = pathname.replace(/\/+$/, "");
  const note = where.match(/^\/dashboard\/note\/([^/]+)$/);
  if (note) return note[1];
  const study = where.match(/^\/dashboard\/([^/]+)\/full-study$/);
  if (study) return study[1];
  return where === "/dashboard/full-study" ? "full-study" : null;
}

function routeLinks(): void {
  window.addEventListener(
    "click",
    (event) => {
      if (role !== "home" && role !== "note") return;
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const to = new URL(link.href, location.href);
      if (to.protocol !== location.protocol || to.host !== location.host) return;
      const there = noteOf(to.pathname);
      const here = noteOf(location.pathname);
      const elsewhere = role === "home" ? there !== null : there === null || there !== here;
      if (!elsewhere) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send("nav:open", `${to.pathname}${to.search}${to.hash}`);
    },
    true,
  );
}

if (location.protocol === "app:" || location.protocol === "http:" || location.protocol === "https:") {
  webFrame.insertCSS(SHELL_CSS);
  routeLinks();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reportChrome);
  else reportChrome();
}

/*
  One sidebar for the window. Each tab is its own copy of the web app, which reads
  whether its sidebar is docked once, as it starts; so when it is docked or folded in
  one tab, the others follow. The setting lives in the pages' shared cookie store (the
  localStorage one above): a change there reaches every other page as a storage event,
  and a page also checks as it comes on screen (it may have started while the setting
  was changing). A page whose sidebar is the other way docks or folds it with the web
  app's own ⌘B.
*/
function followSidebar(jar: string | null): void {
  let docked: string | undefined;
  try {
    docked = (JSON.parse(jar || "{}") as Record<string, { value?: string }>)["sidebar:docked"]?.value;
  } catch {
    return;
  }
  if (docked !== "true" && docked !== "false") return;
  const state = document.querySelector(".peer[data-state]")?.getAttribute("data-state");
  if (!state || (state === "expanded") === (docked === "true")) return;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", metaKey: true, bubbles: true, cancelable: true }));
}

if (location.protocol === "app:") {
  window.addEventListener("storage", (event) => {
    if (event.key === "__anothernotes_cookies") followSidebar(event.newValue);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    try {
      followSidebar(localStorage.getItem("__anothernotes_cookies"));
    } catch {
      /* storage blocked: the page keeps the sidebar it has */
    }
  });
}
