import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  WebContentsView,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import path from "node:path";
import { APP_ORIGIN, APP_URL, originOf, SITE_ORIGIN, WEBSITE_URL } from "./config";
import { appEvents } from "./events";
import { openExternal } from "./links";
import { watchLessonAudio } from "./media";
import { loadWindowState, saveWindowState } from "./store";

/*
  The main window, laid out like a Mac app rather than a browser:

    ┌─ ● ● ● ───────────┬─ ‹ ›  [ Chapter 3 notes × ][ Photosynthesis ]  + ──┐  tab bar (static/toolbar.html)
    │ the web app's      │                                                     │
    │ sidebar, full      │   the web app's page                                │
    │ height             │                                                     │
    └────────────────────┴─────────────────────────────────────────────────────┘

  There is no title bar. As in Notion, the web app's sidebar runs the full height with
  the window buttons on it, and the app's own tab bar sits over the content column,
  starting where the sidebar ends and following it as it is resized or folded away
  (the page's preload reports the edge and makes room for the bar).

  Tabs are for notes and learning sessions only. Everything else (the dashboard,
  folders, calendar, profile) lives in one home page behind the tabs, which the sidebar
  and the Go menu show; it is never a tab.

  Pages. Each is a view of the web app (a WebContentsView) in one of these roles:

    home     the dashboard and the rest: one page, never a tab
    note     a note's or learning session's tab
    spare    the web app, loaded and out of sight, waiting to become the next tab
    closing  a tab on its way out

  Opening a note takes the spare and moves it to the note inside the web app (a route
  change, no reload), so the tab shows in the time the note itself takes, and a new
  spare loads in the background. A closing tab first leaves its note the way the web
  app expects, with a route change away from it (an empty new note is deleted, pending
  progress is sent), then becomes the spare or goes; the last tab becomes the home
  page, so the home page shows the lists it has just changed.

  Links are routed before the page follows them (the preload asks): a note opens in its
  tab from anywhere, any other page shows in the home page, and the page clicked in
  stays as it was. When the web app moves by itself instead (a button, a note deleted),
  the page that moved takes the role its route calls for: a home page that opened a
  note becomes that note's tab and the spare becomes the home page; a tab that left its
  note becomes the home page.

  The pages share one session, so signing in or out is for all of them; while the
  sign-in screen shows there are no tabs and no tab bar. Pages out of sight load again
  in the background when the server confirms a change to the lists they show
  (events.ts), so the sidebar and the dashboard are current when they come back.
*/

/** The tab bar's height; the preload makes the same room in the web app's layout. */
const TOOLBAR_HEIGHT = 44;
/** Room the window buttons need at the window's left edge. */
const LIGHTS_WIDTH = 84;
/** A new spare loads this long after the last one was taken, once the new tab has settled. */
const SPARE_DELAY_MS = 1500;
/** Time a closing tab's leaving requests get to go out before the page goes. */
const LEAVE_MS = 700;
/** Pages out of sight load again this long after the last change to the lists. */
const REFRESH_DELAY_MS = 1200;

type Role = "home" | "note" | "spare" | "closing";

interface Page {
  id: number;
  role: Role;
  /** A note's tab: the note or session it shows ("new" while it is being made). */
  key: string | null;
  /** Its own last route: where the home page is, or the note a tab shows. */
  lastUrl: string;
  view: WebContentsView;
  /** A note's tab: its name, read from the page. */
  title: string;
  /** Showing the sign-in screen: the tab bar hides while it does. */
  signIn: boolean;
  /**
   * The web app's document is in (committed): a spare can become a tab. Its router need
   * not have started yet; it starts on whatever route the page has moved to by then.
   */
  booted: boolean;
  /** Playing sound: a lesson, which keeps full speed even out of sight. */
  audible: boolean;
  /** Its lists changed on the server since it loaded: it loads again when out of sight. */
  stale: boolean;
  /** Its history starts over when it arrives at its own route (it changed role). */
  clearHistory?: boolean;
  /** Put back one step: the step forward (to where the link led) is dropped on arrival. */
  pruneForward?: boolean;
  /** Loading behind the sign-in screen: called when it has drawn its layout (openAfterSignIn). */
  incoming?: () => void;
  /**
   * Reported by the page: the sidebar's right edge (-1: no sidebar), its colour, and the
   * backdrop of a dialog that is open ("" when none), which the tab bar dims itself with.
   */
  chrome?: { right: number; background: string; dark: boolean; scrim: string };
}

let mainWindow: BrowserWindow | null = null;
let toolbar: WebContentsView | null = null;
let pages: Page[] = [];
let activeId = 0;
let nextPageId = 1;
let theme: { background: string; dark: boolean } | null = null;
let titleTimer: NodeJS.Timeout | undefined;
let spareTimer: NodeJS.Timeout | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
/** The window is closing and its tabs are leaving their notes first. */
let closingWindow = false;
/** The app is quitting (⌘Q): once the tabs have left, the quit goes on. */
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

/** Set by index.ts: starts the sign-in through the browser (auth.ts), without a circular import. */
let browserSignIn: () => void = () => undefined;
export function setBrowserSignIn(start: () => void): void {
  browserSignIn = start;
}

/** What the window opens on: the web app (a session exists) or the app's sign-in screen. */
export type FirstPage = "app" | "signin";

/**
 * Google refuses to sign in from inside an Electron window (its "disallowed_useragent"
 * page), so the app explains instead of showing that page and offers the browser.
 */
const GOOGLE_SIGNIN_HOSTS = new Set(["accounts.google.com"]);

