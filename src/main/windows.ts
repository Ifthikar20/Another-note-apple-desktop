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
import { openExternal } from "./links";
import { watchLessonAudio } from "./media";
import { loadWindowState, saveWindowState } from "./store";

/*
  The main window, laid out like a Mac app rather than a browser:

    ┌─ ● ● ● ───────────┬─ ‹ ›  [ Chapter 3 notes × ][ Photosynthesis ]  + ──┐  toolbar (static/toolbar.html)
    │ the web app's      │                                                     │
    │ sidebar, full      │   the web app's page                                │
    │ height             │                                                     │
    └────────────────────┴─────────────────────────────────────────────────────┘

  There is no title bar. As in Notion, the web app's sidebar runs the full height with
  the window buttons on it, and the app's own tab bar sits over the content column,
  starting where the sidebar ends and following it as it is resized or folded away
  (the tab's preload reports the edge). The web app is given room for both (SHELL_CSS).

  Tabs are for notes and learning sessions only. Everything else (the dashboard,
  folders, calendar, profile) lives in one home page behind the tabs, which the sidebar
  and the Go menu show; it is never a tab. Opening a note or a session from anywhere
  gives it a tab of its own, or brings its tab forward if it is open already, and the
  page it was opened from stays where it was. Each tab and the home page have their
  own history and share one session, so signing in or out is for all of them. While
  the sign-in screen shows there are no tabs and no tab bar. A page without the sidebar
  gets the bar across the full width.
*/

const TOOLBAR_HEIGHT = 44;
/** Room the window buttons need at the window's left edge. */
const LIGHTS_WIDTH = 84;

/**
 * Room in the web app's layout for the window's chrome. The selectors are the sidebar
 * component's: its header (above the brand block the window buttons sit, and the strip
 * moves the window) and the inset content card, which starts below the tab bar.
 */
const SHELL_CSS = `
  @media (min-width: 768px) {
    .peer ~ main { margin-top: ${TOOLBAR_HEIGHT}px !important; height: calc(100svh - ${TOOLBAR_HEIGHT}px - 0.5rem) !important; min-height: 0 !important; }
    [data-sidebar="header"] { padding-top: ${process.platform === "darwin" ? 40 : 8}px !important; -webkit-app-region: drag; }
    [data-sidebar="header"] :is(a, button, input, select, textarea, [role="button"], [role="combobox"], [tabindex]) {
      -webkit-app-region: no-drag;
    }
  }
`;

interface Tab {
  id: number;
  /** The home page (never shown as a tab) or a note's or learning session's tab. */
  kind: "home" | "note";
  /** For a note's tab: the note or session it shows ("new" while it is being made). */
  key: string | null;
  /** The last page of its own it showed, to go back to when a link leads elsewhere. */
  lastUrl: string;
  /** Put back one step: the step forward (to where the link led) is dropped on arrival. */
  pruneForward?: boolean;
  view: WebContentsView;
  title: string;
  /** Showing the sign-in screen: the toolbar is hidden while the active tab is. */
  signIn: boolean;
  /** Reported by the page: the sidebar's right edge (-1: no sidebar) and its colour. */
  chrome?: { right: number; background: string; dark: boolean };
}

let mainWindow: BrowserWindow | null = null;
let toolbar: WebContentsView | null = null;
let tabs: Tab[] = [];
let activeId = 0;
let nextTabId = 1;
let theme: { background: string; dark: boolean } | null = null;
let titleTimer: NodeJS.Timeout | undefined;

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
 * callback URL. While one is in flight, other hosts may load in the tab.
 */
const ROUND_TRIP_PREFIXES = ["/api/auth/", "/api/sources/"];

/** The loading screen stays up at least this long (no flash) and at most this long (no hang). */
const SPLASH_MIN_MS = 900;
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
    title: "AnotherNotes",
    backgroundColor: "#f5f5f7",
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
  return "AnotherNotes";
}

/**
 * The note or learning session a URL shows, or null for any other page of the web app.
 * A note and its full study are one session, so they share a tab.
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

const activeTab = (): Tab | undefined => tabs.find((t) => t.id === activeId);
const homePage = (): Tab | undefined => tabs.find((t) => t.kind === "home");
const noteTabs = (): Tab[] => tabs.filter((t) => t.kind === "note");

/** The page showing: a note's tab or the home page. What the menus act on. */
export function activeContents(): WebContents | undefined {
  const tab = activeTab();
  return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : undefined;
}

