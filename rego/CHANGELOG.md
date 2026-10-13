# Änderungen

## 0.4.3
- Meldungen: jede Meldung ist wieder eine eigene Karte (Übersicht), alle führen auf die gemeinsame Seite ihrer Strecke.

## 0.4.2
- Abfahrtsliste: bereits abgefahrene Fahrten werden nicht mehr gezeigt, Reihenfolge nach tatsächlicher Abfahrt, Fahrten von morgen sind als „morgen“ markiert.
- Detailseite: österreichische Strecken verlinken die ÖBB-App statt DB Navigator, grenzüberschreitende nur den Ticket-Hinweis.
- Namen wie „München, München Hbf“ werden zu „München Hbf“ gekürzt.

## 0.4.1
- Eine Detailseite je Strecke: Baustelle, Ersatzverkehr und Verspätung stehen zusammen auf einer Seite, in Meldungen eine Karte je Strecke.
- Hauptbildschirm: die nächsten drei Fahrten der nächstgelegenen Strecke sind antippbar und öffnen eine eigene Detailseite (Verspätung, Gleis, Karte, danach folgende Fahrt).
- Sortierung nach Standort: Entfernung zuerst (Tageszeit nur bei gleicher Nähe), Entfernung steht unter der Strecke. Die Android-App fragt beim Start nach der Standortfreigabe, der Browser einmal ab zwei Strecken.

## 0.4.0
- Neues Handy: unter Strecken Code erzeugen und auf dem neuen Gerät eingeben, Strecken und Einstellungen werden kopiert (Code 10 Min. gültig, einmal nutzbar).
- Rückmeldung: Link öffnet ein vorbefülltes GitHub-Formular.