/**
 * Top-level navigations to these API paths start a round trip through another site
 * (Microsoft or SAML sign-in, connecting a note source) that ends back on the app's own
 * callback URL. While one is in flight, other hosts may load in the page.
 */
const ROUND_TRIP_PREFIXES = ["/api/auth/", "/api/sources/"];

/**
 * The loading screen stays up at least this long (no flash, and its pencil has written a
 * line) and at most this long (no hang).
 */
const SPLASH_MIN_MS = 1100;
const SPLASH_MAX_MS = 15000;

/** A small frameless window with the loading animation, shown while the first page loads. */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 380,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "AnotherNote",
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.once("ready-to-show", () => {
    if (!splash.isDestroyed()) splash.show();
  });
  void splash.loadFile(path.join(app.getAppPath(), "static", "loading.html"));
  return splash;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

const isAppUrl = (url: string): boolean => {
  try {
    return originOf(url) === APP_ORIGIN;
  } catch {
    return false;
  }
};

/**
 * The web app's own sign-in pages. The desktop has its screen for signing in
 * (static/signin.html), so a visit to one of these shows that instead: the web app
 * sends a signed-out user to /auth, and its sign-out lands there too. The landing page
 * is the website's front door, so the app goes to the dashboard (or sign-in) instead.
 */
const SIGN_IN_PATHS = new Set(["/auth", "/kids"]);
const pathOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return originOf(url) === APP_ORIGIN ? u.pathname.replace(/\/+$/, "") || "/" : null;
  } catch {
    return null;
  }
};

/** A URL for the log: never its fragment, which carries the access token after a sign-in. */
const forLog = (url: string): string => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : `${url.slice(0, hash)}#…`;
};

const startsRoundTrip = (url: string): boolean => {
  try {
    const { pathname } = new URL(url);
    return originOf(url) === APP_ORIGIN && ROUND_TRIP_PREFIXES.some((p) => pathname.startsWith(p));
  } catch {
    return false;
  }
};

/** A tab's name when the page gives none: from its route. */
function routeLabel(url: string): string {
  if (url.startsWith("file:")) {
    if (url.includes("/signin.html")) return "Sign in";
    if (url.includes("/offline.html")) return "Offline";
  }
  const where = pathOf(url) ?? "";
  if (where === "/dashboard") return "Home";
  if (where === "/dashboard/note/new") return "New note";
  if (where.startsWith("/dashboard/note/") || where.endsWith("/full-study")) return "Note";
  if (where === "/dashboard/folders") return "Folders";
  if (where.startsWith("/dashboard/folder/")) return "Folder";
  if (where === "/dashboard/calendar") return "Calendar";
  if (where === "/dashboard/profile") return "Profile";
  if (where.startsWith("/dashboard/family")) return "Family";
  if (where === "/dashboard/help") return "Help";
  if (where === "/dashboard/search") return "Search";
  return "AnotherNote";
}

/**
 * The note or learning session a URL shows, or null for any other page of the web app.
 * A note and its full study are one session, so they share a tab. The preload has the
 * same rule, to route links before the page follows them.
 */
function noteKey(url: string): string | null {
  const where = pathOf(url);
  if (!where) return null;
  const note = where.match(/^\/dashboard\/note\/([^/]+)$/);
  if (note) return note[1];
  const study = where.match(/^\/dashboard\/([^/]+)\/full-study$/);
  if (study) return study[1];
  if (where === "/dashboard/full-study") return "full-study";
  return null;
}

/**
 * The page's own name for itself: on a note, its title field (so the tab follows a
 * rename as it is typed); elsewhere the last crumb of the web app's header, or the
 * page's main heading.
 */
const READ_TITLE = `(() => {
  const field = document.querySelector('input[aria-label="Note title"]');
  if (field) return field.value.trim() || "Untitled";
  const el = document.querySelector('main header [aria-current="page"]') || document.querySelector("main h1");
  return el ? el.textContent.trim() : "";
})()`;

/** A note or session on screen: its title field or heading, off the dashboard and the new-note page. */
const READ_READY = `(() => {
  const p = location.pathname;
  if (p === "/dashboard" || p === "/dashboard/note/new") return "";
  const field = document.querySelector('input[aria-label="Note title"]');
  if (field) return field.value.trim() || "Untitled";
  const h = document.querySelector("main h1");
  return h ? h.textContent.trim() : "";
})()`;

/** Log how long a note took from the click to being on screen, and whether a spare was ready. */
function measureOpen(contents: WebContents, started: number, how: "warm" | "cold" | "in place"): void {
  const check = (): void => {
    if (contents.isDestroyed()) return;
    contents
      .executeJavaScript(READ_READY, false)
      .then((title: unknown) => {
        if (typeof title === "string" && title) {
          console.log(`[tabs] ${how} open: "${title.slice(0, 40)}" on screen in ${Date.now() - started} ms`);
        } else if (Date.now() - started < 10000) setTimeout(check, 16);
      })
      .catch(() => {
        if (Date.now() - started < 10000) setTimeout(check, 16);
      });
  };
  check();
}

