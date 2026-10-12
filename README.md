# ReGo – Backend

Node.js ≥ 20. Holt Fahrplandaten aus mehreren Quellen: regionale Verbünde (MVV, EFA), ÖBB und DB (Bibliotheken `hafas-client`, `db-vendo-client`, Ausweichquelle transport.rest) und liefert dem Frontend genau die Struktur aus dem Datenvertrag (`window.REGO`).

## App (PWA)
`public/` ist die App: dein Design (`public/screens/*.dc.html`) läuft unverändert, `public/js/dc-lite.js` führt es aus, `public/js/rego-live.js` füllt es mit den Backend-Daten. Das Backend liefert die App mit aus, nach `npm start` einfach `http://127.0.0.1:8080/` öffnen. Aufs Handy: im Browser „Zur Startseite hinzufügen“ (Installieren geht nur über https oder localhost).
- Offline: letzter Stand bleibt im Gerät, Banner „Offline-Modus | Stand: hh:mm“.
- Tickets und Geräte-ID liegen nur im Gerät (localStorage).
- Schrift: ReGo nutzt die Systemschrift (keine Drittanbieter). Wer Instrument Sans möchte, legt die Datei als `public/fonts/InstrumentSans.woff2` ab und ergänzt in `public/index.html` eine `@font-face`-Regel.
- Ticket-Safe: Barcode per Kamera (nur https) oder aus Foto/Screenshot; gespeichert wird der Zuschnitt des Codes als Bild, nur lokal. Wallet-Apps lassen sich aus dem Browser nicht auslesen.
- Push: VAPID ohne Fremdbibliothek, Push ist leer, der Text kommt vom Backend. Prüfintervall `REGO_NOTIFY_SEC` (60). Nachtruhe 23–4 Uhr.

## Als Home-Assistant-Add-on
In Home Assistant: Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories → `https://github.com/K0RBI02/ReGo` hinzufügen. Das fertige Image baut GitHub Actions (`.github/workflows/build.yml`), der Pi lädt es nur. Neue Version = `version` in `rego/config.yaml` erhöhen und pushen. Mehr in `rego/DOCS.md`.

## Handy-Installation
Siehe `deploy/ANDROID.md` (https über Tailscale, Chrome → „App installieren“). Autostart: `deploy/rego.service`.

## Datenschutz
Siehe [DATENSCHUTZ.md](DATENSCHUTZ.md). Kurz: keine Konten, keine Tickets auf dem Server, Profile werden nach 180 Tagen ohne Nutzung gelöscht (`REGO_PROFILE_DAYS`).

## Tests
`npm test` (Server und Fachlogik) und `node scripts/ui-smoke.mjs` (Bildschirmtest, braucht Playwright). Beides läuft vor jedem Build auf GitHub; schlägt ein Test fehl, wird kein Image gebaut.

## Starten
    npm run demo      # Beispieldaten, ohne Internet
    npm start         # echte Daten (transport.rest)
    npm test
    npm run probe     # echte Antworten abholen -> fixtures/real/ (bitte auf Lab02 ausführen)

Umgebungsvariablen: `PORT` (8080), `HOST` (127.0.0.1; fürs LAN `0.0.0.0`), `REGO_DATA`, `REGO_PUBLIC`, `REGO_PROVIDER` (`transport-rest`|`mock`), `REGO_DB_URL`, `REGO_OEBB_URL`, `REGO_CORS`.

## API
Alle Pfade außer `health` und `status` brauchen den Header `X-Device: <zufällige ID, 16–64 Zeichen>` (anonym, vom Frontend einmal erzeugt).

| Pfad | Zweck |
|---|---|
| GET /api/health | Lebenszeichen |
| GET /api/status | Version, Quellenzustand, Anzahl Geräte (ohne persönliche Daten), Seite `/status` |
| GET /api/stations?q= | Haltestellensuche (braucht die Geräte-ID) |
| GET /api/state?lat=&lon= | kompletter Zustand (tours, incidents, lines, connection, settings, clock) |
| POST /api/tours | `{from:{id,name}, to:{id,name}, schedule?, roundTrip?, returnAfter?}` |
| PATCH /api/tours/:id | `active`, `name`, `schedule` |
| DELETE /api/tours/:id | Strecke löschen |
| PUT /api/settings | `{pushThresholdMin: 3｜5｜10, pushWindow: true｜false}` (Push nur ±20 Min. um die Abfahrt) |
| GET/PUT/DELETE /api/profile | Profil lesen / ersetzen (Rückgängig) / löschen |
| PUT /api/push | Push-Abo speichern (schickt eine Test-Meldung), DELETE löscht es |
| GET /api/push/key | öffentlicher VAPID-Schlüssel |
| GET /api/notifications | holt und leert die wartenden Meldungen (ruft der Service Worker nach einem Push) |

## Verhalten
- Ausfall der Quelle: letzter Stand bleibt, `connection.status = 'error'`, `lastSync` zeigt dessen Zeit. „offline“ setzt das Frontend selbst.
- Meldungen: Ersatzverkehr/Baustelle aus den Hinweisen der Bahn (Stichwörter in `server/domain/classify.mjs`), Verspätung ab `incidentMinDelay` (3 Min.). Ereignisse bleiben bis `validity.until`, Verspätungen noch `delayGraceMin` länger.
- Tickets liegen nie auf dem Server.

## Offen / ungeprüft
- Das Rohformat der echten API ist nach Dokumentation nachgebaut. `npm run probe` auf Lab02 liefert Echtdaten, danach Abgleich.
- Echte Auslieferung von Push und Kamera-Scan mit Handy prüfen; offizielle Datenquelle, bevor die App öffentlich läuft.
