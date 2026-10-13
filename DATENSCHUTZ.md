# Datenschutz

ReGo ist ein privates Hobbyprojekt in der Beta. Diese Seite sagt, was gespeichert wird und wohin Daten gehen. Es gibt keine Konten, keine Werbung und keine Analyse, und die App lädt keine Skripte, Schriften oder Bilder von Drittanbietern.

**Auf dem Server (dein Home-Assistant-Add-on)**
- Je Gerät eine anonyme Zufalls-ID, deine Strecken (Start, Ziel, Tage, Zeit), die Einstellungen und der Zeitpunkt, wann sich das Gerät zuletzt gemeldet hat (nur zum Aufräumen).
- Wenn du Push einschaltest: im Browser die Adresse des Push-Dienstes deines Browsers samt Schlüsseln, in der Android-App die Firebase-Kennung des Geräts (nur wenn die App mit Sofort-Push gebaut wurde). Der Push selbst ist leer, den Text holt das Gerät beim Server ab.
- Wartende Meldungen (Titel, Text, Zeit) liegen kurz im Profil, bis das Gerät sie abgeholt hat.
- Keine Namen, keine Mailadressen. Der grobe Standort (auf etwa 1 km gerundet) wird nur für die Sortierung mitgeschickt und nicht gespeichert.
- Umzugscodes („Neues Handy“) liegen nur 10 Minuten im Arbeitsspeicher des Servers, nicht auf der Platte.
- Profile von Geräten, die 180 Tage nichts abgefragt haben, werden automatisch gelöscht. In der App lässt sich ein Profil jederzeit löschen.

**Nur auf deinem Gerät**
- Tickets (Bild des Barcodes, Name, Gültigkeit). Sie verlassen das Gerät nie. Die Sicherungsdatei „Tickets sichern“ legst du selbst ab. Die Kamera wird nur zum Einlesen eines Tickets benutzt, Bilder werden nicht hochgeladen.
- Die Android-App schließt sich aus der automatischen Android-Sicherung aus (`allowBackup=false`). Beim Gerätewechsel brauchst du „Tickets sichern“ und „Neues Handy“.

**Weitergabe**
- Fahrplanabfragen gehen vom Server an MVV, Bahnland Bayern (MoBY) und ÖBB. Für Strecken der Deutschen Bahn (und als Ausweichquelle für die ÖBB) fragt der Server den öffentlichen Dienst transport.rest (v6.db.transport.rest), der seinerseits bei der Bahn nachfragt. Dabei werden nur Haltestellen und Zeiten übertragen, keine Geräte-ID; die Anfragen kommen von der Adresse deines Servers.
- Sofort-Push (optional): Der Server schickt einen leeren Anstoß über Google Firebase an die App. Google erfährt dabei die Firebase-Kennung des Geräts und den Zeitpunkt, aber keinen Meldungstext. Ohne Firebase-Schlüssel im Add-on fragt die App alle etwa 15 Minuten selbst beim Server nach.
- Der Zugriff von unterwegs läuft über Tailscale (Serve: nur deine Geräte, Funnel: öffentlich erreichbar). Tailscale sieht dabei die üblichen Verbindungsdaten.

**Statusseite** (`/status`): zeigt nur Zahlen (Version, Quellenzustand, Anzahl Geräte), keine persönlichen Daten. Sie ist öffentlich, wenn der Server öffentlich erreichbar ist.