const activePage = (): Page | undefined => pages.find((p) => p.id === activeId);
const homePage = (): Page | undefined => pages.find((p) => p.role === "home");
const noteTabs = (): Page[] => pages.filter((p) => p.role === "note");
const hasSpare = (): boolean => pages.some((p) => p.role === "spare");
const pageOf = (contents: WebContents): Page | undefined => pages.find((p) => p.view.webContents === contents);
const shown = (page: Page): boolean => page.role === "home" || page.role === "note";

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Bring the main window to the front, creating it if it was closed (macOS keeps the app running). */
export function focusMainWindow(): BrowserWindow {
  const win = getMainWindow() ?? createMainWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

/** The page showing: a note's tab or the home page. What the menus act on. */
export function activeContents(): WebContents | undefined {
  const page = activePage();
  return page && !page.view.webContents.isDestroyed() ? page.view.webContents : undefined;
}

/** Load a URL in the home page and show it (a sign-in's landing page, a deep link). */
export function loadHome(url: string): void {
  focusMainWindow();
  const home = homePage() ?? newPage("home", null);
  selectPage(home.id);
  void home.view.webContents.loadURL(url);
}

/** The sign-in screen's send-off (its paper plane) lasts this long; the web app takes over no sooner. */
const SEND_OFF_MS = 950;

/**
 * After signing in: the web app loads out of sight while the sign-in screen sends it
 * off, and takes the screen's place once it has drawn its layout, so the window goes
 * from signing in straight to the dashboard with nothing blank in between. If that page
 * goes (a failed hand-over), or no sign-in screen is showing, the URL loads in the home
 * page as before.
 */
export function openAfterSignIn(url: string): void {
  const screen = homePage();
  if (!getMainWindow() || !screen?.signIn) {
    loadHome(url);
    return;
  }
  const started = Date.now();
  const next = newPage("spare", null);
  let done = false;
  const takeOver = (): void => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    setTimeout(() => {
      next.incoming = undefined;
      if (!pages.includes(next) || next.view.webContents.isDestroyed()) {
        loadHome(url);
        return;
      }
      next.role = "home";
      next.lastUrl = isAppUrl(next.view.webContents.getURL()) ? next.view.webContents.getURL() : APP_URL;
      next.view.webContents.setAudioMuted(false);
      sendRole(next);
      if (pages.includes(screen) && screen !== next) destroyPage(screen);
      selectPage(next.id);
      next.view.webContents.navigationHistory.clear();
      scheduleSpare(2500);
    }, Math.max(0, started + SEND_OFF_MS - Date.now()));
  };
  next.incoming = takeOver;
  const fallback = setTimeout(takeOver, 8000);
  applyThrottle(next);
  void next.view.webContents.loadURL(url);
}

/** Go to a route of the web app: a note in its tab, any other page in the home page. */
export function navigateTo(pathname: string): void {
  focusMainWindow();
  const url = new URL(pathname, APP_ORIGIN).toString();
  if (noteKey(url)) openNote(url);
  else showHome(url);
}

/** A new note, in a tab of its own. */
export function newTab(): void {
  focusMainWindow();
  if (homePage()?.signIn) return;
  openNote(new URL("/dashboard/note/new", APP_ORIGIN).toString());
}

/** Close the active note's tab; on the home page, close the window. */
export function closeActiveTab(): void {
  const page = activePage();
  if (page?.role === "note") closeTab(page.id);
  else getMainWindow()?.close();
}

/** The next (1) or previous (-1) tab, the home page first, wrapping around. */
export function selectAdjacentTab(step: number): void {
  const order = [homePage(), ...noteTabs()].filter((p): p is Page => Boolean(p));
  if (order.length < 2) return;
  const i = order.findIndex((p) => p.id === activeId);
  selectPage(order[(i + step + order.length) % order.length].id);
}

export function createMainWindow(first: FirstPage = "app"): BrowserWindow {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "AnotherNote",
    backgroundColor: "#fff9f0",
    // No title bar: the window buttons sit in the app's own tab bar.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 15 } }
      : {}),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow = win;
  pages = [];
  activeId = 0;
  theme = null;
  closingWindow = false;
  if (state.maximized) win.maximize();

  // The tab bar is a view of its own, kept above the pages; it never goes anywhere else.
  const bar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "toolbar.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  bar.setBackgroundColor("#00000000");
  bar.webContents.on("will-navigate", (event) => event.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void bar.webContents.loadFile(path.join(app.getAppPath(), "static", "toolbar.html"));
  win.contentView.addChildView(bar);
  toolbar = bar;
  installIpc();
  installMaintenanceWatch(win);
  const onListsChanged = (): void => markListsChanged();
  appEvents.on("lists-changed", onListsChanged);

  // The loading screen, until the first page (the web app, the sign-in screen or the
  // offline page) has finished loading.
  const splash = createSplash();
  const notBefore = Date.now() + SPLASH_MIN_MS;
  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    clearTimeout(fallback);
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        activeContents()?.focus();
      }
      if (!splash.isDestroyed()) splash.close();
    }, Math.max(0, notBefore - Date.now()));
  };
  const fallback = setTimeout(reveal, SPLASH_MAX_MS);

  const home = newPage("home", first === "signin" ? null : APP_URL);
  selectPage(home.id);
  home.view.webContents.once("did-finish-load", reveal);
  if (first === "signin") showSignIn(win);
  else scheduleSpare(2500);

  // Keep the active tab's name current while the web app changes it without navigating
  // (a note renamed as it is typed).
  titleTimer = setInterval(() => {
    const page = activePage();
    if (page) void refreshTitle(page);
  }, 2000);

  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 300);
  };
  win.on("resize", () => {
    layout();
    scheduleSave();
  });
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);
  win.on("enter-full-screen", pushState);
  win.on("leave-full-screen", pushState);
  win.on("close", (event) => {
    clearTimeout(saveTimer);
    saveWindowState(win);
    if (closingWindow) return;
    // The tabs leave their notes first, as when one is closed; then the window goes (and
    // the app quits, if that is why it is closing).
    const open = noteTabs().filter((p) => !p.signIn);
    if (open.length === 0) return;
    event.preventDefault();
    closingWindow = true;
    for (const page of open) {
      page.view.webContents.setAudioMuted(true);
      leave(page);
    }
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
      if (quitting) app.quit();
    }, LEAVE_MS);
  });
  win.on("closed", () => {
    clearTimeout(fallback);
    clearInterval(titleTimer);
    clearTimeout(spareTimer);
    clearTimeout(refreshTimer);
    appEvents.off("lists-changed", onListsChanged);
    if (!splash.isDestroyed()) splash.close();
    if (mainWindow === win) {
      mainWindow = null;
      toolbar = null;
      pages = [];
      activeId = 0;
      closingWindow = false;
    }
  });
  return win;
}