## 0.3.2
- Standardadresse der App und des Tailnet-Namens: `rego` (https://rego.tail2a5f03.ts.net).

## 0.3.1
- Sofort-Push per Firebase für die Android-App (Server sendet nur einen leeren Anstoß, Text holt die App selbst). Neue Add-on-Option `fcm_key`.

## 0.3.0
- Echte native Android-App (statt Browser-Hülle): Helligkeit beim Ticket, Download-Ordner, eigener Meldungsdienst.
- Server erlaubt die App-Herkunft (CORS) und kennt nativen Push (`PUT /api/push/native`).

## 0.2.1
- Android-App (APK) als Hülle um ReGo: Projekt unter `android/`, GitHub baut sie (Workflow "Android-App (APK) bauen"), Anleitung in `deploy/ANDROID.md`.
- Server liefert `/.well-known/assetlinks.json` aus, damit die App ohne Browserleiste läuft.

## 0.2.0
Erste Mini-Version nach der Beta.
- Strecken lassen sich ändern (Zeit und Wochentage) über "Ändern" an der Strecke.
- Push nur rund um die Abfahrt: neuer Schalter unter den Push-Einstellungen, ±20 Minuten um die Zeit der Strecke an deren Tagen.
- Tickets: Meldung, wenn der Speicher voll ist, "Tickets sichern" und "Tickets wiederherstellen" als Datei, abgelaufene Tickets sind markiert.
- Detailseite: "geplant 00:18" statt durchgestrichener Zeit, "Nächste Verbindung" statt "Alternative", Link "Im DB Navigator ansehen".
- Offline-Balken kurz: "Offline-Modus | Stand: hh:mm".
- Beta-Hinweis beim Start nur noch beim allerersten Mal.
- App-Symbol: Kurzbefehle "Ticket anzeigen" und "Meldungen" (langes Drücken).
- Statusseite unter `/status`.
- Sicherheit: Haltestellensuche braucht die Geräte-ID, Sicherheits-Header (CSP u. a.), Profile ohne Nutzung seit 180 Tagen werden gelöscht, DATENSCHUTZ.md.
- Aufgeräumt: nicht mehr genutzte Bibliothek db-vendo-client entfernt, Schriftdatei-Anfrage (404) entfernt, Bildschirmtest läuft vor jedem Build.

## 0.1.35-beta
- "Hinweg" und "Rückweg" stehen nur noch bei echten Hin-und-zurück-Paaren, nicht mehr nach Uhrzeit geraten.
- Meldungen: Dieselbe Störung auf Hin- und Rückweg erscheint als eine Karte ("beide Richtungen"). "nach Nähe sortiert" steht nur noch, wenn der Standort bekannt ist.
- Server: kaputte Adresse gibt 400 statt 500, zu große Anfrage 413 mit Text, Test-Push ohne Abo 409 statt "ok".
- Kontaktzeile unter Strecken verlinkt auf die GitHub-Meldungen. Standard-Gerätename im Tailnet: `rego-beta-app` (gilt nur für neue Installationen).

## 0.1.34-beta
- Leere stumme "ReGo"-Meldungen behoben: Das war das kurze Platzhalter-Signal beim Entfernen. Es steht jetzt als "Aktualisiert" nur 2,5 s da und wird danach geschlossen.
- Ist ein Vorfall vorbei, wird die Meldung kurz zu "<Linie> · behoben" (stumm) und nach 6 s entfernt.
- Kommt ein Push ohne neuen Inhalt an, erscheint nicht mehr die allgemeine Meldung "Neue Meldung auf deiner Strecke".

## 0.1.33-beta
- Benachrichtigungen bleiben aktuell: Ändert sich die Verspätung (z. B. +6 → +9 Min.), wird die bestehende Meldung leise aktualisiert statt eine neue zu zeigen.
- Ist die Verspätung weg (oder der Zug abgefahren), verschwindet die Meldung automatisch aus der Leiste (nach etwa zwei Minuten ohne den Vorfall).

## 0.1.32-beta
- Ticket-Screen: Unten ist Platz für den Button "Ticket hinzufügen", das letzte Ticket lässt sich vollständig hochscrollen.
- Standort: wird bei jedem Öffnen der App neu geholt (20 s Zeit statt 8 s) und für 12 Stunden gemerkt, damit die nächste Strecke zuerst kommt.

## 0.1.31-beta
- Offline-Anzeige nennt jetzt den Grund (z. B. "Offline-Modus · Server 500", "Zeitüberschreitung" oder "keine Verbindung zum Server"). Abrufe brechen nach 30 s ab.
- Log: Fehlerantworten der API (HTTP ab 400) stehen jetzt im Protokoll.

## 0.1.30-beta
- Lindau Hbf: Der Bahnhof heißt bei den Quellen "Lindau (Bodensee) Insel" bzw. "Lindau Inselbahnhof" und war über "Lindau Hbf" nicht zu finden. Die Suche zeigt ihn jetzt bei "Lindau Hbf / Hauptbahnhof / Bahnhof" ganz oben als "Lindau (Bodensee) Hbf".

## 0.1.29-beta
- Bahn-Suche (ÖBB/DB-Bibliothek) liefert bis zu 12 statt 8 Treffer, damit auch Bahnhöfe weiter hinten (z. B. Lindau Hbf) nicht abgeschnitten werden.
- Neues Prüfskript scripts/probe-lindau.mjs (zeigt, wie Lindau Hbf bei ÖBB und MoBY heißt).

## 0.1.28-beta
- Ticket-Screen lässt sich scrollen (Karte und weitere Tickets), der Button "Ticket hinzufügen" bleibt unten stehen.
- Anzeige "Beta" statt "Beta01".
- Log: bei jeder Suche stehen die ersten Treffer jeder Quelle dabei (zur Fehlersuche).

## 0.1.27-beta
- ÖBB/DB entlastet: Die Suche fragt die Bahn-Server nur noch ab 4 Zeichen und nur, wenn der Verbund den Bahnhof nicht genau kennt (vorher bei jedem Tastendruck, das hat die ÖBB in Timeouts getrieben). Eingabe wartet 450 ms.
- IPv4 zuerst (bahn.de hängt hier per IPv6) – das sollte die ÖBB-Timeouts beenden.
- Grenzstrecken: "Freilassing (Obb), Freilassing" wird bei der ÖBB jetzt über einfachere Schreibweisen gefunden.

## 0.1.26-beta
- Suche: "Lindau Hb" findet jetzt Lindau Hbf (bei mehreren Wörtern wird zusätzlich nach dem ersten Wort gesucht, Bahnhöfe mit passendem Wortanfang kommen nach vorn).
- Versionsnummer heißt jetzt einfach "-beta".

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