/** Load a URL in the home page and show it (a sign-in's landing page, a deep link). */
export function loadInActiveTab(url: string): void {
  focusMainWindow();
  const home = homePage() ?? openPage("home", null);
  selectTab(home.id);
  void home.view.webContents.loadURL(url);
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
  const tab = activeTab();
  if (tab?.kind === "note") closeTab(tab.id);
  else getMainWindow()?.close();
}

/** The next (1) or previous (-1) tab, the home page first, wrapping around. */
export function selectAdjacentTab(step: number): void {
  const order = [homePage(), ...noteTabs()].filter((t): t is Tab => Boolean(t));
  if (order.length < 2) return;
  const i = order.findIndex((t) => t.id === activeId);
  selectTab(order[(i + step + order.length) % order.length].id);
}

/** A note or learning session in its own tab: the one already open for it, or a new one. */
function openNote(url: string): Tab {
  const key = noteKey(url);
  const open = key && key !== "new" ? noteTabs().find((t) => t.key === key) : undefined;
  if (!open) return openPage("note", url);
  selectTab(open.id);
  if (pathOf(open.view.webContents.getURL()) !== pathOf(url)) navigateInPage(open, url);
  return open;
}

/** Show the home page on a route of the web app (the dashboard, folders, calendar…). */
function showHome(url: string): void {
  const home = homePage() ?? openPage("home", null);
  selectTab(home.id);
  if (pathOf(home.view.webContents.getURL()) !== pathOf(url)) navigateInPage(home, url);
}

/**
 * Move a page of the web app to another of its routes without reloading it: the way its
 * router does (a history entry and a popstate), so its data stays loaded. A page that is
 * not the web app (the sign-in screen, the offline page) loads the URL instead.
 */
function navigateInPage(tab: Tab, url: string): void {
  const contents = tab.view.webContents;
  if (!isAppUrl(contents.getURL()) || tab.signIn) {
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

/**
 * A page of the web app went somewhere by itself (a link, the sidebar, its router).
 * Notes and sessions belong in tabs and everything else in the home page, so a move
 * across that line opens the destination where it belongs and puts this page back.
 */
function route(tab: Tab, url: string): void {
  if (tab.signIn || !isAppUrl(url)) return;
  const where = pathOf(url);
  if (!where || where === "/" || SIGN_IN_PATHS.has(where) || where.startsWith("/auth/")) return;
  const key = noteKey(url);
  if (tab.kind === "home") {
    if (!key) {
      tab.lastUrl = url;
      return;
    }
    // A new note is made by the page that opens it; it moves to its tab once it has an id.
    if (key === "new") return;
    openNote(url);
    restore(tab);
    return;
  }
  if (!key) {
    restore(tab);
    showHome(url);
    return;
  }
  if (key === tab.key || tab.key === "new") {
    tab.key = key;
    tab.lastUrl = url;
    return;
  }
  openNote(url);
  restore(tab);
}

/** Put a page back on the last page of its own: back one step when that is where it was. */
function restore(tab: Tab): void {
  const contents = tab.view.webContents;
  if (!tab.lastUrl || contents.isDestroyed()) return;
  const history = contents.navigationHistory;
  const i = history.getActiveIndex();
  if (i > 0 && history.getEntryAtIndex(i - 1)?.url === tab.lastUrl) {
    tab.pruneForward = true;
    history.goBack();
  } else void contents.loadURL(tab.lastUrl);
}

/** After a page was put back: forget the step it was taken away by, so forward can't repeat it. */
function pruneForward(tab: Tab): void {
  if (!tab.pruneForward) return;
  tab.pruneForward = false;
  const history = tab.view.webContents.navigationHistory;
  const next = history.getActiveIndex() + 1;
  if (next < history.length()) history.removeEntryAtIndex(next);
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
    title: "AnotherNotes",
    backgroundColor: "#fff9f0",
    // No title bar: the window buttons sit in the app's own toolbar.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 15 } }
      : {}),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow = win;
  tabs = [];
  activeId = 0;
  theme = null;
  if (state.maximized) win.maximize();

  // The tab bar is a view of its own, kept above the tabs; it never goes anywhere else.
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
  installToolbarCommands();
  installMaintenanceWatch(win);

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

  const home = openPage("home", first === "signin" ? null : APP_URL);
  home.view.webContents.once("did-finish-load", reveal);
  if (first === "signin") showSignIn(win);

  // Keep the active tab's name current while the web app changes it without navigating
  // (a note renamed as it is typed).
  titleTimer = setInterval(() => {
    const tab = activeTab();
    if (tab) void refreshTab(tab);
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
  win.on("close", () => {
    clearTimeout(saveTimer);
    saveWindowState(win);
  });
  win.on("closed", () => {
    clearTimeout(fallback);
    clearInterval(titleTimer);
    if (!splash.isDestroyed()) splash.close();
    if (mainWindow === win) {
      mainWindow = null;
      toolbar = null;
      tabs = [];
      activeId = 0;
    }
  });
  return win;
}

/** The home page, or a note's tab next to the active one; loads `url` (or nothing yet), made active. */
function openPage(kind: Tab["kind"], url: string | null): Tab {
  const win = getMainWindow() ?? createMainWindow();
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // A lesson keeps its pace in a background tab or behind other windows: the tutor's
      // timing and the pointer's flights are timers, which Chromium would otherwise slow.
      backgroundThrottling: false,
      additionalArguments: [`--anothernotes-version=${app.getVersion()}`],
    },
  });
  view.setBackgroundColor("#fff9f0");
  const tab: Tab = {
    id: nextTabId++,
    kind,
    key: kind === "note" && url ? noteKey(url) : null,
    lastUrl: url ?? "",
    view,
    title: url ? routeLabel(url) : "AnotherNotes",
    signIn: false,
  };
  const active = activeTab();
  const at = kind === "home" ? -1 : active?.kind === "note" ? tabs.indexOf(active) + 1 : tabs.length;
  if (at < 0) tabs.unshift(tab);
  else tabs.splice(at, 0, tab);
  win.contentView.addChildView(view);
  if (toolbar) win.contentView.addChildView(toolbar); // back on top
  wirePage(win, tab);
  // Sized before it loads: the web app picks its layout from the window's width.
  selectTab(tab.id);
  if (url) void view.webContents.loadURL(url);
  return tab;
}

