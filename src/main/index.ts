import { app, BrowserWindow, session, systemPreferences } from "electron";
import { APP_ORIGIN, CLIENT_HEADER, WEBSITE_URL } from "./config";
import { installMenu } from "./menu";
import { installUpdater } from "./updater";
import { createMainWindow, focusMainWindow } from "./windows";

/*
  AnotherNotes for the desktop, v0: the live web app in a window of its own.

  The renderer is the website, untouched. Everything native lives here in the main
  process: one window whose size and place are remembered, native menus, links to the
  browser, the microphone permission, and updates. See the README for what comes next.
*/

app.setAppUserModelId("app.anothernote.desktop");

// One running copy. A second launch (a double-click on the dock or a file) focuses it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());

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

  void app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: "AnotherNotes",
      applicationVersion: app.getVersion(),
      website: WEBSITE_URL,
    });

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

    // Tell the API which client this is, on every request to the app's own origin.
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${APP_ORIGIN}/*`] }, (details, callback) => {
      details.requestHeaders["X-AnotherNotes-Client"] = CLIENT_HEADER;
      callback({ requestHeaders: details.requestHeaders });
    });

    installMenu();
    createMainWindow();
    installUpdater();
  });
}