/** A page of the web app in `role`, out of sight, loading `url` (or nothing yet). */
function newPage(role: Role, url: string | null): Page {
  const win = getMainWindow() ?? createMainWindow();
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Full speed while on screen or playing a lesson; applyThrottle() decides per page.
      backgroundThrottling: false,
      additionalArguments: [`--anothernotes-version=${app.getVersion()}`],
    },
  });
  view.setBackgroundColor(theme?.background || "#fff9f0");
  const page: Page = {
    id: nextPageId++,
    role,
    key: role === "note" && url ? noteKey(url) : null,
    lastUrl: url ?? "",
    view,
    title: url ? routeLabel(url) : "AnotherNote",
    signIn: false,
    booted: false,
    audible: false,
    stale: false,
  };
  pages.push(page);
  view.setVisible(false);
  win.contentView.addChildView(view);
  if (toolbar) win.contentView.addChildView(toolbar); // back on top
  wirePage(win, page);
  if (role === "spare") view.webContents.setAudioMuted(true);
  layout(); // sized before it loads: the web app picks its layout from the window's width
  applyThrottle(page);
  if (url) void view.webContents.loadURL(url);
  return page;
}

/** The page on screen and one playing a lesson run at full speed; pages out of sight rest. */
function applyThrottle(page: Page): void {
  const contents = page.view.webContents;
  if (!contents.isDestroyed()) contents.setBackgroundThrottling(!(page.id === activeId || page.audible || page.incoming));
}

/** Tell the page its role, for the preload's link routing. */
function sendRole(page: Page): void {
  if (!page.view.webContents.isDestroyed()) page.view.webContents.send("tabs:role", page.role);
}

/** A tab goes next to the active tab, or last when the home page is showing. */
function placeAsTab(page: Page): void {
  const active = activePage();
  const after = active && active !== page && active.role === "note" ? active : undefined;
  pages = pages.filter((p) => p !== page);
  pages.splice(after ? pages.indexOf(after) + 1 : pages.length, 0, page);
}

/** A note or learning session in its own tab: the one already open for it, or the spare, or a new page. */
function openNote(url: string): Page {
  const key = noteKey(url);
  const open = key && key !== "new" ? noteTabs().find((t) => t.key === key) : undefined;
  if (open) {
    selectPage(open.id);
    if (pathOf(open.view.webContents.getURL()) !== pathOf(url)) navigateInPage(open, url);
    return open;
  }
  const started = Date.now();
  const spare = pages.find((p) => p.role === "spare" && p.booted && !p.incoming && !p.view.webContents.isDestroyed());
  let page: Page;
  if (spare) {
    page = spare;
    placeAsTab(page);
    page.role = "note";
    page.key = key;
    page.lastUrl = url;
    page.title = routeLabel(url);
    page.clearHistory = true;
    page.view.webContents.setAudioMuted(false);
    sendRole(page);
    selectPage(page.id);
    navigateInPage(page, url);
  } else {
    page = newPage("note", url);
    placeAsTab(page);
    selectPage(page.id);
  }
  measureOpen(page.view.webContents, started, spare ? "warm" : "cold");
  scheduleSpare();
  return page;
}

/** Show the home page, on a route of the web app (the dashboard, folders, calendar…). */
function showHome(url?: string): void {
  const home = homePage();
  if (!home) {
    selectPage(newPage("home", url ?? APP_URL).id);
    return;
  }
  selectPage(home.id);
  if (url && pathOf(home.view.webContents.getURL()) !== pathOf(url)) navigateInPage(home, url);
}

/**
 * Move a page of the web app to another of its routes without reloading it: the way its
 * router does (a history entry and a popstate), so its data stays loaded. A page that is
 * not the web app (the sign-in screen, the offline page) loads the URL instead.
 */
function navigateInPage(page: Page, url: string): void {
  const contents = page.view.webContents;
  if (contents.isDestroyed()) return;
  if (!isAppUrl(contents.getURL()) || page.signIn) {
    void contents.loadURL(url);
    return;
  }
  const u = new URL(url);
  const target = JSON.stringify(`${u.pathname}${u.search}${u.hash}`);
  const script = `(() => {
    const s = history.state || {};
    const idx = (typeof s.idx === "number" ? s.idx : 0) + 1;
    history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, "", ${target});
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  })()`;
  contents.executeJavaScript(script, false).catch(() => void contents.loadURL(url));
}

/** Close a note's tab: out of sight at once, then it leaves its note and rests as the spare, or goes. */
function closeTab(id: number): void {
  const page = pages.find((p) => p.id === id && p.role === "note");
  if (!page) return;
  const order = noteTabs();
  const i = order.indexOf(page);
  const home = homePage();
  if (activeId === id) {
    const next = order[i + 1] ?? order[i - 1];
    if (!next && home && !home.signIn) {
      // The last tab becomes the home page, on the home page's route: a route change away
      // from the note (its leaving), and the home page then shows the lists as this page
      // left them, a note it made or deleted included.
      becomeHome(page, home.lastUrl || APP_URL, home);
      return;
    }
    if (next) selectPage(next.id);
    else if (home) selectPage(home.id);
  }
  page.role = "closing";
  page.view.setVisible(false);
  page.view.webContents.setAudioMuted(true);
  applyThrottle(page);
  sendRole(page);
  pushState();
  leave(page);
  setTimeout(() => {
    if (page.role !== "closing") return;
    if (!hasSpare() && !homePage()?.signIn && !page.view.webContents.isDestroyed()) toSpare(page);
    else destroyPage(page);
  }, LEAVE_MS);
}

