# Änderungen

## 0.6.1 – Einstellungen, Hauptbildschirm, Push-Diagnose

**Strecken**
- **Einstellungen:** Push-Meldungen mit Testmeldung, „Neues Handy?“, Rückmeldung und die Versionszeile stehen nicht mehr in der Liste, sondern in einem Blatt, das von unten hochfährt. Geöffnet wird es mit dem Satz „Push, neues Handy und Rückmeldung findest du in den Einstellungen →“ unter „Meine Strecken“. Die Zurück-Taste, ein Tipp auf den abgedunkelten Rest oder Esc schließen es wieder; die App bleibt dabei, wo sie ist. Die Liste bleibt dadurch auch mit vielen Strecken übersichtlich.

**Hauptbildschirm und Detailseite**
- **Häkchen rutschte nach unten:** Bei längeren Wörtern wie „pünktlich“ sprang das Häkchen auf dem Hauptbildschirm unter das Wort. Die große Zeile passt ihre Größe jetzt an die Breite an (zwischen 34 und 58 px), das Häkchen bleibt rechts daneben, auch auf kleinen Handys. Gleiches auf der Detailseite.
- **„Danach“ und „Nächster Zug“ sind antippbar:** Die Karte unten auf der Detailseite führt zur Seite dieser Abfahrt. Das gilt jetzt auch, wenn du die erste Abfahrt ansiehst und alles pünktlich ist (Karte „Danach“ mit „pünktlich“); bisher stand dort gar nichts oder eine Karte ohne Wirkung. Eine Detailseite gibt es wie bisher für die ersten drei Abfahrten der Liste; ist die nächste Fahrt die vierte, bleibt die Karte eine reine Anzeige.
- **Android-Leisten:** Auf der Detailseite hat die Statusleiste oben die Farbe der Karte (grün, grau oder schwarz bei „offline“) und die Navigationsleiste unten die des Blatts. Vorher blieb über der Karte ein weißer Streifen. Beim Vollbild-Hinweis „Sorry!“ (gar keine Daten) haben beide Leisten die rosa Farbe des Hinweises.

**Push-Diagnose**
- **Statusseite:** `/status` zeigt jetzt, ob der Server einen Firebase-Schlüssel hat („Sofort-Push: an/aus“) und bei den Push-Abos, wie viele Handys eine Firebase-Kennung gemeldet haben. Beides sind nur Zahlen. Damit lässt sich ohne Raten erkennen, warum Meldungen nur alle ~15 Minuten kommen.
- **Protokoll:** Beim Start schreibt der Server, ob der Schlüssel (Add-on-Option `fcm_key`) geladen wurde. Ein fehlender oder unlesbarer Schlüssel fiel bisher nirgends auf.
- Die Fehlermeldung der Testmeldung nennt jetzt den Weg „Strecken → Einstellungen“.

**Neu bauen**
- Das Aussehen und die App haben sich geändert: neue APK (`app-v0.6.1`) installieren. Der Server hat sich ebenfalls geändert: Add-on aktualisieren.

## 0.6.0 – Ausfälle, Gleiswechsel, Einladungscode, nur noch die App

**Neue Meldungen**
- **Ausfall:** Fällt eine Fahrt auf deiner Strecke in den nächsten 3 Stunden aus, gibt es jetzt eine eigene Meldung „Ausfall“. Vorher wurde das verschwiegen, die Strecke zeigte einfach den nächsten Zug. Mehrere ausfallende Fahrten derselben Linie stehen in einer Meldung.
- **Gleiswechsel:** Fährt ein Zug in den nächsten 45 Minuten von einem anderen Gleis ab, kommt eine eigene, leise Meldung („Gleis 3 statt Gleis 2“). Auch wenn er pünktlich ist.
- **Testmeldung:** Unter „Strecken“ schickt ein Knopf eine Testmeldung an dein Handy, damit du siehst, ob Push ankommt. Kommt sie sofort (Firebase) oder erst bei der nächsten Abfrage (bis ca. 15 Minuten), sagt die App es dazu.
- **Benachrichtigungskanäle (Android):** „Verspätungen“, „Ausfälle und Ersatzverkehr“, „Baustellen“ und „Gleiswechsel“ sind eigene Kanäle. In den Android-Einstellungen von ReGo lässt sich jeder einzeln lauter, leiser oder ausschalten. Der bisherige Sammelkanal „Meldungen“ wird beim ersten Abholen entfernt; eigene Einstellungen dazu gehen dabei verloren.
- **„Behoben“:** Ist eine Verspätung, ein Ersatzverkehr oder eine Baustelle vorbei und steht die Meldung noch in der Leiste, wird sie kurz auf „… behoben“ umgeschrieben (leise) und verschwindet nach ein paar Sekunden. Ausfälle und Gleiswechsel verschwinden einfach. Hast du die Meldung schon weggewischt, passiert nichts.

