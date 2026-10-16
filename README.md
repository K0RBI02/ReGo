# ReGo – Android App

ReGo is a standalone Android app for timetable lookup, route management and push notifications. This repository contains the app source and build instructions; this README focuses only on the app side of the project.

Quick summary

- User‑centric: All personal data (profiles, tickets, device IDs) stays on the device.
- Push notifications: Delays, cancellations and platform changes; optional via Firebase or periodic polling if Firebase is not configured.
- Offline mode: Last fetched data remains visible; the app shows a banner “Offline mode | as of hh:mm”.
- Tickets: Barcode scanning via camera (HTTPS only) or selecting from a photo/screenshot. Only the cropped barcode image is stored locally.
- Typeface: Instrument Sans (SIL OFL) is loaded locally from `public/fonts/`.

Install

- APK: Download the latest APK from GitHub Releases: https://github.com/K0RBI02/ReGo/releases or build it yourself. Build and signing notes are in `deploy/ANDROID.md` (https://github.com/K0RBI02/ReGo/blob/main/deploy/ANDROID.md).
- Autostart/Service: A sample systemd unit for standalone usage is provided at `deploy/rego.service`.

Privacy

- No central accounts required: the app can be used without server registration; sensitive data remains on the device.
- Tickets are never uploaded to a central server.
- Device transfer: The app supports a one‑time transfer code to move settings and routes to a new device.

Permissions

- Camera: only for barcode scanning.
- Network: only for fetching timetable data and, if configured, for push delivery.

Development

- Source: `android/` (https://github.com/K0RBI02/ReGo/tree/main/android)
- CI/Build: optional via GitHub Actions. See `deploy/ANDROID.md` for build/deploy instructions.
- Tests: UI smoke tests and local tests are included; see `scripts/` and `deploy/ANDROID.md`.

Contributing

Bug reports, feature requests and pull requests are welcome. Open an issue at https://github.com/K0RBI02/ReGo/issues before larger changes.

License

This project is covered by the repository license: [LICENSE](LICENSE)