/** Leave the note the way the web app expects: a route change away from it. */
function leave(page: Page): void {
  const contents = page.view.webContents;
  if (contents.isDestroyed() || page.signIn || !noteKey(contents.getURL())) return;
  navigateInPage(page, APP_URL);
}

/** A page rests out of sight as the spare, ready to become the next tab. */
function toSpare(page: Page): void {
  page.role = "spare";
  page.key = null;
  page.title = "AnotherNote";
  page.clearHistory = false;
  page.view.setVisible(false);
  page.view.webContents.setAudioMuted(true);
  applyThrottle(page);
  sendRole(page);
}

function destroyPage(page: Page): void {
  const pending = page.incoming;
  page.incoming = undefined;
  pages = pages.filter((p) => p !== page);
  const win = getMainWindow();
  if (win) win.contentView.removeChildView(page.view);
  if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  pending?.();
}

/** A page becomes the home page, on `route`; the page that was home rests as the spare, or goes. */
function becomeHome(page: Page, route: string, previous?: Page): void {
  page.role = "home";
  page.key = null;
  page.lastUrl = route;
  page.view.webContents.setAudioMuted(false);
  sendRole(page);
  if (previous && previous !== page) {
    if (hasSpare()) destroyPage(previous);
    else toSpare(previous);
  }
  selectPage(page.id);
  if (pathOf(page.view.webContents.getURL()) === pathOf(route)) {
    page.view.webContents.navigationHistory.clear();
  } else {
    page.clearHistory = true;
    navigateInPage(page, route);
  }
}

/** The home page opened a note by itself (a button): it becomes that note's tab, and the spare (or a new page) the home page. */
function becomeTab(page: Page, key: string, url: string): void {
  const route = page.lastUrl || APP_URL;
  page.role = "note";
  page.key = key;
  page.lastUrl = url;
  page.title = routeLabel(url);
  page.clearHistory = false;
  page.view.webContents.navigationHistory.clear();
  pages = [...pages.filter((p) => p !== page), page]; // last among the tabs
  sendRole(page);
  const spare = pages.find((p) => p.role === "spare" && !p.incoming && !p.view.webContents.isDestroyed());
  if (spare) {
    spare.role = "home";
    spare.lastUrl = route;
    spare.view.webContents.setAudioMuted(false);
    sendRole(spare);
    if (!spare.booted || spare.stale) reloadPage(spare);
    else if (pathOf(spare.view.webContents.getURL()) !== pathOf(route)) {
      spare.clearHistory = true;
      navigateInPage(spare, route);
    } else spare.view.webContents.navigationHistory.clear();
  } else {
    newPage("home", route);
  }
  selectPage(page.id);
  measureOpen(page.view.webContents, Date.now(), "in place");
  scheduleSpare();
}

/** A new spare, once the app has settled, unless there is one already. */
function scheduleSpare(delay = SPARE_DELAY_MS): void {
  clearTimeout(spareTimer);
  spareTimer = setTimeout(() => {
    if (!getMainWindow() || closingWindow || homePage()?.signIn || hasSpare()) return;
    newPage("spare", APP_URL);
  }, delay);
}

/** The server changed what the lists show: every page out of sight loads again, soon. */
function markListsChanged(): void {
  for (const page of pages) {
    if ((page.role === "home" || page.role === "spare") && page.id !== activeId && !page.incoming) page.stale = true;
  }
  scheduleRefresh();
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const page of pages) {
      if (!page.stale || page.id === activeId || page.audible || page.signIn) continue;
      if (page.role === "home" || page.role === "spare") reloadPage(page);
    }
  }, REFRESH_DELAY_MS);
}

/** Load a page again from its route (out of sight: its lists are current when it is next shown). */
function reloadPage(page: Page): void {
  page.stale = false;
  page.booted = false;
  if (page.role === "home") page.clearHistory = true;
  void page.view.webContents.loadURL(page.role === "home" ? page.lastUrl || APP_URL : APP_URL);
}

function selectPage(id: number): void {
  const target = pages.find((p) => p.id === id && shown(p));
  if (!target) return;
  const previous = activePage();
  activeId = id;
  // Speed first, then sight: a page may only rest (and be told it is out of sight, so
  // the web app saves progress and pauses its activity count) if it is allowed to as it
  // goes out of sight.
  for (const page of pages) applyThrottle(page);
  for (const page of pages) page.view.setVisible(page.id === id);
  adoptTheme();
  layout();
  target.view.webContents.focus();
  void refreshTitle(target);
  pushState();
  if (previous && previous !== target && previous.stale) scheduleRefresh();
}

/**
 * A page of the web app went somewhere by itself (its router: a button, a note deleted).
 * Notes belong in tabs and everything else in the home page, so a page that crossed
 * that line takes the role its route calls for.
 */
