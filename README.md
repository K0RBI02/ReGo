# ReGo – Android‑App / English below

ReGo ist eine eigenständige Android‑App für Fahrplanauskunft, Streckenverwaltung und Push‑Benachrichtigungen. Dieses Repository enthält den Quellcode und die Build‑Anleitung für die App; diese README beschreibt ausschließlich die App‑Seite des Projekts.

Kurzüberblick

- Nutzerzentriert: Alle persönlichen Daten (Profile, Tickets, Geräte‑IDs) bleiben lokal auf dem Gerät.
- Push‑Benachrichtigungen: Verzögerungen, Ausfälle und Gleiswechsel; optional über Firebase oder über regelmäßige Abfragen, falls Firebase nicht konfiguriert ist.
- Offline‑Modus: Zuletzt geladene Daten bleiben sichtbar; die App zeigt einen Banner „Offline‑Modus | Stand: hh:mm“.
- Tickets: Barcode‑Scan per Kamera (nur über HTTPS) oder Auswahl aus Foto/Screenshot. Gespeichert wird nur der Beschnitt des Barcodes als lokales Bild.
- Schrift: Instrument Sans (SIL OFL) wird lokal aus `public/fonts/` geladen.

Installieren

- APK: Lade die aktuelle APK aus den GitHub Releases: https://github.com/K0RBI02/ReGo/releases oder baue sie selbst. Hinweise zum Bauen und zur Signatur stehen in `deploy/ANDROID.md` (https://github.com/K0RBI02/ReGo/blob/main/deploy/ANDROID.md).
- Autostart/Service: Für den Standalone‑Betrieb ohne Home Assistant gibt es ein Beispielservice‑Unit in `deploy/rego.service`.

Datenschutz

- Keine zentralen Konten: Die App kann ohne Server‑Registrierung verwendet werden; alle sensiblen Informationen verbleiben auf dem Gerät.
- Tickets werden nicht an einen zentralen Server übertragen.
- Gerätewechsel: Die App unterstützt einen Transfer‑Code zum Übertragen von Einstellungen und Strecken auf ein neues Gerät.

Berechtigungen

- Kamera: nur für Barcode‑Scans.
- Netzwerk: nur für Abfragen der Fahrplandaten und, falls konfiguriert, für Push‑Zustellung.

Entwicklung

- Quellcode: `android/` (https://github.com/K0RBI02/ReGo/tree/main/android)
- CI/Build: Optional per GitHub Actions. Siehe die Build‑ und Deploy‑Anweisungen in `deploy/ANDROID.md`.
- Tests: UI‑Smoke‑Tests und lokale Tests sind im Repository enthalten; Anleitungen: `deploy/ANDROID.md` und die Testskripte im `scripts/`‑Verzeichnis.

Mitmachen

Fehlerberichte, Feature‑Wünsche und Pull Requests sind willkommen. Bitte öffne ein Issue: https://github.com/K0RBI02/ReGo/issues oder erstelle einen Pull Request mit einer klaren Beschreibung.

Lizenz

Die App steht unter der repository‑weiten Lizenz: [LICENSE](LICENSE)

---

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
