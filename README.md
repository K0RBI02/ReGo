# ReGo – Backend

Node.js ≥ 20. Holt Fahrplandaten aus mehreren Quellen: regionale Verbünde (MVV und Bahnland Bayern per EFA), ÖBB (Bibliothek `hafas-client`, Ausweichquelle transport.rest) und Deutsche Bahn (über den Dienst transport.rest, weil die Bahn die direkte Bibliothek sperrt) und liefert dem Frontend genau die Struktur aus dem Datenvertrag (`window.REGO`).

## App (Oberfläche und Android)
Die Oberfläche steckt in einer echten Android-App (`android/`, gebaut von GitHub, siehe `deploy/ANDROID.md`). Seit 0.6.0 gibt es nur noch die App: keine Browser-Installation, kein Service Worker, kein Browser-Push. `public/` ist die gemeinsame Oberfläche: Die Screens (`public/screens/*.dc.html`) führt `public/js/dc-lite.js` aus, `public/js/rego-live.js` füllt sie mit den Backend-Daten. Das Backend liefert sie weiter mit aus, nach `npm start` einfach `http://127.0.0.1:8080/` öffnen. Das ist zum Ausprobieren und für die Tests gedacht, nicht als Ersatz für die App.
- Offline: letzter Stand bleibt im Gerät, Banner „Offline-Modus | Stand: hh:mm“.
- Tickets und Geräte-ID liegen nur im Gerät (localStorage).
- Schrift: Instrument Sans (SIL Open Font License) liegt in `public/fonts/` und wird von dort geladen, nichts von Drittanbietern. Schnitte: Regular für 400/500, Bold für 600 bis 800.
- Ticket-Safe: Barcode per Kamera (nur https) oder aus Foto/Screenshot; gespeichert wird der Zuschnitt des Codes als Bild, nur lokal. Wallet-Apps lassen sich aus dem Browser nicht auslesen.
- Push: nur für die Android-App. Mit Firebase (`REGO_FCM_KEY`) kommt ein leerer Anstoß sofort, den Text holt die App beim Backend; ohne Firebase fragt die App etwa alle 15 Minuten nach. Meldungsarten: Verspätung, Ersatzverkehr, Baustelle, Ausfall und Gleiswechsel (in Android je ein eigener Benachrichtigungskanal). Prüfintervall `REGO_NOTIFY_SEC` (60). Nachtruhe 23–4 Uhr. In den Einstellungen (unter „Strecken“) gibt es eine Testmeldung; `/status` zeigt, ob der Server einen Firebase-Schlüssel hat (Sofort-Push an/aus).

## Als Home-Assistant-Add-on
In Home Assistant: Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories → `https://github.com/K0RBI02/ReGo` hinzufügen. Das fertige Image baut GitHub Actions (`.github/workflows/build.yml`), der Pi lädt es nur. Neue Version = `version` in `rego/config.yaml` erhöhen und pushen. Mehr in `rego/DOCS.md`.

## Handy-Installation
Siehe `deploy/ANDROID.md` (die App als APK von GitHub). Autostart ohne Home Assistant: `deploy/rego.service`.

## Datenschutz
Siehe [DATENSCHUTZ.md](DATENSCHUTZ.md). Kurz: keine Konten, keine Tickets auf dem Server, Profile werden nach 180 Tagen ohne Nutzung gelöscht (`REGO_PROFILE_DAYS`).

## Hinweis zu den Fahrplanquellen
ReGo ist ein privates Hobbyprojekt. Die Fahrplandaten kommen aus öffentlich erreichbaren, aber **inoffiziellen** Schnittstellen: MVV und Bahnland Bayern (MoBY) über deren EFA-Dienste, die ÖBB über die Bibliothek `hafas-client` und die Deutsche Bahn über den Dienst transport.rest. Dafür gibt es keine Zusage und keine Gewähr; eine Quelle kann sich ändern, langsamer werden oder gesperrt werden. ReGo bleibt deshalb bewusst klein (wenige Geräte, wenige Abfragen, dazu die eingebaute Begrenzung und optional ein Einladungscode). Würde es größer, kämen die Daten über die offiziellen Schnittstellen der Verkehrsunternehmen und Verbünde, die dafür beantragt werden müssten.

## Tests
`npm test` (Server und Fachlogik, `node --test`) und `node scripts/ui-smoke.mjs` (Bildschirmtest mit Beispieldaten, braucht Playwright: `npm i --no-save playwright && npx playwright install chromium`). Beides läuft vor jedem Build auf GitHub (`.github/workflows/build.yml`); schlägt ein Test fehl, wird kein Image gebaut. Der Bildschirmtest prüft alle Seiten auf Fehler und bedient die wichtigsten Abläufe (Strecke anlegen/ändern/entfernen, Rückgängig, Code übernehmen, Ticket sichern, kleines Handy, Dunkelmodus, mehrere Meldungen je Strecke).

## Starten
    npm run demo      # Beispieldaten, ohne Internet
    npm start         # echte Daten (transport.rest)
    npm test
    npm run probe     # echte Antworten abholen -> fixtures/real/ (bitte auf Lab02 ausführen)