function route(page: Page, url: string): void {
  if (!shown(page) || page.signIn || !isAppUrl(url)) return;
  const where = pathOf(url);
  if (!where || where === "/" || SIGN_IN_PATHS.has(where) || where.startsWith("/auth/")) return;
  if (page.clearHistory && where === pathOf(page.lastUrl)) {
    page.clearHistory = false;
    page.view.webContents.navigationHistory.clear();
  }
  const key = noteKey(url);
  if (page.role === "home") {
    if (!key) {
      page.lastUrl = url;
      return;
    }
    const open = key !== "new" ? noteTabs().find((t) => t.key === key) : undefined;
    if (open) {
      selectPage(open.id);
      restore(page);
      return;
    }
    becomeTab(page, key, url);
    return;
  }
  if (!key) {
    becomeHome(page, url, homePage());
    return;
  }
  if (key !== page.key) {
    // Another note in this tab (the new note got its id, or the page moved on): one tab per note.
    const other = noteTabs().find((t) => t !== page && t.key === key);
    page.key = key;
    if (other) closeTab(other.id);
  }
  page.lastUrl = url;
}

/** Put a page back on its own last route: back one step when that is where it was. */
function restore(page: Page): void {
  const contents = page.view.webContents;
  if (!page.lastUrl || contents.isDestroyed()) return;
  const history = contents.navigationHistory;
  const i = history.getActiveIndex();
  if (i > 0 && history.getEntryAtIndex(i - 1)?.url === page.lastUrl) {
    page.pruneForward = true;
    history.goBack();
  } else void contents.loadURL(page.lastUrl);
}

/** After a page was put back: forget the step it was taken away by, so forward can't repeat it. */
function pruneForward(page: Page): void {
  if (!page.pruneForward) return;
  page.pruneForward = false;
  const history = page.view.webContents.navigationHistory;
  const next = history.getActiveIndex() + 1;
  if (next < history.length()) history.removeEntryAtIndex(next);
}

/** The bar is always there: over the notes, and over the sign-in screen as its one tab. */
const toolbarVisible = (): boolean => Boolean(activePage());

/** The sign-in screen's bar: light, like the screen, whatever the web app last had. */
const SIGN_IN_THEME = { background: "rgb(247, 247, 245)", dark: false };

/** Where the tab bar starts: the sidebar's edge when the page has one, else the window's. */
const barStart = (): number => {
  const right = activePage()?.chrome?.right ?? -1;
  return right >= 0 ? right : 0;
};
const overSidebarLayout = (): boolean => (activePage()?.chrome?.right ?? -1) >= 0;

function layout(): void {
  const win = getMainWindow();
  if (!win) return;
  const [width, height] = win.getContentSize();
  const visible = toolbarVisible();
  // With the sidebar the page runs the full height and makes room itself (the preload);
  // without it the page starts below the bar.
  const top = visible && !overSidebarLayout() ? TOOLBAR_HEIGHT : 0;
  for (const page of pages) page.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  if (toolbar) {
    toolbar.setVisible(visible);
    const x = Math.min(barStart(), Math.max(0, width - 200));
    toolbar.setBounds({ x, y: 0, width: Math.max(0, width - x), height: TOOLBAR_HEIGHT });
  }
}

/** What the tab bar draws: the tabs, whether back and forward go anywhere, its colours. */
function pushState(): void {
  const win = getMainWindow();
  if (!win || !toolbar || toolbar.webContents.isDestroyed()) return;
  const signIn = Boolean(activePage()?.signIn);
  const history = signIn ? undefined : activeContents()?.navigationHistory;
  const lights = process.platform === "darwin" && !win.isFullScreen() ? LIGHTS_WIDTH : 0;
  toolbar.webContents.send("tabs:state", {
    tabs: noteTabs().map((t) => ({ id: t.id, title: t.title, active: t.id === activeId })),
    /** The sign-in screen is showing: the bar holds its one tab and nothing else. */
    signIn,
    canGoBack: Boolean(history?.canGoBack()),
    canGoForward: Boolean(history?.canGoForward()),
    visible: toolbarVisible(),
    /** Room to leave at the bar's left for the window buttons, where it overlaps them. */
    inset: Math.max(8, lights - barStart()),
    overSidebar: overSidebarLayout(),
    /** A dialog is open in the page: the bar takes its backdrop and stops taking clicks. */
    scrim: activePage()?.chrome?.scrim ?? "",
    theme,
  });
}

async function refreshTitle(page: Page): Promise<void> {
  const contents = page.view.webContents;
  if (page.role !== "note" || contents.isDestroyed()) return;
  const url = contents.getURL();
  let title = routeLabel(url);
  if (isAppUrl(url)) {
    try {
      const read = (await contents.executeJavaScript(READ_TITLE, false)) as unknown;
      if (typeof read === "string" && read) title = read.slice(0, 120);
    } catch {
      /* the page is between documents; the next check reads it */
    }
  }
  if (title !== page.title) {
    page.title = title;
    pushState();
  }
}

/** The active page's sidebar colour becomes the bar's. */
function adoptTheme(): void {
  const chrome = activePage()?.chrome;
  if (chrome?.background && !/rgba\(0, 0, 0, 0\)|transparent/.test(chrome.background)) {
    theme = { background: chrome.background, dark: chrome.dark };
  }
}

/** Read a tab's name now and again once the page has drawn it. */
function refreshSoon(page: Page): void {
  void refreshTitle(page);
  for (const ms of [400, 1500]) setTimeout(() => void refreshTitle(page), ms).unref();
}