**Strecken**
- **Strecke ohne Direktverbindung:** Sie lässt sich nicht mehr anlegen. Das Formular sagt „Zwischen X und Y habe ich keine Direktverbindung gefunden. ReGo zeigt nur Fahrten ohne Umstieg.“ Antwortet die Fahrplanquelle gerade nicht, wird die Strecke trotzdem angelegt (ReGo rät nicht). Gleiches gilt beim Hin- und Rückweg: beide Richtungen werden geprüft.
- **Versionszeile** unter „Strecken“: App- und Serverversion, dazu Links auf den Datenschutz-Text und das Projekt auf GitHub.
- Bestehende Strecken ohne Direktverbindung bleiben, wie sie sind (sie zeigen weiter „Keine“) und lassen sich löschen.

**Betrieb und Sicherheit**
- **Begrenzung:** Der Server begrenzt Anfragen je Adresse (200 auf einmal, danach 3 pro Sekunde) und je Gerät (60, danach 1 pro Sekunde), die Haltestellensuche enger (20, danach 1 alle 2 Sekunden) und neue Geräte je Adresse auf 10 pro Stunde. Darüber antwortet er mit „429“ und der Wartezeit (`Retry-After`). `/api/health` für den Watchdog bleibt frei, im Protokoll steht pro Minute höchstens eine Zeile dazu. Hinter Tailscale zählt die echte Absenderadresse aus `X-Forwarded-For`.
- **Einladungscode (optional):** Neue Add-on-Option `invite_code`. Ist sie gesetzt, brauchen neue Geräte den Code; die App zeigt dann eine Eingabemaske. Geräte, die der Server schon kennt, laufen ohne weiteres weiter. Falsche Codes werden gebremst (10 Versuche, danach einer pro Minute). Leer lassen = offen wie bisher.
- **Hinweis zu den Fahrplanquellen:** README und Datenschutz sagen jetzt offen, dass ReGo inoffizielle bzw. öffentliche Schnittstellen nutzt (MVV, MoBY, ÖBB, transport.rest), ohne Gewähr, und dass es für einen größeren Betrieb die offiziellen Schnittstellen der Verkehrsunternehmen bräuchte.

**Nur noch die App**
- Die Browser-Version wird nicht mehr gepflegt. Entfernt: Service Worker, Web-Manifest, Browser-Push (und damit die VAPID-Schlüssel samt `vapid.json`), die PWA-Icons. Der Server liefert die Oberfläche weiter aus (zum Ausprobieren), unterstützt wird die Android-App. Push läuft nur noch nativ: Firebase-Anstoß oder Abfrage alle ~15 Minuten.
- `PUT /api/push` und `GET /api/push/key` gibt es nicht mehr. Alte Browser-Abos in bestehenden Profilen werden übergangen (sie liefern nichts mehr aus).
- Die Add-on-Option `contact` hat keine Funktion mehr und bleibt nur, damit bestehende Einstellungen gültig bleiben.

**Android-App**
- Nur noch Hochformat.
- Feste Textgröße: Die App folgt der Android-Schriftgröße nicht mehr, weil sich dabei Teile der Oberfläche verschoben.
- Kurzbefehle am App-Symbol (lange drücken): „Ticket anzeigen“, „Meldungen“, „Neue Strecke“.
- Themed Icon für Android 13 und neuer.

**Aussehen**
- Weitere Strecken (nicht die nächste) zeigen ihren Zustand als weiße Karte mit Symbol statt nur als Text.
- Linienbeschriftung in der Karte höchstens 12 px.
- Bei Ersatzverkehr und Baustelle steht das Datum nicht mehr doppelt.
- Statuskarte: Das Symbol schrumpft bei langem Text nicht mehr. Meldungskarte neu angeordnet.
- Sehr schmale Handys (320 px): Abfahrtszeile enger, „pünktlich“ berührt die Gleisangabe nicht mehr, Code-Eingabe bricht um.
- Schlägt das Anlegen der ersten Strecke fehl, steht der Grund auf dem Startbildschirm, nicht nur kurz als Hinweis.

## 0.5.1 – ehrlich bei fehlenden Abfahrten
- **Strecke ohne Abfahrt:** Gab es für eine Strecke keine Direktverbindung (oder gerade keine Daten), stand auf dem Hauptbildschirm trotzdem „Alles pünktlich“, die Strecke fehlte in der Liste, und die Detailseite sagte „Beendet“. Jetzt steht dort ehrlich „Nächste Abfahrt: Keine“ mit dem Grund (keine Direktverbindung gefunden, Fahrten fallen aus, Quelle antwortet nicht). Die Strecke bleibt in der Liste, die Detailseite zeigt Start und Ziel, und unter „Strecken“ steht ein kurzer Hinweis.
- Eine ausgeschaltete Strecke zeigt auf der Detailseite „Pausiert“ statt „Beendet“.
- **Schrift:** Instrument Sans (SIL Open Font License) ist jetzt in der App und im Add-on enthalten. Vorher fiel die App auf die Systemschrift zurück, weil die Schriftdatei nie mitgeliefert wurde. Die Schrift wird eine Woche zwischengespeichert.
- Weitere Meldungen einer Strecke: Überschrift mit der Verspätung rechts oben, Text der Meldung und darunter je eine kurze Zeile („ab 01:12 (geplant 01:00)“, „an 02:30“, „Nächster Zug: …“) statt einer langen, umbrechenden Zeile.
- Detailseite: Bei Strecken ohne Linie gibt es keinen leeren grauen Punkt mehr.
- „Rückmeldung senden“ unter „Strecken“: der ganze Satz ist antippbar (größere Fläche).
- Add-on: Die Adresse für den Watchdog ist hinterlegt. Schaltest du in Home Assistant bei ReGo unter „Info“ den Schalter „Watchdog“ ein, startet Home Assistant ReGo bei einem Hänger selbst neu. Die Kennung gegenüber den Fahrplan-Diensten nennt jetzt die Projektadresse.
- Aufgeräumt: die Datei für die frühere Browser-Variante der App (`assetlinks.json`) ist entfernt.