function selectTab(id: number): void {
  if (!tabs.some((t) => t.id === id)) return;
  activeId = id;
  for (const tab of tabs) tab.view.setVisible(tab.id === id);
  adoptTheme();
  layout();
  activeContents()?.focus();
  const tab = activeTab();
  if (tab) void refreshTab(tab);
  pushState();
}

function closeTab(id: number): void {
  const win = getMainWindow();
  const i = tabs.findIndex((t) => t.id === id && t.kind === "note");
  if (!win || i < 0) return;
  const [tab] = tabs.splice(i, 1);
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (activeId !== id) {
    pushState();
    return;
  }
  // The neighbouring note, or the home page when it was the last one.
  const notes = noteTabs();
  const next = notes.find((t) => tabs.indexOf(t) >= i) ?? notes[notes.length - 1] ?? homePage();
  if (next) selectTab(next.id);
}

const toolbarVisible = (): boolean => {
  const tab = activeTab();
  return Boolean(tab && !tab.signIn);
};

/** Where the tab bar starts: the sidebar's edge when the page has one, else the window's. */
const barStart = (): number => {
  const right = activeTab()?.chrome?.right ?? -1;
  return right >= 0 ? right : 0;
};
const overSidebarLayout = (): boolean => (activeTab()?.chrome?.right ?? -1) >= 0;

function layout(): void {
  const win = getMainWindow();
  if (!win) return;
  const [width, height] = win.getContentSize();
  const visible = toolbarVisible();
  // With the sidebar the page runs the full height and makes room itself (SHELL_CSS);
  // without it the page starts below the bar.
  const top = visible && !overSidebarLayout() ? TOOLBAR_HEIGHT : 0;
  for (const tab of tabs) tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  if (toolbar) {
    toolbar.setVisible(visible);
    const x = Math.min(barStart(), Math.max(0, width - 200));
    toolbar.setBounds({ x, y: 0, width: Math.max(0, width - x), height: TOOLBAR_HEIGHT });
  }
}

/** What the toolbar draws: the tabs, whether back and forward go anywhere, its colours. */
function pushState(): void {
  const win = getMainWindow();
  if (!win || !toolbar || toolbar.webContents.isDestroyed()) return;
  const history = activeContents()?.navigationHistory;
  const lights = process.platform === "darwin" && !win.isFullScreen() ? LIGHTS_WIDTH : 0;
  toolbar.webContents.send("tabs:state", {
    tabs: noteTabs().map((t) => ({ id: t.id, title: t.title, active: t.id === activeId })),
    canGoBack: Boolean(history?.canGoBack()),
    canGoForward: Boolean(history?.canGoForward()),
    visible: toolbarVisible(),
    /** Room to leave at the bar's left for the window buttons, where it overlaps them. */
    inset: Math.max(8, lights - barStart()),
    overSidebar: overSidebarLayout(),
    theme,
  });
}