let ipcInstalled = false;
function installIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on("tabs:command", (event, name: unknown, id: unknown) => {
    if (!getMainWindow() || !toolbar || event.sender !== toolbar.webContents) return;
    const pageId = typeof id === "number" ? id : 0;
    // The page keeps the focus: otherwise the tab bar holds it after a click there, and
    // the next click in the page only moves it back instead of doing what it was for.
    if (name !== "ready") setTimeout(() => activeContents()?.focus(), 30);
    if (name === "ready") pushState();
    else if (name === "select") selectPage(pageId);
    else if (name === "close") closeTab(pageId);
    else if (name === "new") newTab();
    else if (name === "back") {
      const history = activeContents()?.navigationHistory;
      if (history?.canGoBack()) history.goBack();
    } else if (name === "forward") {
      const history = activeContents()?.navigationHistory;
      if (history?.canGoForward()) history.goForward();
    }
  });
  // A page reports where its sidebar ends, what colour it is, and an open dialog (preload).
  ipcMain.on("chrome:layout", (event, report: unknown) => {
    const page = pageOf(event.sender);
    const r = (report ?? {}) as { right?: unknown; background?: unknown; dark?: unknown; scrim?: unknown };
    if (!page || typeof r.right !== "number" || !Number.isFinite(r.right)) return;
    page.chrome = {
      right: Math.max(-1, Math.min(4000, Math.round(r.right))),
      background: typeof r.background === "string" ? r.background.slice(0, 64) : "",
      dark: r.dark === true,
      scrim: typeof r.scrim === "string" ? r.scrim.slice(0, 64) : "",
    };
    if (page.incoming && page.chrome.right >= 0) page.incoming();
    if (page.id !== activeId) return;
    adoptTheme();
    layout();
    pushState();
  });
  // A link clicked in a page that belongs elsewhere (preload): a note in its tab, any
  // other page in the home page. The page it was clicked in does not move.
  ipcMain.on("nav:open", (event, href: unknown) => {
    const page = pageOf(event.sender);
    if (!page || !shown(page) || typeof href !== "string" || href.length > 2048) return;
    let url: string;
    try {
      url = new URL(href, APP_ORIGIN).toString();
    } catch {
      return;
    }
    if (!isAppUrl(url)) return;
    if (noteKey(url)) openNote(url);
    else showHome(url);
  });
}

/**
 * The site's maintenance gate answers 503 "Back soon". The app never shows that page:
 * the response is dropped before it renders and the app's own page waits and retries.
 */
function installMaintenanceWatch(win: BrowserWindow): void {
  win.webContents.session.webRequest.onHeadersReceived({ urls: [`${APP_ORIGIN}/*`] }, (details, callback) => {
    if (details.resourceType === "mainFrame" && details.statusCode === 503) {
      const page = pages.find((p) => p.view.webContents.id === details.webContents?.id);
      if (page) {
        console.warn(
          `[anothernotes] 503 ${details.url}: the site is behind its maintenance gate and the app has no ` +
            "accepted key (ANOTHERNOTES_PREVIEW_KEY stores one). Showing the app's own page and retrying.",
        );
        callback({ cancel: true });
        if (shown(page)) showMaintenancePage(page.view.webContents, details.url);
        else destroyPage(page);
        return;
      }
    }
    callback({});
  });
}

/** Everything a page does that the app has rules or logs for. */
function wirePage(win: BrowserWindow, page: Page): void {
  const contents = page.view.webContents;
  watchLessonAudio(contents);
  contents.on("audio-state-changed", (event) => {
    page.audible = event.audible;
    applyThrottle(page);
  });
  contents.on("dom-ready", () => sendRole(page));

  // Links that ask for a new window: a note in its tab, the app's other pages in the
  // home page, the rest in the browser. From the sign-in screen (its terms and privacy
  // links), always the browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (!shown(page)) return { action: "deny" };
    if (page.signIn) openExternal(url);
    else if (isAppUrl(url)) {
      if (noteKey(url)) openNote(url);
      else showHome(url);
    } else openExternal(url);
    return { action: "deny" };
  });

  /** A page out of sight that lands on sign-in goes; a page on screen shows the sign-in screen. */
  const signedOut = (): void => {
    if (shown(page)) showSignIn(win);
    else destroyPage(page);
  };

  let roundTrip = false;
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url)) {
      const where = pathOf(url);
      if (where && SIGN_IN_PATHS.has(where)) {
        event.preventDefault();
        signedOut();
        return;
      }
      if (where === "/") {
        event.preventDefault();
        void contents.loadURL(APP_URL);
        return;
      }
      roundTrip = startsRoundTrip(url);
      return;
    }
    const host = hostOf(url);
    if (GOOGLE_SIGNIN_HOSTS.has(host)) {
      event.preventDefault();
      roundTrip = false;
      if (shown(page)) explainGoogleSignIn(win);
      return;
    }
    if (roundTrip && /^https:/i.test(url)) return; // a provider's page on the way back to the app
    event.preventDefault();
    if (shown(page)) openExternal(url);
  };
  contents.on("will-navigate", (event, url) => guard(event, url));
  contents.on("will-redirect", (event, url) => guard(event, url));
  // The same for the web app's own route changes (history.pushState), which navigate
  // without a request: a signed-out visit to the dashboard redirects to /auth this way.
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    const where = pathOf(url);
    if (where && SIGN_IN_PATHS.has(where)) {
      signedOut();
      return;
    }
    if (where === "/") {
      void contents.loadURL(APP_URL);
      return;
    }
    // First the step back a previous move asked for, now that it has happened; then this move.
    pruneForward(page);
    route(page, url);
    refreshSoon(page);
    pushState();
  });

  // What the page is doing, on stderr: `npm start` and scripts/run-mac.sh show it.
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    if (shown(page)) console.log(`[anothernotes] loading ${forLog(details.url)}`);
    if (!details.isSameDocument) {
      page.chrome = undefined; // the next document reports its own
      page.booted = false;
      if (page.id === activeId) layout();
    }
    if (page.signIn && isAppUrl(details.url)) {
      page.signIn = false;
      layout();
      pushState();
      scheduleSpare(2500);
    }
  });
  contents.on("did-finish-load", () => {
    if (shown(page)) console.log(`[anothernotes] loaded ${forLog(contents.getURL())}`);
    refreshSoon(page);
  });
  contents.on("did-navigate", (_event, url, httpResponseCode, httpStatusText) => {
    if (isAppUrl(url) && (!httpResponseCode || httpResponseCode < 400)) page.booted = true;
    if (httpResponseCode && shown(page)) {
      console.log(`[anothernotes] ${httpResponseCode} ${httpStatusText} ${forLog(url)}`);
    }
    route(page, url);
    pushState();
  });
  contents.on("page-title-updated", () => refreshSoon(page));
  // The web app's own console, so its logs show next to the app's (and whose they are).
  contents.on("console-message", (details) => {
    const source = details.sourceId ? details.sourceId.replace(APP_ORIGIN, "") : "";
    const where = source ? ` (${source}:${details.lineNumber})` : "";
    console.log(`[web:${details.level}:${page.role}] ${details.message}${where}`);
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 ERR_ABORTED: a navigation cancelled above; -20 ERR_BLOCKED_BY_CLIENT: a 503 dropped above.
    if (!isMainFrame || code === -3 || code === -20) return;
    console.warn(`[anothernotes] failed to load ${forLog(url)}: ${description} (${code})`);
    if (shown(page)) showOfflinePage(contents, code, description, url);
    else destroyPage(page);
  });
  contents.on("render-process-gone", (_event, details) => {
    console.warn(`[anothernotes] a ${page.role} page's renderer went: ${details.reason}`);
    if (shown(page)) void contents.loadURL(page.lastUrl || APP_URL);
    else destroyPage(page);
  });
  contents.on("context-menu", (_event, params) => showContextMenu(win, contents, params));
}

