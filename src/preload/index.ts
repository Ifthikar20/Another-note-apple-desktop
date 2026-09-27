/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from "electron";

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
    const state = { right, background, dark: document.documentElement.classList.contains("dark") };
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
    attributeFilter: ["class", "style", "data-state", "data-collapsible"],
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

if (location.protocol === "app:" || location.protocol === "http:" || location.protocol === "https:") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reportChrome);
  else reportChrome();
}
