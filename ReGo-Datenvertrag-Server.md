# Server-Ergänzung zum Datenvertrag
- `/api/state` liefert: schemaVersion, clock, connection (nur ok|error; offline setzt der Client), settings, theme, lines (nur benutzte), tours, incidents.
- Nicht vom Server: tickets, walletOffers, stations (Suche über /api/stations) – Tickets bleiben auf dem Gerät.
- Tour ohne Meldung: `view.kind = 'ok'`, `big = 'pünktlich'` (neu gegenüber dem Design – im Frontend als Sonderfall behandeln).
- Meldungs-IDs sind stabile Hashes; `distanceKm` nur mit lat/lon in der Anfrage.
