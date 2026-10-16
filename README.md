# ReGo – Android‑App

ReGo ist eine eigenständige Android‑App für Fahrplanauskunft, Streckenverwaltung und Push‑Benachrichtigungen. Dieses Repository enthält den Quellcode und die Build‑Anleitung für die App; diese README beschreibt ausschließlich die App‑Seite des Projekts.

Kurzüberblick

- Nutzerzentriert: Alle persönlichen Daten (Profile, Tickets, Geräte‑IDs) bleiben lokal auf dem Gerät.
- Push‑Benachrichtigungen: Verzögerungen, Ausfälle und Gleiswechsel; optional über Firebase oder über regelmäßige Abfragen, falls Firebase nicht konfiguriert ist.
- Offline‑Modus: Zuletzt geladene Daten bleiben sichtbar; die App zeigt einen Banner „Offline‑Modus | Stand: hh:mm“.
- Tickets: Barcode‑Scan per Kamera (nur über HTTPS) oder Auswahl aus Foto/Screenshot. Gespeichert wird nur der Beschnitt des Barcodes als lokales Bild.
- Schrift: Instrument Sans (SIL OFL) wird lokal aus `public/fonts/` geladen.

Installieren

- APK: Lade die aktuelle APK aus den GitHub Releases oder baue sie selbst. Hinweise zum Bauen und zur Signatur stehen in `deploy/ANDROID.md`.
- Autostart/Service: Für den Standalone‑Betrieb ohne Home Assistant gibt es ein Beispielservice‑Unit in `deploy/rego.service`.

Datenschutz

- Keine zentralen Konten: Die App kann ohne Server‑Registrierung verwendet werden; alle sensiblen Informationen verbleiben auf dem Gerät.
- Tickets werden nicht an einen zentralen Server übertragen.
- Gerätewechsel: Die App unterstützt einen Transfer‑Code zum Übertragen von Einstellungen und Strecken auf ein neues Gerät.

Berechtigungen

- Kamera: nur für Barcode‑Scans.
- Netzwerk: nur für Abfragen der Fahrplandaten und, falls konfiguriert, für Push‑Zustellung.

Entwicklung

- Quellcode: `android/`
- CI/Build: Optional per GitHub Actions. Siehe die Build‑ und Deploy‑Anweisungen in `deploy/ANDROID.md`.
- Tests: UI‑Smoke‑Tests und lokale Tests sind im Repository enthalten; Anleitungen: `deploy/ANDROID.md` und die Testskripte im `scripts/`‑Verzeichnis.

Mitmachen

Fehlerberichte, Feature‑Wünsche und Pull Requests sind willkommen. Bitte ein Issue eröffnen, bevor größere Änderungen per PR vorgeschlagen werden.

Lizenz

Siehe die repository‑weite Lizenzdatei.
