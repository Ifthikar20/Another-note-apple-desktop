import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import { APP_ORIGIN, APP_URL } from "./config";
import { openExternal } from "./links";
import { loadWindowState, saveWindowState } from "./store";

let mainWindow: BrowserWindow | null = null;

/** Set by index.ts: starts the sign-in through the browser (auth.ts), without a circular import. */
let browserSignIn: () => void = () => undefined;
export function setBrowserSignIn(start: () => void): void {
  browserSignIn = start;
}

export type FirstPage = "app" | "welcome";

/**
 * Google refuses to sign in from inside an Electron window (its "disallowed_useragent"
 * page), so the app explains instead of showing that page. Sign-in through the system
 * browser with a deep link back is the next step (see the README).
 */
const GOOGLE_SIGNIN_HOSTS = new Set(["accounts.google.com"]);

/**
 * Top-level navigations to these API paths start a round trip through another site
 * (Microsoft or SAML sign-in, connecting a note source) that ends back on the app's own
 * callback URL. While one is in flight, other hosts may load in the window.
 */
const ROUND_TRIP_PREFIXES = ["/api/auth/", "/api/sources/"];

/** How long to wait for the first paint before showing the window anyway. */
const SHOW_AFTER_MS = 2000;

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

const isAppUrl = (url: string): boolean => {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
};

const startsRoundTrip = (url: string): boolean => {
  try {
    const { origin, pathname } = new URL(url);
    return origin === APP_ORIGIN && ROUND_TRIP_PREFIXES.some((p) => pathname.startsWith(p));
  } catch {
    return false;
  }
};

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

/** Go to a route of the web app, e.g. "/dashboard/note/new". */
export function navigateTo(pathname: string): void {
  void focusMainWindow().loadURL(new URL(pathname, APP_ORIGIN).toString());
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
    // The web app's own page colour, so the first paint doesn't flash white.
    backgroundColor: "#fff9f0",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--anothernotes-version=${app.getVersion()}`],
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();
  // Show on the first paint, or after a moment on a slow network: a window that never
  // appears looks like an app that never started.
  const showTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, SHOW_AFTER_MS);
  win.once("ready-to-show", () => {
    clearTimeout(showTimer);
    if (!win.isDestroyed()) win.show();
  });

  // Links that ask for a new window: the app's own open in this window, the rest in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) void win.loadURL(url);
    else openExternal(url);
    return { action: "deny" };
  });

  let roundTrip = false;
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url)) {
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
  win.webContents.on("will-navigate", (event, url) => guard(event, url));
  win.webContents.on("will-redirect", (event, url) => guard(event, url));

  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 is ERR_ABORTED: a navigation cancelled above
    showOfflinePage(win, code, description, url);
  });

  win.webContents.on("context-menu", (_event, params) => showContextMenu(win, params));

  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 300);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);
  win.on("close", () => {
    clearTimeout(saveTimer);
    saveWindowState(win);
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (first === "welcome") showWelcome(win);
  else void win.loadURL(APP_URL);
  return win;
}

/** The native welcome screen: sign in through the browser, or here in the window. */
export function showWelcome(win: BrowserWindow = focusMainWindow()): void {
  void win.loadFile(path.join(app.getAppPath(), "static", "welcome.html"));
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

function showOfflinePage(win: BrowserWindow, code: number, description: string, url: string): void {
  const why = REASONS[description] ?? `Couldn't connect (${description || code})`;
  void win.loadFile(path.join(app.getAppPath(), "static", "offline.html"), {
    query: { url: isAppUrl(url) ? url : APP_URL, why },
  });
}

function showContextMenu(win: BrowserWindow, params: ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  for (const suggestion of params.dictionarySuggestions) {
    items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
  }
  if (params.misspelledWord) {
    items.push(
      {
        label: "Add to Dictionary",
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: "separator" },
    );
  }
  if (params.linkURL) {
    items.push(
      { label: "Open Link in Browser", click: () => openExternal(params.linkURL) },
      { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
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
