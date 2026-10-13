# ReGo als Home-Assistant-Add-on

Läuft rund um die Uhr auf dem Pi, der Laptop wird nicht mehr gebraucht. Die Daten (Strecken, Tickets, Push-Abos, VAPID-Schlüssel)
liegen pro Handy getrennt in `/data` des Add-ons und bleiben bei Updates erhalten.

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
- `contact`: E-Mail-Adresse für die Push-Kennung (VAPID-Subject), optional.
- `provider`: `library` (Standard), `transport-rest` oder `mock`.
- `ts_mode`: `off`, `serve` oder `funnel`. `ts_hostname`: Gerätename im Tailnet (Standard `rego`). `ts_authkey`: Auth-Key (nur zum ersten Anmelden).
- `fcm_key`: Firebase-Dienstkonto-Schlüssel (der komplette Inhalt der JSON-Datei) für Sofort-Push an die Android-App. Leer = die App fragt alle ~15 Minuten selbst nach. Der Push selbst ist leer, den Text holt die App vom Server.

## Android-App
Die App (APK) baut GitHub, siehe `deploy/ANDROID.md`. Sie steckt die Oberfläche selbst mit, die Daten kommen von diesem Add-on. Ändert sich nur der Server, genügt das Add-on-Update. Ändert sich das Aussehen, braucht es eine neue APK (kommt unter Releases als `app-v<Version>`).

## Daten und Sicherung
Alles liegt im `/data` des Add-ons: `profiles/` (je Gerät eine Datei mit Strecken und Einstellungen), `vapid.json` (Push-Schlüssel des Servers), `tailscale/` (Anmeldung). Eine Home-Assistant-Sicherung enthält das mit. Tickets liegen nie auf dem Server, sondern nur auf dem Handy (dort mit „Tickets sichern“ in eine Datei sichern).
Beschädigte Profildateien legt ReGo als `<ID>.json.corrupt-<Zeit>` zur Seite und löscht sie nach 30 Tagen.

## Wenn etwas hakt
- `http://<pi-ip>:8080/status` zeigt Version, Zustand der Datenquellen und die Zahl der Geräte (ohne persönliche Daten).
- Im Protokoll des Add-ons steht beim Start ein Netztest (bahn.de, MVV). Fehler der Datenquellen stehen dort ebenfalls.
- Sind die Fahrplandaten gestört, zeigt die App den letzten Stand (höchstens 30 Minuten alt) mit dem Hinweis „Keine aktuellen Daten“.
- Weitere Einstellungen (Umgebungsvariablen) stehen in der `README.md`.

