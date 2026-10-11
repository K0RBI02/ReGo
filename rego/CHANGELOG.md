# Änderungen

## 0.1.15-beta01
- Fix: Haltestellensuche findet wieder österreichische Halte (wartet auf die ÖBB statt sie nach 0,6 s abzuschneiden; unvollständige Suchergebnisse werden nicht zwischengespeichert).
- Protokoll zeigt pro Suche, welche Quelle wie viele Treffer lieferte (`Suche "…": mvv 5, oebb 3`).

## 0.1.14-beta01
- Add-on kommt jetzt als fertiges Image aus GitHub (kein Bauen auf dem Pi mehr).
- Neu: Fahrplandaten vom MVV (Oberbayern, Alpenvorland), Bahn-Sperre umgangen.
- Grenzverkehr: deutsche MVV-Haltestellen werden für die ÖBB übersetzt; Strecken mit einem Ende in Österreich laufen über die ÖBB.
- Schnellerer Start der App (Zwischenspeicher zuerst) und schnellere Suche (gesperrte Quellen werden pausiert).
- Standard-Gerätename im Tailnet: `rego-beta01`.
