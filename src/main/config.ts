import { app } from "electron";

/**
 * Where the app lives. The desktop shell loads the live web app in its own window
 * (design "B" in the desktop architecture note): nothing about the web app or the
 * API changes for it. ANOTHERNOTES_URL overrides the address for development
 * against a local web build, e.g. http://localhost:8080.
 */
const DEFAULT_URL = "https://anothernote.app/dashboard";

function resolveAppUrl(): string {
  const override = process.env.ANOTHERNOTES_URL;
  if (!override) return DEFAULT_URL;
  try {
    return new URL(override).toString();
  } catch {
    console.warn(`[anothernotes] ignoring invalid ANOTHERNOTES_URL: ${override}`);
    return DEFAULT_URL;
  }
}

export const APP_URL = resolveAppUrl();
export const APP_ORIGIN = new URL(APP_URL).origin;
export const WEBSITE_URL = "https://anothernote.app";

/** Sent on every request to the app's origin so the API can tell the desktop apart. */
export const CLIENT_HEADER = `desktop/${app.getVersion()} (${process.platform})`;
