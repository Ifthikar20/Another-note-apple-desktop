import { app, BrowserWindow, ipcMain, session, systemPreferences, type IpcMainInvokeEvent } from "electron";
import { beginBrowserSignIn, cancelBrowserSignIn, deepLinksIn, handleDeepLink, registerProtocol } from "./auth";
import {
  API_ORIGIN,
  API_URL,
  APP_ORIGIN,
  APP_URL,
  BUNDLED,
  CLIENT_HEADER,
  originOf,
  PREVIEW_COOKIE,
  PREVIEW_KEY,
  SESSION_COOKIE,
  SESSION_COOKIE_URL,
  SITE_ORIGIN,
  WEBSITE_URL,
} from "./config";
import { installMenu } from "./menu";
import { installRenderer, registerAppScheme, rendererBuild } from "./renderer";
import { installSignIn } from "./signin";
import { installUpdater } from "./updater";
import { createMainWindow, focusMainWindow, getMainWindow, setBrowserSignIn, showSignIn } from "./windows";

/*
  AnotherNote for the desktop, v0: the live web app in a window of its own.

  The renderer is the website, untouched. Everything native lives here in the main
  process: one window whose size and place are remembered, native menus, links to the
  browser, the microphone permission, sign-in through the browser (auth.ts), and
  updates. See the README for what comes next.
*/

app.setAppUserModelId("app.anothernote.desktop");

// An error nothing caught goes to the log (the terminal the app was started from), not
// into a dialog that stops the app until someone clicks it away.
process.on("uncaughtException", (error) => {
  console.error("[anothernotes] unexpected error:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[anothernotes] unexpected error:", reason);
});
registerAppScheme();

// Links the OS hands us before the window exists (a cold start from a link).
let queuedLinks: string[] = deepLinksIn(process.argv);

// One running copy. A second launch (a double-click on the dock, a link) focuses it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    for (const link of deepLinksIn(argv)) handleDeepLink(link);
  });

  // macOS delivers anothernotes:// links here, possibly before the app is ready.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (getMainWindow()) handleDeepLink(url);
    else queuedLinks.push(url);
  });

  app.on("web-contents-created", (_event, contents) => {
    // No <webview> tags: the app has one page, the web app.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  void app.whenReady().then(async () => {
    // The first thing to check when the window shows the wrong site: which addresses this
    // build resolved. ANOTHERNOTES_URL and ANOTHERNOTES_API_URL change them (config.ts).
    console.log(
      `[anothernotes] v${app.getVersion()} electron=${process.versions.electron} ` +
        (BUNDLED ? `renderer=bundled (${rendererBuild()}) ` : "renderer=site ") +
        `app=${APP_URL} api=${API_URL}`,
    );
    if (BUNDLED) installRenderer();
    app.setAboutPanelOptions({
      applicationName: "AnotherNote",
      applicationVersion: app.getVersion(),
      website: WEBSITE_URL,
    });
    registerProtocol();
    setBrowserSignIn(beginBrowserSignIn);

    // The web app may use the microphone (dictation, talking to the tutor) and the
    // clipboard; nothing else, and nothing at all from any other origin.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      let origin = "";
      try {
        origin = originOf(details.requestingUrl);
      } catch {
        /* no origin: refused below */
      }
      if (origin !== APP_ORIGIN) return callback(false);
      if (permission === "media") {
        const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
        if (types.includes("video")) return callback(false);
        if (process.platform === "darwin") {
          void systemPreferences.askForMediaAccess("microphone").then((granted) => callback(granted));
          return;
        }
        return callback(true);
      }
      callback(permission === "clipboard-sanitized-write" || permission === "fullscreen" || permission === "notifications");
    });

    // Tell the API which client this is, on every request to the site and to the API.
    const origins = [...new Set([SITE_ORIGIN, API_ORIGIN])].map((origin) => `${origin}/*`);
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: origins }, (details, callback) => {
      details.requestHeaders["X-AnotherNotes-Client"] = CLIENT_HEADER;
      if (details.resourceType === "mainFrame") {
        const sent = /(^|;\s*)an_preview=[^;]+/.test(details.requestHeaders.Cookie ?? "");
        console.log(`[anothernotes] GET ${details.url} gateKey=${sent ? "sent" : "not sent"}`);
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    // The refresh cookie is what keeps the app signed in across launches; make sure it
    // reaches disk as soon as it changes rather than at Chromium's leisure.
    session.defaultSession.cookies.on("changed", (_event, cookie) => {
      if (cookie.name === SESSION_COOKIE) void session.defaultSession.cookies.flushStore();
    });

    // The bridge's few calls, from the app's own pages only (the sign-in screen is a
    // file of ours; the web app is the app's origin).
    const trusted = (event: IpcMainInvokeEvent): boolean => {
      const url = event.senderFrame?.url ?? "";
      return url.startsWith("file://") || url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
    };
    ipcMain.handle("auth:sign-in-with-browser", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      beginBrowserSignIn();
    });
    ipcMain.handle("auth:sign-in-here", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      showSignIn();
    });
    installSignIn(trusted);
    ipcMain.handle("auth:cancel-browser-sign-in", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      cancelBrowserSignIn();
    });

    if (PREVIEW_KEY) await unlockMaintenanceGate(PREVIEW_KEY);
    console.log(
      `[anothernotes] profile=${app.getPath("userData")} gateKey=${await gateKeyState()}`,
    );

    installMenu();
    // After the loading screen: the web app when there is a session, the app's own
    // sign-in screen when there is not (signin.ts).
    createMainWindow((await hasSession()) ? "app" : "signin");
    installUpdater();

    for (const link of queuedLinks) handleDeepLink(link);
    queuedLinks = [];
  });
}

/** Store the maintenance gate's team key in the app's own cookie jar, for 30 days. */
async function unlockMaintenanceGate(key: string): Promise<void> {
  try {
    await session.defaultSession.cookies.set({
      url: SITE_ORIGIN,
      name: PREVIEW_COOKIE,
      value: encodeURIComponent(key),
      path: "/",
      sameSite: "lax",
      secure: SITE_ORIGIN.startsWith("https:"),
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    });
    await session.defaultSession.cookies.flushStore();
    console.log(`[anothernotes] maintenance gate: ${PREVIEW_COOKIE} cookie stored for ${SITE_ORIGIN}`);
  } catch (e) {
    console.warn("[anothernotes] maintenance gate: could not store the cookie:", e);
  }
}

/**
 * Is the maintenance gate's key in the cookie jar, and readable? Cookies are encrypted
 * with a key in the macOS Keychain; a build that cannot read that item sees empty values.
 */
async function gateKeyState(): Promise<string> {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: SITE_ORIGIN, name: PREVIEW_COOKIE });
    if (cookies.length === 0) return "none";
    return cookies[0].value ? `stored (${cookies[0].value.length} chars)` : "stored but unreadable (empty value)";
  } catch {
    return "none";
  }
}

/** Is there a refresh cookie for the API in this app's cookie jar? Then the site opens signed in. */
async function hasSession(): Promise<boolean> {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: SESSION_COOKIE_URL, name: SESSION_COOKIE });
    return cookies.length > 0;
  } catch {
    return false;
  }
}
