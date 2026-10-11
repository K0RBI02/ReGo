# Änderungen

## 0.1.25-beta01
- App-Icon: zwei sich kreuzende Linien mit Haltestellen auf Pastellgrün (Statusleiste: dasselbe Symbol einfarbig).

## 0.1.24-beta01
- App-Icon: Stempel-Schrift (raue Kanten) für "RE" und "GO" neben der Linie mit Haltestellen.

## 0.1.23-beta01
- Neues App-Icon: eine Linie mit drei Haltestellen auf hellgrünem Grund, "RE" oben links, "GO" unten rechts.

## 0.1.22-beta01
- Neues App-Icon: drei parallele Verkehrslinien als Bündel (grün = läuft, weiß = neutral, gelb = Störung), jede endet an einer Haltestelle. Ersetzt das "R".

## 0.1.21-beta01
- Neues App-Icon: ein "R" als Verkehrslinie mit Haltestellen (Home-Screen, Add-on, Browser-Tab, Statusleiste). Klar lesbar auch in sehr kleinen Größen.

## 0.1.20-beta01
- Neu: Add-on-Icon und Logo für Home Assistant.
- Neu: einfarbiges Statusleisten-Symbol für Benachrichtigungen (vorher ein weißes Quadrat).
- Push: Neue Meldungen ersetzen sich nicht mehr gegenseitig; der Abruf des Meldungstextes bricht nach 8 s ab, statt zu hängen.
- Push: Scheitert die Zustellung an den Push-Dienst, versucht ReGo es beim nächsten Durchlauf erneut, statt die Meldung zu verlieren.
- Protokoll zeigt jetzt jede Zustellung: `Push an fcm.googleapis.com: HTTP 201 angenommen` (oder den Fehler).

## 0.1.19-beta01
- Fix: Haltestellensuche findet Bahnhöfe wieder zuverlässig ("Kempten Hbf", "Lindau Hbf"): Ranking über alle Quellen, Wörter dürfen in beliebiger Reihenfolge stehen ("Kempten Hbf" findet "Kempten (Allgäu) Hbf"), fünf Vorschläge statt vier.
- Fix: Auf der Detailseite zeigt der Linien-Kreis oben die Linie der angezeigten Meldung (z. B. RE5), nicht mehr die erste Linie der Strecke (S3).
- Zugnummern-Zusatz "(Zug-Nr. …)" wird auch bei ÖBB-/DB-Daten entfernt.
- Protokoll: zeigt, wenn ReGo bei Strecken mit Österreich auf die ÖBB ausweicht.

## 0.1.18-beta01
- Neu: ganz Bayern über Bahnland Bayern (Rosenheim/Chiemgau, Allgäu, Berchtesgaden, Garmisch …) mit Echtzeitdaten, dazu Grenzorte in Österreich (z. B. Freilassing → Salzburg).
- Strecken zwischen MVV- und Bayern-Haltestellen funktionieren (die MVV-Haltestelle wird übersetzt).
- Strecken mit Österreich-Ende: wenn Bahnland Bayern nichts findet, versucht ReGo es über die ÖBB.
- Haltestellensuche sortiert besser: genauer Name und Bahnhöfe zuerst, doppelte Einträge aus MVV und Bayern werden zusammengelegt.

## 0.1.17-beta01
- Fix: Die Zahl am Warnsymbol stimmt jetzt mit der Liste unter Meldungen überein (vorher fehlte die oberste Meldung).
- Fix: Meldungen-Karten stapeln sich untereinander und werden nicht mehr ineinander gequetscht; lange Texte laufen komplett durch (auch im Detail).
- Fix: Zugnummern im Linien-Kreis ("RE5(Zug-Nr.79030)") werden zu "RE5"; längere Kürzel passen sich an.
- Fix: abgeschnittene Verbund-Hinweise ("… bis Frei") werden durch den ersten ganzen Satz ersetzt.
- Kürzere Strecken-Namen: "Freising, Freising" wird "Freising", gleicher Ort an beiden Enden wird einmal weggelassen.
- Bei Ersatzverkehr/Baustelle ohne Verspätung steht kein "+0 Min." mehr.

## 0.1.16-beta01
- Fix: ÖBB-Haltestellen ohne Standard-Nummer werden über die Koordinaten Österreich zugeordnet (richtige Beschriftung, Strecke läuft über die ÖBB).

## 0.1.15-beta01
- Fix: Haltestellensuche findet wieder österreichische Halte (wartet auf die ÖBB statt sie nach 0,6 s abzuschneiden; unvollständige Suchergebnisse werden nicht zwischengespeichert).
- Protokoll zeigt pro Suche, welche Quelle wie viele Treffer lieferte (`Suche "…": mvv 5, oebb 3`).

## 0.1.14-beta01
- Add-on kommt jetzt als fertiges Image aus GitHub (kein Bauen auf dem Pi mehr).
- Neu: Fahrplandaten vom MVV (Oberbayern, Alpenvorland), Bahn-Sperre umgangen.
- Grenzverkehr: deutsche MVV-Haltestellen werden für die ÖBB übersetzt; Strecken mit einem Ende in Österreich laufen über die ÖBB.
- Schnellerer Start der App (Zwischenspeicher zuerst) und schnellere Suche (gesperrte Quellen werden pausiert).
- Standard-Gerätename im Tailnet: `rego-beta01`.