async function refreshTab(tab: Tab): Promise<void> {
  const contents = tab.view.webContents;
  if (tab.kind !== "note" || contents.isDestroyed()) return;
  const url = contents.getURL();
  let title = routeLabel(url);
  let changed = false;
  if (isAppUrl(url)) {
    try {
      const crumb = (await contents.executeJavaScript(READ_TITLE, false)) as unknown;
      if (typeof crumb === "string" && crumb) title = crumb.slice(0, 120);
    } catch {
      /* the page is between documents; the next check reads it */
    }
  }
  if (title !== tab.title) {
    tab.title = title;
    changed = true;
  }
  if (changed) pushState();
}

/** The active tab's sidebar colour becomes the bar's. */
function adoptTheme(): void {
  const chrome = activeTab()?.chrome;
  if (chrome?.background && !/rgba\(0, 0, 0, 0\)|transparent/.test(chrome.background)) {
    theme = { background: chrome.background, dark: chrome.dark };
  }
}

/** Read a tab's name now and again once the page has drawn it. */
function refreshSoon(tab: Tab): void {
  void refreshTab(tab);
  for (const ms of [400, 1500]) setTimeout(() => void refreshTab(tab), ms).unref();
}

let toolbarCommandsInstalled = false;
function installToolbarCommands(): void {
  if (toolbarCommandsInstalled) return;
  toolbarCommandsInstalled = true;
  ipcMain.on("tabs:command", (event, name: unknown, id: unknown) => {
    const win = getMainWindow();
    if (!win || !toolbar || event.sender !== toolbar.webContents) return;
    const tabId = typeof id === "number" ? id : 0;
    // The page keeps the focus: otherwise the tab bar holds it after a click there, and
    // the next click in the page only moves it back instead of doing what it was for.
    if (name !== "ready") setTimeout(() => activeContents()?.focus(), 30);
    if (name === "ready") pushState();
    else if (name === "select") selectTab(tabId);
    else if (name === "close") closeTab(tabId);
    else if (name === "new") newTab();
    else if (name === "back") {
      const history = activeContents()?.navigationHistory;
      if (history?.canGoBack()) history.goBack();
    } else if (name === "forward") {
      const history = activeContents()?.navigationHistory;
      if (history?.canGoForward()) history.goForward();
    }
  });
  // A tab's page reports where its sidebar ends and what colour it is (preload).
  ipcMain.on("chrome:layout", (event, report: unknown) => {
    const tab = tabs.find((t) => t.view.webContents === event.sender);
    const r = (report ?? {}) as { right?: unknown; background?: unknown; dark?: unknown };
    if (!tab || typeof r.right !== "number" || !Number.isFinite(r.right)) return;
    tab.chrome = {
      right: Math.max(-1, Math.min(4000, Math.round(r.right))),
      background: typeof r.background === "string" ? r.background.slice(0, 64) : "",
      dark: r.dark === true,
    };
    if (tab.id !== activeId) return;
    adoptTheme();
    layout();
    pushState();
  });
}

/**
 * The site's maintenance gate answers 503 "Back soon". The app never shows that page:
 * the response is dropped before it renders and the app's own page waits and retries.
 */
function installMaintenanceWatch(win: BrowserWindow): void {
  win.webContents.session.webRequest.onHeadersReceived({ urls: [`${APP_ORIGIN}/*`] }, (details, callback) => {
    if (details.resourceType === "mainFrame" && details.statusCode === 503) {
      const tab = tabs.find((t) => t.view.webContents.id === details.webContents?.id);
      if (tab) {
        console.warn(
          `[anothernotes] 503 ${details.url}: the site is behind its maintenance gate and the app has no ` +
            "accepted key (ANOTHERNOTES_PREVIEW_KEY stores one). Showing the app's own page and retrying.",
        );
        callback({ cancel: true });
        showMaintenancePage(tab.view.webContents, details.url);
        return;
      }
    }
    callback({});
  });
}