/**
 * The app's sign-in screen (static/signin.html; signin.ts does the signing in), in the
 * home page. Signing in is for the whole window, so the tabs and the spare go, and the
 * tab bar holds the sign-in screen as its one tab until the web app loads again.
 */
export function showSignIn(win: BrowserWindow = focusMainWindow()): void {
  if (win !== getMainWindow()) return;
  clearTimeout(spareTimer);
  let home = homePage();
  for (const page of pages) page.incoming = undefined;
  for (const page of [...pages]) if (page !== home) destroyPage(page);
  if (!home) home = newPage("home", null);
  home.signIn = true;
  home.lastUrl = APP_URL;
  home.stale = false;
  theme = SIGN_IN_THEME;
  selectPage(home.id);
  // The website (for its terms and privacy pages and, when the app has none built in, the
  // landing page's videos), and which server this is when it is not the usual one.
  const query: Record<string, string> = { site: SITE_ORIGIN };
  if (SITE_ORIGIN !== new URL(WEBSITE_URL).origin) query.server = new URL(SITE_ORIGIN).host;
  const screen = home;
  void screen.view.webContents
    .loadFile(path.join(app.getAppPath(), "static", "signin.html"), { query })
    .then(() => {
      // Nothing to go back to from here: the pages before were signed in.
      if (screen.signIn && !screen.view.webContents.isDestroyed()) screen.view.webContents.navigationHistory.clear();
      pushState();
    })
    .catch(() => undefined);
}

function explainGoogleSignIn(win: BrowserWindow): void {
  void dialog
    .showMessageBox(win, {
      type: "info",
      message: "Sign in with Google in your browser",
      detail:
        "Google doesn't allow signing in inside desktop app windows. Continue in your browser, where you're probably signed in already, and you'll come straight back here.",
      buttons: ["Continue with your browser", "Not now"],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) browserSignIn();
    });
}

/** Chromium's error names, in words a student can act on. */
const REASONS: Record<string, string> = {
  ERR_INTERNET_DISCONNECTED: "You're offline",
  ERR_NAME_NOT_RESOLVED: "The AnotherNote server could not be found",
  ERR_CONNECTION_REFUSED: "The AnotherNote server refused the connection",
  ERR_CONNECTION_TIMED_OUT: "The connection timed out",
  ERR_CONNECTION_RESET: "The connection was reset",
  ERR_NETWORK_CHANGED: "Your network changed",
  ERR_PROXY_CONNECTION_FAILED: "Your proxy refused the connection",
};

function showOfflinePage(contents: WebContents, code: number, description: string, url: string): void {
  const why = REASONS[description] ?? `Couldn't connect (${description || code})`;
  void contents.loadFile(path.join(app.getAppPath(), "static", "offline.html"), {
    query: { url: isAppUrl(url) ? url : APP_URL, why },
  });
}

function showMaintenancePage(contents: WebContents, url: string): void {
  void contents.loadFile(path.join(app.getAppPath(), "static", "offline.html"), {
    query: {
      url: isAppUrl(url) ? url : APP_URL,
      title: "AnotherNote is being updated",
      why: "Back in a moment",
    },
  });
}

function showContextMenu(win: BrowserWindow, contents: WebContents, params: ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  for (const suggestion of params.dictionarySuggestions) {
    items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
  }
  if (params.misspelledWord) {
    items.push(
      {
        label: "Add to Dictionary",
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: "separator" },
    );
  }
  if (params.linkURL) {
    if (isAppUrl(params.linkURL)) {
      if (noteKey(params.linkURL)) {
        items.push({ label: "Open in Tab", click: () => openNote(params.linkURL) }, { type: "separator" });
      }
    } else {
      items.push(
        { label: "Open Link in Browser", click: () => openExternal(params.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
  }
  if (params.isEditable) {
    items.push(
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy" });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}
