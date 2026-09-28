# AnotherNotes for the desktop

The AnotherNotes app for the Mac: the web app's interface, packaged inside the app and
served from the app's own origin, talking to the AnotherNotes API. Plus what a browser
tab cannot give it: a dock icon, native menus and shortcuts, a remembered window, links
that open in your browser, the microphone, its own signed-in session, a loading screen,
and updates that install themselves.

How it is put together:

```
 AnotherNotes.app
 ├─ renderer/          the web app's production build (playstudy-card-dash, `vite build`)
 │                     served at app://anothernotes/…  (src/main/renderer.ts)
 ├─ /api, /img         forwarded to the server with the app's own cookie jar, so the
 │                     web app's relative /api works unchanged and the refresh cookie
 │                     (httpOnly, SameSite=Strict) behaves as on the site
 └─ main process       window, menus, sign-in, updater  (src/main/*.ts)
```

The window is a Mac app's, not a browser's. There is no title bar: as in Notion, the web
app's sidebar runs the full height with the window buttons on it, and the app's own tab
bar sits over the content column, starting where the sidebar ends and following it as it
is resized or folded. Tabs are for notes and learning sessions only, named after the
note (as its title is typed). The dashboard, folders, calendar and profile live in one
home page behind the tabs, shown from the sidebar or the Go menu, never as a tab.
Opening a note or session from anywhere gives it a tab, or brings its tab forward, and
leaves the page it was opened from as it was. The + button and ⌘N start a new note in
a tab, ⌘W closes a note's tab (the last one returns to the home page), Ctrl-Tab moves
between the home page and the notes.

Opening a tab is quick because a copy of the web app is always loaded and waiting out of
sight: a new tab is that copy moving to the note inside the web app, with no reload
(measured: 60 to 110 ms for a note, 130 to 170 ms for a new one including creating it on
the server, against about 330 ms for a copy started fresh). Links are routed before the
page follows them, so the page clicked in never flickers. Closing a tab first leaves the
note the way the web app expects, so an empty new note is deleted and pending progress
is sent, as in a browser; quitting does the same for every open tab. The sidebar is one
for the window: docked or folded in one tab, it is the same in the others. Pages out of
sight load again in the background when a note is made, renamed or deleted, so their
lists are current when they come back. `[tabs]` lines in the terminal time every open.

The interface opens instantly from disk; only data crosses the network. A checkout
without `renderer/` falls back to loading the site in the window, which is how the first
version worked and still handy for a quick look (`scripts/run-mac.sh --site`).

## Running the app

You need a Mac on macOS 13 (Ventura) or later, which is the oldest macOS Electron 44 runs on. One build runs on both Apple silicon
and Intel. The app needs an internet connection: it is the website, in a window.

1. Download `AnotherNotes-<version>-universal.dmg` from the repository's Releases page.
2. Open it and drag **AnotherNotes** onto **Applications**.
3. Open AnotherNotes from Applications or Spotlight. After a short loading screen the
   app shows its own sign-in screen: an email and password, a child's username and PIN,
   or **Continue with Google or Microsoft**, which signs you in through your browser and
   brings you straight back. The account is the same as on the website, and everything
   syncs, because it is the same API.

If the build was not signed and notarised (see below), macOS says the app "cannot be
opened because Apple cannot check it". Right-click the app, choose **Open**, then
**Open** again. macOS remembers the choice.

The first time you press Dictate or talk to the tutor, macOS asks for the microphone.

## One command: build and run

`scripts/run-mac.sh` (also `npm run mac`) does the whole thing: picks Node 22 through nvm,
installs dependencies if they are missing, builds the web app into `renderer/` when it is
not there yet, keeps the build output out of iCloud Drive (codesign rejects files iCloud
has touched), quits a copy that is already running, builds the `.app`, and starts it with
its logs in the terminal. Ctrl-C quits the app.

```sh
scripts/run-mac.sh                          # against anothernote.app
scripts/run-mac.sh http://100.49.56.40/     # against a test server
scripts/run-mac.sh --dev http://100.49.56.40/   # from source, no .app: fastest
scripts/run-mac.sh --renderer               # rebuild the web app bundle first
scripts/run-mac.sh --site                   # load the site in the window, no bundle
scripts/run-mac.sh --dist                   # also build the universal .dmg
scripts/run-mac.sh --key http://100.49.56.40/   # ask for the maintenance-gate key first
```