Umgebungsvariablen (alle optional):
- Betrieb: `PORT` (8080), `HOST` (127.0.0.1; fürs LAN `0.0.0.0`), `REGO_DATA`, `REGO_PUBLIC`, `REGO_VERBOSE` (`1` = Fehler der Datenquellen ins Protokoll), `REGO_CORS`.
- Datenquellen: `REGO_PROVIDER` (`library` Standard | `transport-rest` | `mock`), `REGO_DB_URL`, `REGO_OEBB_URL`, `REGO_MVV_URL`, `REGO_MOBY_URL`, `REGO_UA`, `REGO_TIMEOUT_MS` (8000), `REGO_RETRIES` (2), `REGO_TOUR_DEADLINE_MS` (12000: so lange wartet eine Strecke höchstens auf ihre Daten).
- Push: `REGO_FCM_KEY` (Firebase-Dienstkonto als JSON, alternativ Datei `fcm.json` im Datenordner), `REGO_NOTIFY_SEC` (60), `REGO_NOTIFY_IDLE_DAYS` (21: App-Geräte ohne Lebenszeichen werden nicht mehr geprüft).
- Zugang: `REGO_INVITE` (Einladungscode; gesetzt = neue Geräte brauchen ihn, bekannte laufen weiter; leer = offen). Die Begrenzung der Anfragen ist fest eingebaut (siehe `server/guard.mjs`).
- Aufräumen: `REGO_PROFILE_DAYS` (180), `REGO_MAX_PROFILES` (2000).

## API
Alle Pfade außer `health` und `status` brauchen den Header `X-Device: <zufällige ID, 16–64 Zeichen>` (anonym, vom Frontend einmal erzeugt). Ist ein Einladungscode gesetzt, braucht ein dem Server noch unbekanntes Gerät außerdem `X-Invite: <Code, URL-codiert>`; fehlt er oder stimmt er nicht, antwortet der Server mit 403 und `{invite: true, wrong: true|false}`. Zu viele Anfragen ergeben 429 mit `Retry-After` (Sekunden).

| Pfad | Zweck |
|---|---|
| GET /api/health | Lebenszeichen |
| GET /api/status | Version, Quellenzustand, Anzahl Geräte und Push-Abos, `instantPush` (Firebase-Schlüssel vorhanden), `pushWithToken` (Abos mit Firebase-Kennung); keine persönlichen Daten, Seite `/status` |
| GET /api/stations?q= | Haltestellensuche (braucht die Geräte-ID) |
| GET /api/state?lat=&lon= | kompletter Zustand (tours, incidents, lines, connection, settings, clock) |
| POST /api/tours | `{from:{id,name}, to:{id,name}, schedule?, roundTrip?, returnAfter?}`; 422, wenn die Quelle sicher keine Direktverbindung kennt (antwortet sie nicht, wird angelegt) |
| PATCH /api/tours/:id | `active`, `name`, `schedule` |
| DELETE /api/tours/:id | Strecke löschen |
| PUT /api/settings | `{pushThresholdMin: 3｜5｜10, pushWindow: true｜false}` (Push nur ±20 Min. um die Abfahrt) |
| GET/PUT/DELETE /api/profile | Profil lesen / ersetzen (Rückgängig) / löschen |
| PUT /api/push/native | Android-App: Push einschalten, optional `{token}` (Firebase-Kennung) |
| DELETE /api/push | Push ausschalten (Gerät abmelden) |
| POST /api/push/test | schickt eine Test-Meldung an das Gerät (409: Push nicht eingeschaltet, 502: Zustellung gescheitert) |
| GET /api/notifications | holt und leert die wartenden Meldungen (ruft die App nach einem Push oder alle ~15 Min.) |
| POST /api/transfer | „Neues Handy“: erzeugt einen Einmal-Code (6 Zeichen, 10 Min. gültig) |
| POST /api/transfer/claim | `{code}`: übernimmt Strecken und Einstellungen vom alten Handy (ersetzt die vorhandenen) |

## Verhalten
- Ausfall der Quelle: letzter Stand bleibt, `connection.status = 'error'`, `lastSync` zeigt dessen Zeit. „offline“ setzt das Frontend selbst.
- Meldungen: Ersatzverkehr/Baustelle aus den Hinweisen der Bahn (Stichwörter in `server/domain/classify.mjs`), Verspätung ab `incidentMinDelay` (3 Min.), Ausfall (Fahrten der nächsten 3 Stunden, eine Meldung je Linie) und Gleiswechsel (Abfahrt in den nächsten 45 Min., leise). Ereignisse bleiben bis `validity.until`, Verspätungen noch `delayGraceMin` länger. Pro Strecke eine Detailseite mit allen ihren Meldungen.
- Nur Direktverbindungen: Eine Strecke, zu der die Quelle sicher keine Fahrt ohne Umstieg kennt, lässt sich nicht anlegen. Strecken mit einem Umstieg sind als eigenes Projekt vorgemerkt.
- Störung der Quelle: je Strecke höchstens 12 s warten, danach der letzte Stand (höchstens 30 Min. alt, `stale`). Nach einem Fehler wird die Quelle 10, 20, 40, 60 s in Ruhe gelassen. Push pausiert nur für die betroffene Strecke.
- Tickets liegen nie auf dem Server.

## Offen / ungeprüft
- Das Rohformat der echten API ist nach Dokumentation nachgebaut. `npm run probe` auf Lab02 liefert Echtdaten, danach Abgleich.
- Echte Auslieferung von Push (Firebase-Sofort-Push, Ausfall- und Gleiswechsel-Meldungen) und Kamera-Scan mit dem Handy prüfen; offizielle Datenquellen, bevor die App über den privaten Rahmen hinaus wächst.
