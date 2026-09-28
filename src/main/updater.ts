import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";

/*
  Updates come from the GitHub Releases feed electron-builder publishes (latest-mac.yml
  next to the .dmg and .zip). The app checks on start and every few hours, downloads in
  the background, and asks before restarting: a lesson in progress is never interrupted.

  macOS only updates a signed app; an unsigned development build logs the refusal and
  carries on.
*/

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let interactive = false;

export function installUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => {
    console.warn("[updater]", error?.message ?? error);
    if (interactive) {
      interactive = false;
      void dialog.showMessageBox({
        type: "warning",
        message: "Couldn't check for updates",
        detail: String(error?.message ?? error),
      });
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (!interactive) return;
    interactive = false;
    void dialog.showMessageBox({
      type: "info",
      message: "You're up to date",
      detail: `AnotherNote ${app.getVersion()} is the latest version.`,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    interactive = false;
    void dialog
      .showMessageBox({
        type: "info",
        message: `AnotherNote ${info.version} is ready`,
        detail: "Restart to update. Anything you're doing now will be there when it comes back.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
  void checkForUpdates(false);
  setInterval(() => void checkForUpdates(false), CHECK_EVERY_MS).unref();
}

/** Look for an update now. Interactive checks (the menu item) also report "up to date" and errors. */
export async function checkForUpdates(fromMenu: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (fromMenu) {
      await dialog.showMessageBox({ type: "info", message: "Updates are only checked in the packaged app." });
    }
    return;
  }
  interactive = fromMenu;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // reported through the "error" event above
  }
}
