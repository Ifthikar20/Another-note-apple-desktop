import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { beginBrowserSignIn } from "./auth";
import { WEBSITE_URL } from "./config";
import { openExternal } from "./links";
import { checkForUpdates } from "./updater";
import { getMainWindow, navigateTo } from "./windows";

const isMac = process.platform === "darwin";

const contents = () => getMainWindow()?.webContents;

function goBack(): void {
  const wc = contents();
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

function goForward(): void {
  const wc = contents();
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

function openCurrentPageInBrowser(): void {
  const url = contents()?.getURL() ?? "";
  openExternal(/^https?:/i.test(url) ? url : WEBSITE_URL);
}

export function installMenu(): void {
  const updateItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => void checkForUpdates(true),
  };

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            updateItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const editExtras: MenuItemConstructorOptions[] = isMac
    ? [{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }]
    : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }];

  const devTools: MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ role: "toggleDevTools" }];

  const windowExtras: MenuItemConstructorOptions[] = isMac
    ? [{ type: "separator" }, { role: "front" }]
    : [{ role: "close" }];

  const helpExtras: MenuItemConstructorOptions[] = isMac
    ? []
    : [{ type: "separator" }, updateItem, { label: `Version ${app.getVersion()}`, enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        { label: "New Note", accelerator: "CmdOrCtrl+N", click: () => navigateTo("/dashboard/note/new") },
        { type: "separator" },
        { label: "Sign In with Your Browser…", click: () => beginBrowserSignIn() },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...editExtras,
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...devTools,
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: goBack },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: goForward },
        { type: "separator" },
        { label: "Dashboard", accelerator: "CmdOrCtrl+1", click: () => navigateTo("/dashboard") },
        { label: "Folders", accelerator: "CmdOrCtrl+2", click: () => navigateTo("/dashboard/folders") },
        { label: "Calendar", accelerator: "CmdOrCtrl+3", click: () => navigateTo("/dashboard/calendar") },
        { label: "Profile", accelerator: "CmdOrCtrl+4", click: () => navigateTo("/dashboard/profile") },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...windowExtras],
    },
    {
      role: "help",
      submenu: [
        { label: "Open This Page in Browser", click: openCurrentPageInBrowser },
        { label: "AnotherNotes Website", click: () => openExternal(WEBSITE_URL) },
        ...helpExtras,
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
