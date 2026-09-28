/*
  How the app is packaged. `npm run dist:mac` on a Mac gives release/AnotherNote-<version>-universal.dmg
  (drag-to-Applications installer), a .zip of the same app for the updater, and latest-mac.yml,
  the update feed. See the README for signing and notarising.
*/

// Notarise only when Apple credentials are in the environment (CI secrets); otherwise
// build unsigned so a developer can still package locally.
const notarize = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.anothernote.desktop",
  productName: "AnotherNote",
  copyright: "Copyright © 2026 AnotherNote",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["dist/**/*", "static/**/*", "renderer/**/*", "package.json"],
  asar: true,
  // The link that brings a browser sign-in back into the app (src/main/auth.ts).
  protocols: { name: "AnotherNote", schemes: ["anothernotes"] },
  publish: {
    provider: "github",
    owner: "Ifthikar20",
    repo: "Another-note-apple-desktop",
  },
  mac: {
    category: "public.app-category.education",
    target: [
      { target: "dmg", arch: ["universal"] },
      { target: "zip", arch: ["universal"] },
    ],
    icon: "build/icon.png",
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "AnotherNote uses the microphone so you can dictate notes and talk to the tutor.",
    },
  },
  dmg: {
    title: "AnotherNote",
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  // Linux is a testing target only: it lets the packaging be exercised on a Linux box.
  linux: {
    target: ["AppImage"],
    category: "Education",
    icon: "build/icon.png",
  },
};
