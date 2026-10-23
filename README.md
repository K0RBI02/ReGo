# ReGo – Android App

ReGo is a standalone Android app for timetable lookup, route management and push notifications. This repository contains the app source and build instructions; this README focuses only on the app side of the project. The server side is described in [BACKEND.md](BACKEND.md).

## Quick summary

- User‑centric: All personal data (profiles, tickets, device IDs) stays on the device.
- Push notifications: Delays, cancellations and platform changes; optional via Firebase or periodic polling if Firebase is not configured.
- Offline mode: Last fetched data remains visible; the app shows a banner “Offline mode | as of hh:mm”.
- Tickets: Barcode scanning via camera (HTTPS only) or selecting from a photo/screenshot. Only the cropped barcode image is stored locally.
- Typeface: Instrument Sans (SIL OFL) is loaded locally from `public/fonts/`.

## Install

- APK: Download the latest APK from GitHub Releases: https://github.com/K0RBI02/ReGo/releases or [build it yourself](#building-the-apk). On the phone, open the release page in the browser, download `rego-<version>.apk` and tap it (allow “install from this source” once). Install a new version over the old one: routes and tickets stay as long as the signing key is the same.
- Server: The app needs a running ReGo server, see [BACKEND.md](BACKEND.md). If it cannot be reached, the app shows the last state with the “Offline mode” banner.
- Autostart/Service: A sample systemd unit for standalone usage is in [BACKEND.md](BACKEND.md#standalone).
- New phone: The app is excluded from Android backups. On the old phone use “Tickets sichern” (back up tickets) and create a code under settings → “Neues Handy?”; on the new phone restore the tickets file and enter the code. If the server has an invitation code, the new phone needs it first.

## In the app

The interface is German; labels in quotes are shown as in the app.

- Portrait only, fixed text size: the interface does not follow Android’s font size, otherwise parts would shift.
- Shortcuts: long-press the app icon for “Ticket anzeigen”, “Meldungen” and “Neue Strecke”.
- Routes with transfers: if two stops have no direct connection, “Neue Strecke” looks for one by itself as soon as both stops are chosen and shows what it found before you save (“Gefunden · 1 Umstieg”). ReGo uses one transfer and goes up to two (“Gefunden · 2 Umstiege”) only if there is nothing with one, for example during construction. If even two do not work, it says so and creates nothing. Such a route shows the transfers on the main screen and raises an alert (also as push) when a connection is at risk or missed.
- Notification channels (Android settings → Apps → ReGo → Notifications): “Verspätungen” (delays), “Ausfälle und Ersatzverkehr” (cancellations and replacement transport), “Baustellen” (construction) and “Gleiswechsel” (platform changes, quiet). Each can be made louder, quieter or switched off.
- Settings (bottom of “Strecken”): push on/off, delay threshold, test notification, “Neues Handy?”, feedback link, “Fehlerbericht speichern” (a text file in the Download folder with versions, state and the latest errors, without stops, routes, tickets or device ID) and version.
- Invitation code: if the server has one set (add-on option `invite_code`), the app asks for it once on a new device.
- Icon: a runner with backpack and briefcase; the background follows the system theme, and Android 13+ can use the themed icon.
- Good to know: with Tailscale “Serve” the phone needs Tailscale switched on (mobile data works), with “Funnel” it does not. If notifications arrive late, exclude ReGo from battery optimization.

## Privacy

- No central accounts required: the app can be used without server registration; sensitive data remains on the device.
- Tickets are never uploaded to a central server.
- Device transfer: The app supports a one‑time transfer code to move settings and routes to a new device.

## Permissions

- Camera: only for barcode scanning.
- Network: only for fetching timetable data and, if configured, for push delivery.

## Development

- Source: `android/` (https://github.com/K0RBI02/ReGo/tree/main/android)
- CI/Build: optional via GitHub Actions, see below.
- Tests: UI smoke tests and local tests are included; see [Development](BACKEND.md#development) in BACKEND.md.

### Building the APK

GitHub builds the app: automatically when a push changes `android/` or `public/`, or by hand under Actions → “Build Android app (APK)” → Run workflow. The app version comes from `version` in `rego/config.yaml`. After about 5 minutes the file is under Releases (`app-v<version>`).

One-time setup (repository → Settings → Secrets and variables → Actions):

1. Secret `ANDROID_KEYSTORE_B64`: the signing key (keystore file, Base64).
2. Secret `ANDROID_KEYSTORE_PASSWORD`: its password.
3. Optional secret `GOOGLE_SERVICES_JSON_B64`: Firebase configuration for instant push (below).
4. Optional variable `REGO_HOST`: the server address without `https://`. The workflow has a default; it can also be entered when starting the workflow by hand.

Keep the signing key safe and never commit it: with a different key a new APK cannot be installed over the old one.

### Instant push (Firebase)

With Firebase, notifications arrive instantly: the server only sends an empty nudge and the app fetches the text itself. Without Firebase the app asks the server about every 15 minutes (the shortest interval Android allows for background work). Once a delay, replacement transport or construction is over, the app rewrites its notification to “behoben” (resolved) and removes it shortly after.

Set up once:

1. Create a Firebase project, register an Android app with the package name `io.github.k0rbi02.rego` and download `google-services.json`. Put the file as Base64 (`base64 -w0 google-services.json`) into the GitHub secret `GOOGLE_SERVICES_JSON_B64`.
2. In Firebase → Project settings → Service accounts → “Generate new private key”. Paste the whole content of the JSON file into the add-on option `fcm_key` (standalone: `REGO_FCM_KEY`) and restart the server.
3. Build the APK again (see above) and install it. In the app, open “Strecken” → settings, switch push on and send a test notification.
4. Check on the server: the status page `/status` shows “Sofort-Push: an” and, for the push subscriptions, “mit Firebase-Kennung”; the log says “Push: Firebase-Schlüssel geladen” at start. If notifications still arrive only every ~15 minutes, see [Troubleshooting](BACKEND.md#troubleshooting).

## Contributing

Bug reports, feature requests and pull requests are welcome. Open an issue at https://github.com/K0RBI02/ReGo/issues before larger changes.

## License

This project is covered by the repository license: [LICENSE](LICENSE)
