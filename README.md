# AnotherNotes for the desktop

The AnotherNotes web app in a window of its own: a dock icon, native menus and
shortcuts, a remembered window, links that open in your browser, the microphone, and
updates that install themselves. This is "v0" of the desktop plan: the window loads
the live site at `https://anothernote.app`, so nothing in the web app or the API changes
for it. The packaged renderer, keychain sign-in, quick capture and offline reading come
next (see *What comes next*).

## Running the app

You need a Mac on macOS 13 (Ventura) or later, which is the oldest macOS Electron 44 runs on. One build runs on both Apple silicon
and Intel. The app needs an internet connection: it is the website, in a window.

1. Download `AnotherNotes-<version>-universal.dmg` from the repository's Releases page.
2. Open it and drag **AnotherNotes** onto **Applications**.
3. Open AnotherNotes from Applications or Spotlight and sign in with your email and
   password, or a child's username and PIN.

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
ANOTHERNOTES_URL=http://localhost:8080 npm start     # the web app's vite dev server
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

## Layout

```
src/main/index.ts       app lifecycle: single instance, permissions, the client header
src/main/windows.ts     the main window, remembered bounds, navigation rules, context menu
src/main/menu.ts        native menus and shortcuts (New Note, Go, Reload, zoom, updates)
src/main/updater.ts     electron-updater against the GitHub Releases feed
src/main/store.ts       window-state.json in the app's data folder
src/main/config.ts      the app URL, ANOTHERNOTES_URL override, the client header
src/preload/index.ts    window.anothernotes = { platform, version }; nothing else
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

- **Google sign-in** is refused by Google inside desktop app windows. The app explains
  and suggests email and password. Microsoft sign-in, SAML through WorkOS and
  "connect a note source" round-trip inside the window and work as on the web.
- **Nothing works offline** beyond the "can't reach AnotherNotes" page; the app is the
  website.
- **Auto-update needs a signed build.**
- Linux and Windows are not targets yet. The Linux AppImage target exists only so the
  packaging can be exercised on a Linux machine.

## What comes next

In order, from the desktop architecture note in the web repo:

1. **Sign-in through the system browser** for Google and Microsoft: the API redirects
   to `anothernotes://auth/callback` with a one-time code the app exchanges for tokens.
2. **The packaged renderer**: the web app's `dist/` shipped inside the app, with the
   refresh token in the macOS keychain, an instant start and read-only offline.
3. Quick capture from anywhere, deep links, file associations, reminders, media keys,
   and a disk cache for the tutor's voice clips.
