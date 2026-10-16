# ReGo als Home-Assistant-Add-on

Läuft rund um die Uhr auf dem Pi, der Laptop wird nicht mehr gebraucht. Die Daten (Strecken, Einstellungen, Push-Kennung der App)
liegen pro Handy getrennt in `/data` des Add-ons und bleiben bei Updates erhalten. Tickets liegen nie auf dem Server.

## Installation
1. Home Assistant → Einstellungen → Add-ons → Add-on-Store → ⋮ → **Repositories** → `https://github.com/K0RBI02/ReGo` hinzufügen.
2. ReGo installieren, in den Optionen (siehe unten) Tailscale eintragen, starten, „Beim Booten starten“ an.
3. Test im Heimnetz: `http://<pi-ip>:8080/api/health`.
4. Updates: Wenn eine neue Version bereitsteht, erscheint bei ReGo der Button **Aktualisieren**. Nicht deinstallieren, sonst gehen Tailscale-Anmeldung und alle Strecken verloren.

## https über Tailscale (im Add-on eingebaut)
ReGo meldet sich als eigenes Gerät („rego“) im Tailnet an und bekommt eine https-Adresse `https://rego.<dein-tailnet>.ts.net`.
1. Im Tailscale-Admin (login.tailscale.com): DNS → **MagicDNS** und **HTTPS Certificates** aktivieren.
2. Settings → Keys → **Generate auth key** (einmalig nutzbar, nicht ephemeral). Den Schlüssel nur in die Add-on-Optionen eintragen.
3. Add-on-Optionen: `ts_authkey` = Schlüssel, `ts_mode` = `serve` (nur Geräte in deinem Tailnet) oder `funnel` (öffentlich, auch für Freunde ohne Tailscale), speichern, Add-on neu starten.
4. Im Protokoll steht die Adresse; zusätzlich zeigt der Tailscale-Admin das neue Gerät „rego“.
Funnel braucht in der Tailscale-ACL das Attribut „funnel“ (Admin → Access controls); in neuen Tailnets ist es meist schon gesetzt.
Nach der ersten Anmeldung bleibt der Zustand in `/data/tailscale`; der Auth-Key kann dann wieder entfernt werden.

## Optionen
- `invite_code`: Einladungscode für neue Geräte, optional (siehe unten). Leer = jeder darf ein Profil anlegen.
- `contact`: ohne Funktion (blieb aus der Browser-Zeit übrig, damit bestehende Einstellungen gültig bleiben). Kann leer bleiben.
- `provider`: `library` (Standard), `transport-rest` oder `mock`.
- `ts_mode`: `off`, `serve` oder `funnel`. `ts_hostname`: Gerätename im Tailnet (Standard `rego`). `ts_authkey`: Auth-Key (nur zum ersten Anmelden).
- `fcm_key`: Firebase-Dienstkonto-Schlüssel (der komplette Inhalt der JSON-Datei) für Sofort-Push an die Android-App. Leer = die App fragt alle ~15 Minuten selbst nach. Der Push selbst ist leer, den Text holt die App vom Server. Ob der Schlüssel geladen wurde, steht beim Start im Protokoll und auf der Statusseite (`/status`, „Sofort-Push“).

## Android-App
Die App (APK) baut GitHub, siehe `deploy/ANDROID.md`. Sie steckt die Oberfläche selbst mit, die Daten kommen von diesem Add-on. Ändert sich nur der Server, genügt das Add-on-Update. Ändert sich das Aussehen, braucht es eine neue APK (kommt unter Releases als `app-v<Version>`). Die Browser-Version (PWA) wird seit 0.6.0 nicht mehr gepflegt: Der Server liefert die Oberfläche zwar weiter aus, aber es gibt keinen Browser-Push und keine Installation über den Browser mehr.

