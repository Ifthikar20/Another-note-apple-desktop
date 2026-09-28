import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { beginBrowserSignIn } from "./auth";
import { WEBSITE_URL } from "./config";
import { openExternal } from "./links";
import { checkForUpdates } from "./updater";
import { activeContents, closeActiveTab, navigateTo, newTab, selectAdjacentTab } from "./windows";

const isMac = process.platform === "darwin";

/** The menus act on the page in the active tab, not the window's toolbar. */
const contents = activeContents;

function zoom(step: number): void {
  const wc = contents();
  if (wc) wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step * 0.5);
}

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

  const devTools: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ label: "Toggle Developer Tools", accelerator: "Alt+CmdOrCtrl+I", click: () => contents()?.toggleDevTools() }];

  const windowExtras: MenuItemConstructorOptions[] = isMac
    ? [{ type: "separator" }, { role: "front" }]
    : [];

  const helpExtras: MenuItemConstructorOptions[] = isMac
    ? []
    : [{ type: "separator" }, updateItem, { label: `Version ${app.getVersion()}`, enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        { label: "New Note", accelerator: "CmdOrCtrl+N", click: () => newTab() },
        { label: "New Note in Tab", accelerator: "CmdOrCtrl+T", visible: false, click: () => newTab() },
        { type: "separator" },
        { label: "Sign In with Your Browser…", click: () => beginBrowserSignIn() },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => closeActiveTab() },
        ...(isMac ? [] : [{ role: "quit" } as MenuItemConstructorOptions]),
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
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => contents()?.reload() },
        { label: "Force Reload", accelerator: "Shift+CmdOrCtrl+R", click: () => contents()?.reloadIgnoringCache() },
        ...devTools,
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom(0) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => zoom(1) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom(-1) },
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
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Show Next Tab", accelerator: "Ctrl+Tab", click: () => selectAdjacentTab(1) },
        { label: "Show Previous Tab", accelerator: "Ctrl+Shift+Tab", click: () => selectAdjacentTab(-1) },
        { label: "Next Tab", accelerator: "CmdOrCtrl+Shift+]", visible: false, click: () => selectAdjacentTab(1) },
        { label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+[", visible: false, click: () => selectAdjacentTab(-1) },
        ...windowExtras,
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Open This Page in Browser", click: openCurrentPageInBrowser },
        { label: "AnotherNote Website", click: () => openExternal(WEBSITE_URL) },
        ...helpExtras,
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
