import { net, session } from "electron";

/*
  Requests from the app to the AnotherNotes server, with the app's own cookie handling.

  The server's cookies (the refresh cookie, the maintenance gate's key) live in the app's
  cookie jar, but this module reads and writes them itself instead of leaving it to
  Chromium, for one reason: the API marks its refresh cookie Secure, and a server on a
  plain http address (a test box before it has a domain) can never set a Secure cookie
  in Chromium, so the app would forget the session after 15 minutes. Here a cookie keeps
  every attribute the server gave it except Secure on an http server, and it is sent
  back on exactly the requests Chromium would send it on (its host and path).

  Both the sign-in screen (signin.ts) and the bundled web app's /api (renderer.ts) go
  through here, so the session one starts is the session the other renews.
*/

export interface ServerResponse {
  status: number;
  statusText: string;
  /** Lower-case names, as the server sent them, minus Set-Cookie (handled here). */
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

/** Headers the request's own connection supplies, or that this module sets itself. */
const SKIPPED_REQUEST_HEADERS = /^(host|origin|referer|connection|content-length|accept-encoding|cookie|keep-alive|transfer-encoding|upgrade|te|trailer|expect|proxy-.*|sec-.*)$/i;

export async function serverRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string },
): Promise<ServerResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const cookie = await cookieHeaderFor(url);
  return new Promise<ServerResponse>((resolve, reject) => {
    const request = net.request({ method, url, session: session.defaultSession, useSessionCookies: false, redirect: "manual" });
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (SKIPPED_REQUEST_HEADERS.test(name)) continue;
      try {
        request.setHeader(name, value);
      } catch {
        /* a header Chromium will not let a request set; the server does without it */
      }
    }
    if (cookie) request.setHeader("Cookie", cookie);

    let settled = false;
    const settle = (response: ServerResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    // A redirect is the server's answer as it stands (the page decides where to go), so
    // it is returned, not followed; its cookies count (the desktop exchange sets one).
    request.on("redirect", (status, _method, location, headers) => {
      void storeCookies(url, headers["set-cookie"]).finally(() => {
        const out = plainHeaders(headers);
        out.location = location;
        settle({ status, statusText: "", headers: out, body: null });
        request.abort();
      });
    });
    request.on("response", (response) => {
      // The page can stop reading at any moment (it navigated, or its tab closed while the
      // answer was arriving): then the stream is cancelled, what is still coming is
      // dropped, and the request to the server is stopped.
      let open = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer) => {
            if (!open) return;
            try {
              controller.enqueue(new Uint8Array(chunk));
            } catch {
              open = false;
            }
          });
          response.on("end", () => {
            if (!open) return;
            open = false;
            try {
              controller.close();
            } catch {
              /* already closed by the reader */
            }
          });
          response.on("error", (error: Error) => {
            if (!open) return;
            open = false;
            try {
              controller.error(error);
            } catch {
              /* already closed by the reader */
            }
          });
        },
        cancel() {
          open = false;
          try {
            request.abort();
          } catch {
            /* already finished */
          }
        },
      });
      void storeCookies(url, response.headers["set-cookie"]).finally(() =>
        settle({ status: response.statusCode, statusText: response.statusMessage, headers: plainHeaders(response.headers), body }),
      );
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (init.body !== undefined) request.write(typeof init.body === "string" ? init.body : Buffer.from(init.body));
    request.end();
  });
}

function plainHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === "set-cookie") continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** The Cookie header for a request to this URL: the jar's cookies for its host and path. */
async function cookieHeaderFor(url: string): Promise<string> {
  try {
    const cookies = await session.defaultSession.cookies.get({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";

interface SetCookie {
  name: string;
  value: string;
  path?: string;
  maxAge?: number;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

function parseSetCookie(line: string): SetCookie | null {
  const [pair, ...attributes] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const cookie: SetCookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), httpOnly: false, secure: false };
  if (cookie.value.startsWith('"') && cookie.value.endsWith('"')) cookie.value = cookie.value.slice(1, -1);
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? "" : attribute.slice(at + 1).trim();
    if (key === "path") cookie.path = value;
    else if (key === "max-age") cookie.maxAge = Number(value);
    else if (key === "expires") cookie.expires = Date.parse(value);
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = value.toLowerCase();
  }
  return cookie;
}

/** The directory of a request path, which is a cookie's path when the server names none. */
const defaultPath = (pathname: string): string => {
  const slash = pathname.lastIndexOf("/");
  return slash > 0 ? pathname.slice(0, slash) : "/";
};

async function storeCookies(requestUrl: string, lines: string | string[] | undefined): Promise<void> {
  if (!lines) return;
  const target = new URL(requestUrl);
  const https = target.protocol === "https:";
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    const cookie = parseSetCookie(line);
    if (!cookie) continue;
    const path = cookie.path?.startsWith("/") ? cookie.path : defaultPath(target.pathname);
    const cookieUrl = `${target.origin}${path}`;
    const now = Date.now();
    const expired =
      (cookie.maxAge !== undefined && !Number.isNaN(cookie.maxAge) && cookie.maxAge <= 0) ||
      (cookie.expires !== undefined && !Number.isNaN(cookie.expires) && cookie.expires <= now) ||
      cookie.value === "";
    try {
      if (expired) {
        await session.defaultSession.cookies.remove(cookieUrl, cookie.name);
        console.log(`[cookie] removed ${cookie.name} (${path})`);
        continue;
      }
      const secure = cookie.secure && https;
      const sameSite: SameSite =
        cookie.sameSite === "strict" ? "strict" : cookie.sameSite === "none" ? (secure ? "no_restriction" : "lax") : "lax";
      const expirationDate =
        cookie.maxAge !== undefined && !Number.isNaN(cookie.maxAge)
          ? now / 1000 + cookie.maxAge
          : cookie.expires !== undefined && !Number.isNaN(cookie.expires)
            ? cookie.expires / 1000
            : undefined;
      await session.defaultSession.cookies.set({
        url: cookieUrl,
        name: cookie.name,
        value: cookie.value,
        path,
        httpOnly: cookie.httpOnly,
        secure,
        sameSite,
        expirationDate,
      });
      const note = cookie.secure && !https ? " (Secure dropped: the server is plain http)" : "";
      console.log(`[cookie] stored ${cookie.name} (${path})${note}`);
    } catch (e) {
      console.warn(`[cookie] could not store ${cookie.name}: ${(e as Error).message}`);
    }
  }
  await session.defaultSession.cookies.flushStore().catch(() => undefined);
}
