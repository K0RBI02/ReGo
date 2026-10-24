---
paths:
  - "android/**"
---

# Android app (`android/`)

Loaded when you work on the Android app.

A thin Java shell (package `io.github.k0rbi02.rego`, minSdk 29, compile and target SDK 34, Java 17, no Kotlin, no minify). The UI is bundled; only data comes from the server.

- **`MainActivity`** – a `WebView` with `WebViewAssetLoader` serving the bundled UI at `https://appassets.androidplatform.net/` (paths without a dot map to `index.html`; external links open in the browser). JavaScript and DOM storage on, file and content access off, text zoom fixed at 100 %, portrait only, `allowBackup=false`. It grants the camera (for scanning) and location (approximate is enough) to the page after asking Android, handles the file chooser, recovers from a killed render process instead of crashing, restores state on rotation, and routes shortcut and notification taps: `onNewIntent` calls `window.REGO.navigate(path)` if the UI is running, otherwise loads the URL.
- **`RegoNative` (the JavaScript bridge, class `Bridge`)** – `appVersion()`, `setBrightness(f)` (negative = system), `keepScreenOn(bool)`, `setBars(color)`, `setBarColors(top, bottom)` (accepts `#rrggbb` and `rgb()`; chooses light or dark icons by luminance), `enablePush(device, api)` (asks for POST_NOTIFICATIONS on Android 13+, schedules polling, fetches the Firebase token and answers through `window.__rgPushDone(token | false)`), `disablePush()`, `saveFile(name, mime, base64)` → boolean (into `Download` via MediaStore). The UI feature-detects `window.RegoNative` and its methods because the same UI also runs in a browser and an older APK might lack a method.
- **`PollWorker`** – a WorkManager periodic job (15 min, the shortest Android allows, needs network) that calls `GET /api/notifications` with the stored device ID and shows what it gets. Notification channels: `rego-verspaetung` (Verspätungen, high), `rego-ausfall` (Ausfälle und Ersatzverkehr, high), `rego-baustelle` (Baustellen, default), `rego-gleis` (Gleiswechsel, low/quiet). **Never rename or recreate a channel ID**: users' per-channel settings (sound, quiet, off) would be lost. The single channel `rego-meldungen` of versions up to 0.5.1 was replaced by these four and is deleted at start. A notification's tag is the incident tag from the server; `update: true` re-posts silently; `clear: true` rewrites a delay, replacement or construction notification to "<line> · behoben" (silent, gone after 6 s) and simply removes cancellations and platform changes; if the user already swiped it away nothing happens. HTTP 403 means "invitation code needed" and is ignored (the app asks on the next open).
- **`PushService`** – `FirebaseMessagingService`: any message triggers `PollWorker.fetchAndShow` (the message carries no text), `onNewToken` PUTs the new token to `/api/push/native`.
- **`shortcuts.xml`** – long-press shortcuts in this order: "Ticket anzeigen" (`/Ticket`), "Meldungen" (`/Meldungen`), "Neue Strecke" (`/Strecken#neu`).
- **Build** – `android/app/build.gradle`: `copyWebUi` copies `../public` (minus the excluded files) into generated assets and writes `native-config.js` with `window.REGO_API = 'https://<host>'`; the `google-services` plugin is applied only if `android/app/google-services.json` exists (CI writes it from a secret; without it the app polls); signing uses `RG_KEYSTORE` / `RG_KEYSTORE_PASSWORD` (alias `rego`) or falls back to the debug key; `-PrgHost`, `-PrgVersionName`, `-PrgVersionCode` come from CI. Dependencies: appcompat 1.7.0, webkit 1.11.0, work 2.9.1, core 1.13.1, Firebase BoM 33.1.2 (messaging only); Android Gradle Plugin 8.5.2, google-services plugin 4.4.2; there is no Gradle wrapper in the repository, CI installs Gradle 8.9.
- **Permissions:** INTERNET, POST_NOTIFICATIONS, ACCESS_FINE/COARSE_LOCATION, CAMERA (camera feature not required).
- There are no Android unit tests. Everything the Java does is small; the logic that matters is in the UI and server, which are tested. After touching Java, build it (CI does) and have Korbi test on the phone.

## Decisions and their reasons

- *Android only, a thin native shell around the web UI.* The browser/PWA version has been unsupported since 0.6.0 (service worker, web manifest, browser push with its VAPID keys and the PWA icons were removed). One supported client is less to keep true, and what makes the app useful (full brightness for the ticket, the Download folder, notification channels, a notification service) is native. iOS was rejected by Korbi.
- *The nudge is empty* (0.3.1): Firebase carries `{n: '1'}` and the app fetches the text from the ReGo server, so no message content reaches Google. Without a Firebase key the app polls about every 15 minutes (the shortest period WorkManager allows).
- *One notification channel per kind* (0.6.0), so users tune sound and importance per kind in the Android settings. The platform change is quiet.
- *"behoben"* (0.1.34, 0.6.0): when an incident ends, a delay/replacement/construction notification is rewritten to "<line> · behoben" and vanishes after 6 s; cancellations and platform changes simply disappear; a notification the user already swiped away is left alone.
- *Fixed text size and portrait only* (0.6.0): the layout shifted with the system font size.
- *The app is excluded from Android backups* (`allowBackup=false`): tickets exist on exactly one device unless the user saves them to a file.

## Traps

- **Do not change the app origin, the `applicationId` (`io.github.k0rbi02.rego`) or the signing key.** All tickets live in the `localStorage` of `https://appassets.androidplatform.net`; a changed key means users must uninstall, which deletes the tickets. `versionCode` is the number of the CI run and only ever rises.
- **Never rename or recreate a notification channel ID** (users' per-channel settings are lost).
- **The notification `tag` is `inc|<incidentId>`**; the update and "behoben" logic depends on it.
- **A push without content must not produce a generic message** (0.1.34).
- **Bridge methods may be missing in older APKs**: the UI feature-detects them (`ui.md`).
- **Firebase needs `android/app/google-services.json`** (git-ignored; CI writes it from a secret). Without it the app polls. The server needs its own key (`fcm_key`).
- **There is no local Android build setup**: CI builds the APK. Do not start Gradle locally unless Korbi has set up Android Studio.