## Strecken mit 1 Umstieg
Gibt es zwischen zwei Haltestellen keine Direktverbindung, bietet die App beim Anlegen „Mit 1 Umstieg suchen“ an (kein Schalter in den Einstellungen, keine Add-on-Option). Der Server fragt dafür die Fahrplanquelle nach Verbindungen mit höchstens einem Umstieg; für jede Abfahrt wählt ReGo Zubringer, Umstiegsbahnhof und Anschluss neu und fragt dazu die Anschlussfahrten ab dem Umstiegsbahnhof ab. Das sind pro Strecke mit Umstieg bis zu drei Abfragen statt einer (alle zwischengespeichert, wie sonst auch). Meldungen: „Anschluss wackelt“ und „Anschluss verpasst“ (Push immer, unabhängig von der Verspätungsschwelle). Fragt die Quelle gerade nicht, zeigt die Strecke den letzten Stand wie jede andere; fehlt nur die zweite Abfrage, gilt der Vorschlag der Quelle und ReGo meldet keinen Anschluss, den es nicht sicher beurteilen kann. Hat eine Strecke ohne Umstieg Ersatzverkehr, schaut der Server zusätzlich nach einer Verbindung mit einem Umstieg, die mindestens 5 Minuten früher ankommt, und die Meldung zeigt sie als „Schneller mit 1 Umstieg“ (nur dann eine zusätzliche Abfrage). Die Einzelheiten stehen in der `README.md` (Verhalten, API).

## Einladungscode und Begrenzung
Ist ReGo öffentlich erreichbar (`ts_mode: funnel`), trägst du bei `invite_code` ein Wort oder eine Zahlenfolge ein und startest das Add-on neu. Neue Geräte (frisch installierte App, „Neues Handy“) fragen dann einmal nach dem Code. Geräte, die der Server schon kennt, laufen ohne weiteres weiter, auch nach dem Einschalten. Falsche Codes werden gebremst (10 Versuche, danach einer pro Minute). Den Code kannst du jederzeit ändern oder wieder entfernen. Er liegt nur in den Add-on-Optionen, nicht im Repo.
Unabhängig vom Code begrenzt ReGo Anfragen je Adresse und je Gerät, die Haltestellensuche enger und neue Geräte auf 10 pro Stunde und Adresse. Zu viele Anfragen beantwortet der Server mit „429“ und einer Wartezeit; die Prüfadresse `/api/health` für den Watchdog bleibt frei. Im Protokoll erscheint dazu höchstens eine Zeile pro Minute. Über Tailscale zählt die echte Absenderadresse (aus `X-Forwarded-For`), nicht die des Tailscale-Dienstes.

## Daten und Sicherung
Alles liegt im `/data` des Add-ons: `profiles/` (je Gerät eine Datei mit Strecken und Einstellungen), `tailscale/` (Anmeldung). Eine `vapid.json` aus früheren Versionen wird nicht mehr gebraucht. Eine Home-Assistant-Sicherung enthält das mit. Tickets liegen nie auf dem Server, sondern nur auf dem Handy (dort mit „Tickets sichern“ in eine Datei sichern).
Beschädigte Profildateien legt ReGo als `<ID>.json.corrupt-<Zeit>` zur Seite und löscht sie nach 30 Tagen.

## Wenn etwas hakt
- `http://<pi-ip>:8080/status` zeigt Version, Zustand der Datenquellen, die Zahl der Geräte und Push-Abos und ob Sofort-Push an ist (ohne persönliche Daten).
- Im Protokoll des Add-ons steht beim Start ein Netztest (bahn.de, MVV). Fehler der Datenquellen stehen dort ebenfalls.
- Sind die Fahrplandaten gestört, zeigt die App den letzten Stand (höchstens 30 Minuten alt) mit dem Hinweis „Keine aktuellen Daten“.
- Hängt ReGo einmal, startet Home Assistant es selbst neu, wenn du bei ReGo unter „Info“ den Schalter **Watchdog** einschaltest (die Prüfadresse `/api/health` ist hinterlegt).
- In den Einstellungen der App (unter „Strecken“) schickt „Testmeldung“ eine Meldung an das Handy (Push-Meldungen müssen eingeschaltet sein). Die App sagt dazu, ob sie sofort (Firebase) oder erst bei der nächsten Abfrage (bis ca. 15 Minuten) kommt. Kommt sie trotz Firebase nur nach Minuten: auf `/status` steht, ob der Server einen Schlüssel hat („Sofort-Push: an/aus“) und wie viele Handys eine Firebase-Kennung gemeldet haben.
- Die App fragt nach einem Einladungscode? Dann ist `invite_code` gesetzt und das Gerät dem Server noch nicht bekannt (zum Beispiel nach „Profil löschen“ oder frischer Installation). Kommt die Meldung „Zu viele Anfragen“, hilft kurzes Warten.
- Weitere Einstellungen (Umgebungsvariablen) stehen in der `README.md`.

