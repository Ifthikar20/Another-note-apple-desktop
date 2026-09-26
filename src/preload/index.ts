import { contextBridge, ipcRenderer } from "electron";

/*
  The bridge between the web app and the desktop shell. Deliberately tiny: the web app
  can tell it is running on the desktop (window.anothernotes is undefined in a browser)
  and which version, and it can start a sign-in through the browser (auth.ts in the
  main process); nothing else is exposed, and every call is a fixed channel with no
  arguments. This file runs sandboxed, with context
  isolation, so the page never sees Node.
*/

const VERSION_FLAG = "--anothernotes-version=";
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_FLAG));

contextBridge.exposeInMainWorld(
  "anothernotes",
  Object.freeze({
    platform: process.platform,
    version: versionArg ? versionArg.slice(VERSION_FLAG.length) : "",
    auth: Object.freeze({
      /** Sign in through the system browser; the app comes back signed in on its own. */
      signInWithBrowser: (): Promise<void> => ipcRenderer.invoke("auth:sign-in-with-browser"),
      /** Open the web app's own sign-in page in this window (email and password, or a PIN). */
      signInHere: (): Promise<void> => ipcRenderer.invoke("auth:sign-in-here"),
      /** Forget a browser sign-in that was started and not finished. */
      cancelBrowserSignIn: (): Promise<void> => ipcRenderer.invoke("auth:cancel-browser-sign-in"),
    }),
  }),
);