The web app comes from `scripts/build-renderer.sh`: it clones (or updates) the
`playstudy-card-dash` repo into `.web/`, runs its `build:off` profile (Turnstile off, API
at the relative `/api`, the same as the deployed site), and copies `dist/` to
`renderer/`. Point it at a checkout you already have with `ANOTHERNOTES_WEB_DIR=…`, or at
a branch with `ANOTHERNOTES_WEB_REF=…`. `renderer/BUILD` records the commit, and the app
prints it at start-up. Whenever the web app changes, run it again; the Mac app carries
the build it was packaged with.

## Building the DMG

You need Node 22 or later and, for the DMG itself, a Mac with the Xcode command line
tools (`xcode-select --install`). The `.dmg` target only builds on macOS (electron-builder shells out to `sips` and `hdiutil`); on Linux the
same project can produce the unsigned `.app` in a zip, and a Linux AppImage for testing.

```sh
npm ci
npm run dist:mac
```

That leaves, in `release/`:

| File | What it is for |
|---|---|
| `AnotherNotes-<version>-universal.dmg` | the installer people download |
| `AnotherNotes-<version>-universal-mac.zip` | the same app, zipped, which the updater downloads |
| `latest-mac.yml` | the update feed: version, file names, checksums |

Under the hood, `npm run dist:mac` is two steps:

```
tsc                       src/main/*.ts, src/preload/index.ts  →  dist/
electron-builder --mac    dist/ + static/ + node_modules  →  app.asar
                          Electron.app + app.asar + icon + Info.plist  →  AnotherNotes.app
                          AnotherNotes.app  →  signed, notarised (when credentials exist)
                          AnotherNotes.app  →  .dmg  (drag to Applications), .zip, latest-mac.yml
```

To run it without packaging, or against a local copy of the web app:

```sh
npm start                                            # the live site
ANOTHERNOTES_URL=http://localhost:8080 \
ANOTHERNOTES_API_URL=http://localhost:8010/api npm start   # the web app's dev server + a local API
```

While the site is behind its maintenance gate (nginx answers "Back soon" with a 503 unless
the `an_preview` cookie holds the team key), give the app the key once and it keeps it
for 30 days, in its own profile:

```sh
ANOTHERNOTES_URL=http://100.49.56.40/ ANOTHERNOTES_PREVIEW_KEY='the team key' npm start
```

The app never shows the gate's "Back soon" page itself: a 503 is dropped before it
renders, and the app's own "being updated" page waits and retries every 15 seconds. The
terminal says which page was gated. For the packaged app, run
the binary from a terminal the same way (see *Running the app*).

`npm run pack` builds the `.app` into `release/mac-universal/` without a DMG, for a
quick look.

## Signing and notarising

An unsigned app works, with the right-click dance above, and cannot update itself
(macOS only lets a signed app replace itself). For anyone else to double-click it you
need:

1. An [Apple Developer Program](https://developer.apple.com/programs/) membership.
2. A **Developer ID Application** certificate, created in Xcode or at
   developer.apple.com, exported from Keychain Access as a `.p12` with a password.
3. An app-specific password for your Apple ID (appleid.apple.com → Sign-In and Security).
4. Your team ID (the 10-character code on developer.apple.com → Membership).

Locally, put them in the environment and build as usual:

```sh
export CSC_LINK=/path/to/developer-id.p12
export CSC_KEY_PASSWORD='the p12 password'
export APPLE_ID='you@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='ABCDE12345'
npm run dist:mac
```

electron-builder signs the app with the hardened runtime and the entitlements in
`build/entitlements.mac.plist`, sends it to Apple's notary service, and staples the
ticket. When the Apple variables are absent it skips notarising; when no certificate is
found it skips signing, with a warning.

## Releases and updates

`.github/workflows/mac.yml` builds the app on a macOS runner.

- Push a tag such as `v0.1.0` and it publishes a **draft** GitHub release with the
  `.dmg`, the `.zip` and `latest-mac.yml`. Check it, then publish the release.
- Run the workflow by hand from the Actions tab and it only uploads the files as a
  workflow artifact.

Add the five secrets named at the top of the workflow to sign and notarise in CI
(the certificate is the `.p12` base64-encoded: `base64 -i developer-id.p12 | pbcopy`).

Installed apps check the published releases on start and every four hours, download
the next version in the background, and ask before restarting. The version comes from
`package.json`; bump it before tagging.

## Signing in

The desktop has its own sign-in screen (`static/signin.html`), not the website's. It is
a desk: a paper plane crosses behind the card, a pencil doodles and twirls when clicked,
a sticky note can be dragged, leaves fall, a paper ball can be tossed (and bounces, and
can be landed in the pencil holder), and the pencil holder watches the pointer, follows
the caret while a name is typed and closes its eyes while a password is. A wrong
password gets a head shake; a right one sends a paper plane off from the button while
the dashboard loads out of sight, and the dashboard takes the screen's place once it has
drawn, with nothing blank in between. The loading screen before it is a pencil writing a
note while a paper plane circles it. Both follow the system's light or dark appearance,
and hold still for anyone who has asked macOS to reduce motion. It
signs in against the same endpoints the website uses, from the main process
(`src/main/signin.ts`):

```
 sign-in screen ──ipc──▶ main process: POST /api/auth/login  (or /auth/child/login)
                         with the app's cookie jar: the refresh cookie the API sets
                         (httpOnly, /api/auth/) is stored for the server
                ◀─────── {access_token}
 window ──▶ /auth/callback#token=…&next=/dashboard
            the web app's own page for adopting a token, as after a Google sign-in
```

The password goes from the screen to the API and nowhere else; the web app never sees
it. Whenever the web app sends someone to its own sign-in pages (`/auth`, `/kids`: a
signed-out visit, or signing out), the window shows the app's screen instead, and the
website's landing page is skipped for the dashboard.

The server's cookies are handled by the app itself (`src/main/server.ts`) for every
request to the server, the sign-in above and the web app's `/api` alike. They live in
the app's cookie jar with the attributes the server gave them, with one exception: on a
plain http server (a test box without a domain yet) the API's Secure flag is dropped,
because Chromium would otherwise refuse the refresh cookie and the app would forget the
session after 15 minutes. The terminal prints each cookie the app stores or removes, by
name, never by value, and `session cookie stored` after a sign-in.

## Signing in through the browser

Google refuses to sign in inside an Electron window, and the browser is where a student
is usually signed in already. So the app can send them there and take the session back:

```
 desktop app                       browser: anothernote.app                identity API
 ───────────                       ────────────────────────                ────────────
 state + PKCE secret (auth.ts)
 opens /desktop/sign-in?state&challenge ─▶ sign in as usual (any method)
                                          POST /api/auth/desktop/handoff ─▶ one-time code, 2 minutes,
                                            {state, code_challenge}          bound to the challenge
                                          anothernotes://auth/callback?code&state
 ◀── the OS hands the link to the app
 window loads /api/auth/desktop/exchange?code&state&code_verifier ────────▶ sha256(verifier) == challenge,
                                                                            burn the code, set the refresh
                                                                            cookie in the app's own jar,
                                                                            redirect to /auth/callback#token
 signed in, on the dashboard
```

The secret never leaves the app, so a link seen on the way (a log, another app that
registered the scheme) cannot be exchanged. The browser's own session is untouched.
The web app and the API halves live in the web and backend repos (`/desktop/sign-in`,
`identity/accounts/desktop.py`).

Ways to start it: **Continue with Google or Microsoft** on the sign-in screen, **File → Sign In with Your Browser…**, the Google
button on the web app's sign-in page (the web app sees `window.anothernotes` and asks the
app), and the dialog the app shows if a page tries to reach Google's sign-in anyway.

The link works because the app is registered for the `anothernotes://` scheme
(`protocols` in the builder config puts it in `Info.plist`). macOS only routes the scheme
to a packaged app, so to try the whole round trip in development run `npm run pack` and
open `release/mac-universal/AnotherNotes.app` once; `npm start` alone can test everything
up to the link.