/** Everything a tab's page does that the app has rules or logs for. */
function wirePage(win: BrowserWindow, tab: Tab): void {
  const contents = tab.view.webContents;
  watchLessonAudio(contents);

  // Links that ask for a new window: a note in its tab, the app's other pages in the
  // home page, the rest in the browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) navigateTo(url);
    else openExternal(url);
    return { action: "deny" };
  });

  let roundTrip = false;
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url)) {
      const where = pathOf(url);
      if (where && SIGN_IN_PATHS.has(where)) {
        event.preventDefault();
        showSignIn(win);
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
      explainGoogleSignIn(win);
      return;
    }
    if (roundTrip && /^https:/i.test(url)) return; // a provider's page on the way back to the app
    event.preventDefault();
    openExternal(url);
  };
  contents.on("will-navigate", (event, url) => guard(event, url));
  contents.on("will-redirect", (event, url) => guard(event, url));
  // The same for the web app's own route changes (history.pushState), which navigate
  // without a request: a signed-out visit to the dashboard redirects to /auth this way.
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    const where = pathOf(url);
    if (where && SIGN_IN_PATHS.has(where)) showSignIn(win);
    else if (where === "/") void contents.loadURL(APP_URL);
    else {
      // First the step back a previous move asked for, now that it has happened; then this move.
      pruneForward(tab);
      route(tab, url);
    }
    refreshSoon(tab);
    pushState();
  });

  // What the tab is doing, on stderr: `npm start` and scripts/run-mac.sh show it.
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    console.log(`[anothernotes] loading ${forLog(details.url)}`);
    if (!details.isSameDocument && tab.chrome) {
      tab.chrome = undefined; // the next page reports its own
      if (tab.id === activeId) layout();
    }
    if (tab.signIn && isAppUrl(details.url)) {
      tab.signIn = false;
      layout();
      pushState();
    }
  });
  contents.on("did-finish-load", () => {
    console.log(`[anothernotes] loaded ${forLog(contents.getURL())}`);
    refreshSoon(tab);
  });
  contents.on("did-navigate", (_event, url, httpResponseCode, httpStatusText) => {
    if (httpResponseCode) console.log(`[anothernotes] ${httpResponseCode} ${httpStatusText} ${forLog(url)}`);
    route(tab, url);
    pushState();
  });
  contents.on("page-title-updated", () => refreshSoon(tab));
  contents.on("dom-ready", () => {
    if (isAppUrl(contents.getURL())) void contents.insertCSS(SHELL_CSS).catch(() => undefined);
  });
  // The web app's own console, so its logs show next to the app's.
  contents.on("console-message", (details) => {
    const source = details.sourceId ? details.sourceId.replace(APP_ORIGIN, "") : "";
    const where = source ? ` (${source}:${details.lineNumber})` : "";
    console.log(`[web:${details.level}] ${details.message}${where}`);
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 ERR_ABORTED: a navigation cancelled above; -20 ERR_BLOCKED_BY_CLIENT: a 503 dropped above.
    if (!isMainFrame || code === -3 || code === -20) return;
    console.warn(`[anothernotes] failed to load ${forLog(url)}: ${description} (${code})`);
    showOfflinePage(contents, code, description, url);
  });
  contents.on("context-menu", (_event, params) => showContextMenu(win, contents, params));
}

/**
 * The app's sign-in screen (static/signin.html; signin.ts does the signing in), in the
 * home page. Signing in is for the whole window, so the notes' tabs close and the tab
 * bar hides until the web app loads again.
 */
export function showSignIn(win: BrowserWindow = focusMainWindow()): void {
  if (win !== getMainWindow()) return;
  const keep = homePage() ?? openPage("home", null);
  for (const tab of noteTabs()) {
    tabs = tabs.filter((t) => t !== tab);
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  keep.signIn = true;
  keep.lastUrl = APP_URL;
  activeId = keep.id;
  keep.view.setVisible(true);
  layout();
  pushState();
  const query: Record<string, string> = {};
  if (SITE_ORIGIN !== new URL(WEBSITE_URL).origin) query.server = new URL(SITE_ORIGIN).host;
  void keep.view.webContents.loadFile(path.join(app.getAppPath(), "static", "signin.html"), { query });
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
  ERR_NAME_NOT_RESOLVED: "The AnotherNotes server could not be found",
  ERR_CONNECTION_REFUSED: "The AnotherNotes server refused the connection",
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
      title: "AnotherNotes is being updated",
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
