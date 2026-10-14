# Datenschutz

ReGo ist ein privates Hobbyprojekt in der Beta. Diese Seite sagt, was gespeichert wird und wohin Daten gehen. Es gibt keine Konten, keine Werbung und keine Analyse, und die App lädt keine Skripte, Schriften oder Bilder von Drittanbietern.

**Auf dem Server (dein Home-Assistant-Add-on)**
- Je Gerät eine anonyme Zufalls-ID, deine Strecken (Start, Ziel, Tage, Zeit), die Einstellungen und der Zeitpunkt, wann sich das Gerät zuletzt gemeldet hat (nur zum Aufräumen).
- Wenn du Push einschaltest: die Firebase-Kennung des Geräts (nur wenn die App mit Sofort-Push gebaut wurde und der Server einen Firebase-Schlüssel hat). Der Push selbst ist leer, den Text holt die App beim Server ab. Die frühere Browser-Version ist abgeschafft; in älteren Profilen kann noch eine Browser-Push-Adresse stehen, sie wird nicht mehr benutzt.
- Wartende Meldungen (Titel, Text, Zeit) liegen kurz im Profil, bis das Gerät sie abgeholt hat.
- Keine Namen, keine Mailadressen. Der grobe Standort (auf etwa 1 km gerundet) wird nur für die Sortierung mitgeschickt und nicht gespeichert.
- Umzugscodes („Neues Handy“) liegen nur 10 Minuten im Arbeitsspeicher des Servers, nicht auf der Platte.
- Zum Schutz vor Missbrauch zählt der Server, wie oft eine Netzwerkadresse (IP) anfragt und wie viele neue Geräte von ihr kommen. Diese Zähler liegen nur im Arbeitsspeicher, werden nie auf die Platte geschrieben, stehen nicht im Profil und sind nach einem Neustart weg. Das Protokoll enthält keine Adressen und keine Geräte-IDs.
- Ein Einladungscode (falls der Server einen verlangt) steht auf dem Server nur in den Add-on-Optionen.
- Profile von Geräten, die 180 Tage nichts abgefragt haben, werden automatisch gelöscht. In der App lässt sich ein Profil jederzeit löschen.

**Nur auf deinem Gerät**
- Der Einladungscode, falls du einen eingegeben hast.
- Tickets (Bild des Barcodes, Name, Gültigkeit). Sie verlassen das Gerät nie. Die Sicherungsdatei „Tickets sichern“ legst du selbst ab. Die Kamera wird nur zum Einlesen eines Tickets benutzt, Bilder werden nicht hochgeladen.
- Die Android-App schließt sich aus der automatischen Android-Sicherung aus (`allowBackup=false`). Beim Gerätewechsel brauchst du „Tickets sichern“ und „Neues Handy“.

**Weitergabe**
- Fahrplanabfragen gehen vom Server an MVV, Bahnland Bayern (MoBY) und ÖBB. Für Strecken der Deutschen Bahn (und als Ausweichquelle für die ÖBB) fragt der Server den öffentlichen Dienst transport.rest (v6.db.transport.rest), der seinerseits bei der Bahn nachfragt. Dabei werden nur Haltestellen und Zeiten übertragen, keine Geräte-ID; die Anfragen kommen von der Adresse deines Servers und nennen „ReGo“ mit der Projektadresse als Absender.
- **Inoffizielle Quellen:** Das sind öffentlich erreichbare, aber inoffizielle Schnittstellen. ReGo ist ein privates Hobbyprojekt, es gibt dafür keine Zusage und keine Gewähr, und ReGo bleibt klein. Würde es wachsen, würden dafür die offiziellen Schnittstellen der Verkehrsunternehmen genutzt (siehe README, „Hinweis zu den Fahrplanquellen“). Für die Quellen selbst gelten die Datenschutzregeln ihrer Betreiber.
- Die Links unter „Strecken“ (Datenschutz, ReGo auf GitHub) öffnen eine Seite bei GitHub im Browser. Erst dann sieht GitHub deine Anfrage; die App selbst lädt nichts von dort.
- Sofort-Push (optional): Der Server schickt einen leeren Anstoß über Google Firebase an die App. Google erfährt dabei die Firebase-Kennung des Geräts und den Zeitpunkt, aber keinen Meldungstext. Ohne Firebase-Schlüssel im Add-on fragt die App alle etwa 15 Minuten selbst beim Server nach.
- Der Zugriff von unterwegs läuft über Tailscale (Serve: nur deine Geräte, Funnel: öffentlich erreichbar). Tailscale sieht dabei die üblichen Verbindungsdaten.

**Statusseite** (`/status`): zeigt nur Zahlen (Version, Quellenzustand, Anzahl Geräte), keine persönlichen Daten. Sie ist öffentlich, wenn der Server öffentlich erreichbar ist.