## Lessons in the window

Teach mode is the web app's, unchanged: the tutor's pointer is drawn by the page, and the
voice is Speechify's, streamed clip by clip through MediaSource and playing while the
bytes still arrive. What the shell adds around it:

- **The screen stays awake** while the window is making sound, and for a minute after
  it goes quiet, so a lesson never dims mid-explanation.
- **No throttling behind other windows**: Chromium would slow a background page's
  timers to a crawl, and the tutor's timing and the pointer's flights are timers.
- **Media keys and the Now Playing widget** play, pause and step the lesson: the web app
  publishes the lesson through the Media Session API, and Chromium hands the hardware
  keys to it.
- **The microphone** goes straight to the server's transcription (faster-whisper).
  Chromium's built-in recognizer exists in Electron but has no Google key behind it and
  fails on every use, so the web app skips it when it runs in the app. macOS asks for
  the microphone the first time; the usage description and entitlement are in place.

Checked in this build with a streamed MP3: playback starts about 120 ms in, before the
clip has finished arriving; the voice headers are readable; recording through the
permission handler yields Opus; the display blocker engages on Chromium's own audible
signal.

## Layout

```
src/main/index.ts       app lifecycle: single instance, permissions, the client header, deep links, IPC
src/main/signin.ts      the app's own sign-in: email and password, or a child's PIN, against the API
src/main/auth.ts        sign-in through the browser: state + PKCE, the anothernotes:// link, the exchange
src/main/renderer.ts    the bundled web app at app://anothernotes, and /api forwarded to the server
src/main/server.ts      requests to the server, with the app keeping the server's cookies itself
src/main/events.ts      "lists-changed", from the API forwarder to the window, to refresh pages out of sight
src/main/windows.ts     the main window: tab bar and tabs, loading screen, sign-in routing, navigation rules
src/main/media.ts       the display stays awake while the window plays sound
src/main/menu.ts        native menus and shortcuts (New Note, Go, Reload, zoom, updates)
src/main/updater.ts     electron-updater against the GitHub Releases feed
src/main/store.ts       window-state.json in the app's data folder
src/main/config.ts      the server, ANOTHERNOTES_URL override, bundled renderer or site, the client header
src/preload/index.ts    window.anothernotes = { platform, version, auth }; reports the sidebar's edge for the tab bar
src/preload/toolbar.ts  the tab bar's bridge: what to draw in, what was clicked out
static/toolbar.html     the tab bar: back, forward, the tabs, new tab
static/signin.html      the app's sign-in screen: email and password, a child's PIN, or the browser
static/loading.html     the loading screen shown while the first page loads
static/offline.html     shown when the server cannot be reached or is being updated; retries on its own
scripts/run-mac.sh      build and run in one command (see above)
scripts/build-renderer.sh  build the web app into renderer/
build/icon.png          the app icon (the web app's an-logo.svg at 1024 px)
build/entitlements.mac.plist   hardened runtime + microphone
electron-builder.config.cjs    targets, signing, notarising, the update feed
```

Rules the shell enforces: the renderer runs sandboxed with context isolation and no
Node; the microphone is granted to the app's origin only, and no other permission is;
links to other sites open in the system browser; every request to the app's origin
carries `X-AnotherNotes-Client: desktop/<version> (<platform>)` so the API can tell
the desktop apart.

## Known limits of v0

- **Google sign-in** happens in your browser (above), never in the window, because
  Google refuses it there. Microsoft sign-in and "connect a note source" round-trip
  inside the window as on the web; SAML goes through the browser too.
- **Nothing works offline** beyond the "can't reach AnotherNotes" page; the app is the
  website.
- **Auto-update needs a signed build.**
- Linux and Windows are not targets yet. The Linux AppImage target exists only so the
  packaging can be exercised on a Linux machine.

## What comes next

In order, from the desktop architecture note in the web repo:

1. **The packaged renderer**: the web app's `dist/` shipped inside the app, with the
   refresh token in the macOS keychain, an instant start and read-only offline.
2. Quick capture from anywhere, deep links into notes and lessons, file associations,
   reminders, media keys, and a disk cache for the tutor's voice clips.
