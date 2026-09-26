import { contextBridge } from "electron";

/*
  The bridge between the web app and the desktop shell. Deliberately tiny: the web app
  can tell it is running on the desktop (window.anothernotes is undefined in a browser)
  and which version; nothing else is exposed. This file runs sandboxed, with context
  isolation, so the page never sees Node.
*/

const VERSION_FLAG = "--anothernotes-version=";
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_FLAG));

contextBridge.exposeInMainWorld(
  "anothernotes",
  Object.freeze({
    platform: process.platform,
    version: versionArg ? versionArg.slice(VERSION_FLAG.length) : "",
  }),
);
