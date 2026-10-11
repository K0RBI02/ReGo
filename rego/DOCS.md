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
