import { net, protocol } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { API_ORIGIN, APP_ORIGIN, APP_SCHEME, CLIENT_HEADER, PROXIED_PATHS, RENDERER_DIR, SITE_ORIGIN } from "./config";
import { serverRequest, type ServerResponse } from "./server";

/*
  The bundled renderer: the web app's production build served from the app's own origin,
  app://anothernotes, the way nginx serves it on the site.

    app://anothernotes/dashboard        -> renderer/index.html  (the SPA; any route)
    app://anothernotes/assets/x.js      -> renderer/assets/x.js
    app://anothernotes/api/notes        -> <server>/api/notes    (forwarded, with cookies)
    app://anothernotes/img/<sha>.jpg    -> <server>/img/<sha>.jpg

  To the web app nothing changed: its API base is the relative /api, as in production,
  so its fetches are same-origin. The forwarding runs in this process (server.ts), which
  keeps the server's cookies, the refresh cookie among them, in the app's jar and sends
  them back to the server; the renderer never sees them.
*/

/** The one place the scheme's abilities are declared; must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/** The build the bundle came from, written by scripts/build-renderer.sh. */
export function rendererBuild(): string {
  try {
    return readFileSync(path.join(RENDERER_DIR, "BUILD"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

/** Mirrors deploy/aws/nginx.conf in the web repo; 'self' is the app's own origin here. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com https://www.google.com https://www.gstatic.com",
  "frame-src 'self' https://challenges.cloudflare.com https://www.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: http:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Response headers that would be wrong after forwarding: the body arrives decoded. */
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

const isProxied = (pathname: string): boolean =>
  PROXIED_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export function installRenderer(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    return isProxied(url.pathname) ? forward(request, url) : serve(url.pathname);
  });
}

/** A file of the bundle, or index.html for a route of the SPA. */
async function serve(pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const file = path.resolve(RENDERER_DIR, `.${decoded}`);
  const inside = file === RENDERER_DIR || file.startsWith(`${RENDERER_DIR}${path.sep}`);
  const exists = inside && existsSync(file) && statSync(file).isFile();
  if (!exists && path.extname(decoded)) return new Response("Not found", { status: 404 });
  const target = exists ? file : path.join(RENDERER_DIR, "index.html");
  const response = await net.fetch(pathToFileURL(target).toString());
  if (target.endsWith(".html")) {
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", CSP);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

/** The server's answer to an API request, with the app's cookies, addresses rewritten to the app's origin. */
async function forward(request: Request, url: URL): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers["x-anothernotes-client"] = CLIENT_HEADER;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
  let response: ServerResponse;
  try {
    response = await serverRequest(`${API_ORIGIN}${url.pathname}${url.search}`, { method: request.method, headers, body });
  } catch (e) {
    console.warn(`[api] ${request.method} ${url.pathname}: ${(e as Error).message}`);
    return new Response(JSON.stringify({ detail: "The AnotherNotes server could not be reached" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-AnotherNotes-Unreachable": "1" },
    });
  }
  console.log(`[api] ${request.method} ${url.pathname} -> ${response.status}`);
  const out = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  }
  // A redirect back to the site (SSO and the desktop exchange land on /auth/callback) is
  // a redirect into the bundle; one elsewhere (accounts.google.com) stays as it is.
  const location = out.get("location");
  if (location) {
    for (const origin of new Set([SITE_ORIGIN, API_ORIGIN])) {
      if (location.startsWith(`${origin}/`) && !location.startsWith(`${origin}/api/`)) {
        out.set("location", `${APP_ORIGIN}${location.slice(origin.length)}`);
      }
    }
  }
  return new Response(hasBodyStatus(response.status) ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}

const hasBodyStatus = (status: number): boolean => status !== 204 && status !== 304 && (status < 300 || status >= 400);
