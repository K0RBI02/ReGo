# Datenschutz

ReGo ist ein privates Hobbyprojekt in der Beta. Diese Seite sagt, was gespeichert wird.

**Auf dem Server (dein Home-Assistant-Add-on)**
- Je Gerät eine anonyme Zufalls-ID, deine Strecken (Start, Ziel, Tage, Zeit) und die Einstellungen.
- Wenn du Push einschaltest: die Adresse des Push-Dienstes deines Browsers. Der Push selbst ist leer, der Text wird vom Server abgeholt.
- Keine Konten, keine Namen, keine Mailadressen, keine Standorte. Der grobe Standort (auf etwa 1 km gerundet) wird nur für die Sortierung mitgeschickt und nicht gespeichert.
- Profile von Geräten, die 180 Tage nichts abgefragt haben, werden automatisch gelöscht. In der App lässt sich ein Profil jederzeit löschen.

**Nur auf deinem Gerät**
- Tickets (Bild des Barcodes, Name, Gültigkeit). Sie verlassen das Gerät nie. Die Sicherungsdatei „Tickets sichern“ legst du selbst ab.

**Weitergabe**
- Fahrplanabfragen gehen vom Server an MVV, Bahnland Bayern (MoBY) und ÖBB. Dabei werden nur Haltestellen und Zeiten übertragen, keine Geräte-ID.
- Es gibt keine Werbung, keine Analyse und keine Drittanbieter-Skripte.

**Statusseite** (`/status`): zeigt nur Zahlen (Version, Quellenzustand, Anzahl Geräte), keine persönlichen Daten.
