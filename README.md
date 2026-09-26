# AnotherNotes for the desktop

The AnotherNotes web app in a window of its own: a dock icon, native menus and
shortcuts, a remembered window, links that open in your browser, the microphone, sign-in
through your browser, and updates that install themselves. This is "v0" of the desktop
plan: the window loads the live site at `https://anothernote.app`. The packaged renderer,
keychain sign-in, quick capture and offline reading come next (see *What comes next*).

## Running the app

You need a Mac on macOS 13 (Ventura) or later, which is the oldest macOS Electron 44 runs on. One build runs on both Apple silicon
and Intel. The app needs an internet connection: it is the website, in a window.

1. Download `AnotherNotes-<version>-universal.dmg` from the repository's Releases page.
2. Open it and drag **AnotherNotes** onto **Applications**.
3. Open AnotherNotes from Applications or Spotlight. The welcome screen offers two ways
   in: **Continue with your browser** signs you in on anothernote.app in your browser
   (Google, Microsoft, email, or a child's PIN) and brings you straight back; **Sign in
   here** shows the web app's own sign-in page in the window, for email and password or
   a PIN.

If the build was not signed and notarised (see below), macOS says the app "cannot be
opened because Apple cannot check it". Right-click the app, choose **Open**, then
**Open** again. macOS remembers the choice.

The first time you press Dictate or talk to the tutor, macOS asks for the microphone.

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

Ways to start it: the welcome screen, **File → Sign In with Your Browser…**, the Google
button on the web app's sign-in page (the web app sees `window.anothernotes` and asks the
app), and the dialog the app shows if a page tries to reach Google's sign-in anyway.

The link works because the app is registered for the `anothernotes://` scheme
(`protocols` in the builder config puts it in `Info.plist`). macOS only routes the scheme
to a packaged app, so to try the whole round trip in development run `npm run pack` and
open `release/mac-universal/AnotherNotes.app` once; `npm start` alone can test everything
up to the link.

## Layout

```
src/main/index.ts       app lifecycle: single instance, permissions, the client header, deep links, IPC
src/main/auth.ts        sign-in through the browser: state + PKCE, the anothernotes:// link, the exchange
src/main/windows.ts     the main window, welcome screen, remembered bounds, navigation rules, context menu
src/main/menu.ts        native menus and shortcuts (New Note, Go, Reload, zoom, updates)
src/main/updater.ts     electron-updater against the GitHub Releases feed
src/main/store.ts       window-state.json in the app's data folder
src/main/config.ts      the app URL, ANOTHERNOTES_URL override, the client header
src/preload/index.ts    window.anothernotes = { platform, version, auth }; three fixed calls, nothing else
static/welcome.html     the native welcome screen: continue with your browser, or sign in here
static/offline.html     shown when the site cannot be reached; retries on its own
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
