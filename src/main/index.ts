import { app, BrowserWindow, ipcMain, session, systemPreferences, type IpcMainInvokeEvent } from "electron";
import { beginBrowserSignIn, cancelBrowserSignIn, deepLinksIn, handleDeepLink, registerProtocol } from "./auth";
import { API_ORIGIN, APP_ORIGIN, CLIENT_HEADER, SESSION_COOKIE, SESSION_COOKIE_URL, WEBSITE_URL } from "./config";
import { installMenu } from "./menu";
import { installUpdater } from "./updater";
import { createMainWindow, focusMainWindow, getMainWindow, setBrowserSignIn } from "./windows";

/*
  AnotherNotes for the desktop, v0: the live web app in a window of its own.

  The renderer is the website, untouched. Everything native lives here in the main
  process: one window whose size and place are remembered, native menus, links to the
  browser, the microphone permission, sign-in through the browser (auth.ts), and
  updates. See the README for what comes next.
*/

app.setAppUserModelId("app.anothernote.desktop");

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
    app.setAboutPanelOptions({
      applicationName: "AnotherNotes",
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
        origin = new URL(details.requestingUrl).origin;
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

    // Tell the API which client this is, on every request to the app and to the API.
    const origins = [...new Set([APP_ORIGIN, API_ORIGIN])].map((origin) => `${origin}/*`);
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: origins }, (details, callback) => {
      details.requestHeaders["X-AnotherNotes-Client"] = CLIENT_HEADER;
      callback({ requestHeaders: details.requestHeaders });
    });

    // The refresh cookie is what keeps the app signed in across launches; make sure it
    // reaches disk as soon as it changes rather than at Chromium's leisure.
    session.defaultSession.cookies.on("changed", (_event, cookie) => {
      if (cookie.name === SESSION_COOKIE) void session.defaultSession.cookies.flushStore();
    });

    // The bridge's few calls, from the app's own pages only (the welcome screen is a
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
      void focusMainWindow().loadURL(`${APP_ORIGIN}/auth`);
    });
    ipcMain.handle("auth:cancel-browser-sign-in", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      cancelBrowserSignIn();
    });

    installMenu();
    createMainWindow((await hasSession()) ? "app" : "welcome");
    installUpdater();

    for (const link of queuedLinks) handleDeepLink(link);
    queuedLinks = [];
  });
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