## 0.5.0 – große Fehlersuche
Die ganze App wurde auf Fehler durchgesehen. Das Wichtigste:

**Meldungen und Push**
- Der Push-Titel stimmt jetzt auch bei Linien mit Leerzeichen („RE 5 +8 Min.“ statt nur „RE“), ebenso die „behoben“-Meldung im Browser.
- Derselbe verspätete Zug an einem anderen Tag wird wieder gemeldet; lange Baustellen werden nicht mehr alle drei Tage neu gemeldet.
- Fällt die Datenquelle bei einer Strecke aus, pausieren nur die Meldungen dieser Strecke. Die anderen laufen weiter.
- App-Geräte, von denen 21 Tage nichts kam (App gelöscht), werden nicht mehr geprüft.

**Server**
- Ungültige Anfragen (kein JSON-Objekt) ergeben „400“ statt eines Serverfehlers.
- Eine Strecke, die doppelt gesendet wird (doppelt getippt), wird nur einmal angelegt.
- „Rückgängig“ behält die Koordinaten der Haltestellen und überschreibt keine Einstellungen.
- Eine beschädigte Profildatei sperrt das Gerät nicht mehr, sie wird zur Seite gelegt.
- Bei Störung einer Datenquelle wartet die App höchstens 12 Sekunden je Strecke, die Quelle wird danach kurz in Ruhe gelassen, und alte Fahrten werden höchstens 30 Minuten lang gezeigt.
- Obergrenzen gegen Missbrauch: Zwischenspeicher, offene Umzugscodes (500), Anzahl Profile (2000). Die öffentliche Statusseite wird 30 Sekunden zwischengespeichert.
- Ein vergessener Fehler in einem Hintergrundvorgang beendet das Backend nicht mehr.

**Oberfläche**
- Eine neu angelegte Strecke ging manchmal unter, wenn gleichzeitig aktualisiert wurde. Doppeltes Tippen auf „Speichern“ legte sie doppelt an. Beides behoben (der Knopf zeigt „Speichert …“).
- Schlägt Speichern, Entfernen, Rückgängig oder Umschalten fehl, springt die Anzeige zurück, statt etwas Falsches zu zeigen.
- „Neues Handy“: Vor dem Ersetzen vorhandener Strecken fragt die App nach.
- Neuer Schalter „Push-Meldungen“ unter Strecken (an/aus). Die Schwelle (3/5/10 Min.) ändert nur noch die Schwelle.
- Streckenseite: Die angetippte Meldung steht oben, die Zahl am Meldungs-Knopf zählt wie die Liste, eine nicht mehr vorhandene Meldung zeigt „Beendet“ (statt einer fremden Strecke), die Karte passt auf schmale Handys, Linienbeschriftungen liegen nicht mehr auf der Alternativ-Linie.
- Dunkelmodus: Die Karte „Neues Handy?“ ist lesbar.
- Große Schrift: weniger Überlappungen bei Abfahrtsliste und Statuskarte. Onboarding lässt sich auf kleinen Bildschirmen scrollen.
- Ticket: Der Bildschirm bleibt auch nach dem Zurückkommen in die App an (Browser). Fehlt das Code-Bild, steht dort ein ehrlicher Hinweis statt eines erfundenen Zufallscodes.
- Offline wird kein Stand mehr gezeigt, der älter als 6 Stunden ist. Beim Start kein grünes Aufblitzen mehr, und schnelles Navigieren überschreibt keine neuere Seite.

**Android-App**
- Farben von Status- und Navigationsleiste werden richtig übernommen, der Dunkelmodus folgt dem Handy.
- Stürzt die Webansicht ab (zu wenig Speicher), erholt sich die App, statt sich zu schließen. Beim Drehen oder Moduswechsel bleibt der Stand erhalten.
- Für die Sortierung nach Nähe reicht der ungefähre Standort.

**Entwicklung**
- 14 neue Server-Tests. Der Bildschirmtest prüft jetzt zusätzlich Doppeltippen, Rückgängig, Code übernehmen, kleines Handy, Dunkelmodus und mehrere Meldungen je Strecke. Er läuft wieder vor jedem Build (war seit 0.3.0 versehentlich aus dem Ablauf gefallen).

## 0.4.4
- Beim Scrollen läuft der Inhalt oben weich aus (Hauptbildschirm, Meldungen, Strecken) statt hart unter der Kopfzeile zu verschwinden.

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
