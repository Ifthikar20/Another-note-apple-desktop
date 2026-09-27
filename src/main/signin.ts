import { ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { serverRequest, type ServerResponse } from "./server";
import { API_URL, APP_ORIGIN, CLIENT_HEADER, SESSION_COOKIE, SESSION_COOKIE_URL } from "./config";
import { loadInActiveTab } from "./windows";

/*
  The app's own sign-in (static/signin.html). The screen is the desktop's; the account
  and the session are the same as on the site:

    signin.html --ipc--> here: POST <api>/auth/login  or  /auth/child/login
                               through server.ts, which stores the refresh cookie the
                               API sets (httpOnly, /api/auth/) in the app's jar
                         <-- {access_token}
    window -> <app>/auth/callback#token=…&next=/dashboard
                               the web app's own page for adopting a token, as after a
                               Google sign-in; from there it renews from the cookie

  The password never reaches the web app or any page but this one, and nothing is kept
  on disk except the cookie the API sets.
*/

export type SignInResult = { ok: true } | { ok: false; error: string; lockedForSeconds?: number };

type Credentials = { path: string; body: Record<string, string>; kind: string };

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;

function passwordCredentials(form: unknown): Credentials | null {
  const f = (form ?? {}) as Record<string, unknown>;
  const email = text(f.email, 254);
  const password = text(f.password, 1024);
  return email && password ? { path: "/auth/login", body: { email: email.trim(), password }, kind: "password" } : null;
}

function pinCredentials(form: unknown): Credentials | null {
  const f = (form ?? {}) as Record<string, unknown>;
  const username = text(f.username, 64);
  const pin = text(f.pin, 32);
  return username && pin ? { path: "/auth/child/login", body: { username: username.trim(), pin: pin.trim() }, kind: "pin" } : null;
}

/** The API's refusal, in the words it chose; a few statuses it has no words for, in ours. */
function refusal(status: number, data: unknown): SignInResult {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object") {
    const d = detail as { message?: unknown; retryAfterSeconds?: unknown };
    return {
      ok: false,
      error: typeof d.message === "string" ? d.message : "Sign-in failed. Try again.",
      lockedForSeconds: typeof d.retryAfterSeconds === "number" ? d.retryAfterSeconds : undefined,
    };
  }
  if (typeof detail === "string" && detail) return { ok: false, error: detail };
  if (status === 429) return { ok: false, error: "Too many attempts. Wait a minute and try again." };
  if (status === 503) return { ok: false, error: "AnotherNotes is being updated. Try again in a moment." };
  return { ok: false, error: `Sign-in failed (${status}). Try again.` };
}

async function signIn(credentials: Credentials | null): Promise<SignInResult> {
  if (!credentials) return { ok: false, error: "Fill in both fields to sign in." };
  let response: ServerResponse;
  let data: unknown = null;
  try {
    response = await serverRequest(`${API_URL}${credentials.path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
        "X-AnotherNotes-Client": CLIENT_HEADER,
      },
      body: JSON.stringify(credentials.body),
    });
    data = await new Response(response.body).json().catch(() => null);
  } catch (e) {
    console.warn(`[anothernotes] sign-in (${credentials.kind}): ${(e as Error).message}`);
    return { ok: false, error: "Can't reach AnotherNotes. Check your connection and try again." };
  }
  console.log(`[anothernotes] sign-in (${credentials.kind}) -> ${response.status}`);
  const token = (data as { access_token?: unknown } | null)?.access_token;
  if (response.status >= 400 || typeof token !== "string") return refusal(response.status, data);

  const cookies = await session.defaultSession.cookies.get({ url: SESSION_COOKIE_URL, name: SESSION_COOKIE }).catch(() => []);
  console.log(`[anothernotes] session cookie ${cookies.length ? "stored" : "NOT stored: the app will ask again next launch"}`);

  const callback = new URL("/auth/callback", APP_ORIGIN);
  callback.hash = new URLSearchParams({ token, next: "/dashboard" }).toString();
  loadInActiveTab(callback.toString());
  return { ok: true };
}

export function installSignIn(trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle("auth:sign-in", (event, form: unknown) => {
    if (!trusted(event)) throw new Error("not allowed");
    return signIn(passwordCredentials(form));
  });
  ipcMain.handle("auth:sign-in-with-pin", (event, form: unknown) => {
    if (!trusted(event)) throw new Error("not allowed");
    return signIn(pinCredentials(form));
  });
}
