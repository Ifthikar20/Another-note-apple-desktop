import { app, dialog } from "electron";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { API_URL, APP_ORIGIN, BUNDLED, SITE_ORIGIN } from "./config";
import { openExternal } from "./links";
import { focusMainWindow, openAfterSignIn } from "./windows";

/*
  Signing in through the browser.

  Google refuses to sign in inside an Electron window, and the browser is where the
  student is signed in already, so the app sends them there and takes the session back
  through a link only it can use:

    1. beginBrowserSignIn: mint a `state` and a PKCE secret, open
       https://anothernote.app/desktop/sign-in?state&challenge in the system browser.
    2. The browser signs in as usual and asks the API for a one-time code bound to the
       challenge, then opens anothernotes://auth/callback?code&state.
    3. The OS hands that link to this app (open-url on macOS, argv elsewhere).
       handleDeepLink checks the state and navigates the window to the API's exchange
       with the code and the secret; the API sets the refresh cookie for this window and
       lands on /auth/callback, exactly as a Google sign-in lands in the browser.

  The secret never leaves this process, so a link seen on the way is worthless.
*/

export const PROTOCOL = "anothernotes";
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

interface Pending {
  state: string;
  verifier: string;
  startedAt: number;
}

let pending: Pending | null = null;

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

/** Open the browser on the sign-in page, remembering what only this app knows. */
export function beginBrowserSignIn(): void {
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  pending = { state, verifier, startedAt: Date.now() };
  const url = new URL("/desktop/sign-in", SITE_ORIGIN);
  url.searchParams.set("state", state);
  url.searchParams.set("challenge", challenge);
  openExternal(url.toString());
}

export function cancelBrowserSignIn(): void {
  pending = null;
}

/** The anothernotes:// links among a process's arguments (Windows and Linux hand them over that way). */
export function deepLinksIn(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith(`${PROTOCOL}://`));
}

/** Where the API's exchange lives for this code; null when the link is not one this app is waiting for. */
export function exchangeUrlFor(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== "auth" || url.pathname !== "/callback") return null;
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const current = pending;
  pending = null;
  if (!current || Date.now() - current.startedAt > PENDING_TTL_MS) return null;
  if (state !== current.state || !TOKEN.test(code)) return null;
  // With the bundled renderer the exchange goes through the app's origin (renderer.ts
  // forwards it and brings the redirect to /auth/callback back into the bundle).
  const exchange = new URL(BUNDLED ? `${APP_ORIGIN}/api/auth/desktop/exchange` : `${API_URL}/auth/desktop/exchange`);
  exchange.searchParams.set("code", code);
  exchange.searchParams.set("state", state);
  exchange.searchParams.set("code_verifier", current.verifier);
  return exchange.toString();
}

/** A link the OS delivered. Only auth/callback means anything; anything else just brings the window up. */
export function handleDeepLink(raw: string): void {
  if (!raw.startsWith(`${PROTOCOL}://`)) return;
  const win = focusMainWindow();
  const exchange = exchangeUrlFor(raw);
  if (exchange) {
    openAfterSignIn(exchange);
    return;
  }
  if (new URL(raw).hostname !== "auth") return;
  void dialog
    .showMessageBox(win, {
      type: "info",
      message: "That sign-in link has expired",
      detail: "Start again from the app: choose “Continue with your browser”, sign in there, and you'll come straight back.",
      buttons: ["Continue with your browser", "Not now"],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) beginBrowserSignIn();
    });
}

/** Make this app the one the OS opens anothernotes:// links with. */
export function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // `electron .` in development: point the OS at this binary plus the project folder.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}
