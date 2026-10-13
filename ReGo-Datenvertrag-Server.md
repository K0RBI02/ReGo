# Server-Ergänzung zum Datenvertrag
- `/api/state` liefert: schemaVersion, clock, connection (nur ok|error; offline setzt der Client), settings, theme, lines (nur benutzte), tours, incidents.
- Nicht vom Server: tickets, walletOffers, stations (Suche über /api/stations) – Tickets bleiben auf dem Gerät.
- Tour ohne Meldung: `view.kind = 'ok'`, `big = 'pünktlich'` (neu gegenüber dem Design – im Frontend als Sonderfall behandeln).
- Tour ohne Abfahrt (keine Direktverbindung, Ausfall, Quelle gestört): `view.kind = 'none'`, `big` = `Keine` | `Fällt aus` | `Keine Daten`, `rows = []`, `map` = Start und Ziel mit gepunkteter Linie. Das Frontend darf bei fehlender `view` selbst eine `none`-Ansicht zeigen, nie „pünktlich“.
- Meldungs-IDs sind stabile Hashes; `distanceKm` nur mit lat/lon in der Anfrage.
