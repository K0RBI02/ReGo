# ReGo auf dem Android-Handy

ReGo ist eine native Android-App: Die Oberfläche steckt in der App (eigenes Fenster, kein Browser), die Daten kommen von deinem ReGo-Server. Dafür kann sie Dinge, die eine Webseite nicht kann: beim Ticket die Helligkeit auf Maximum und den Bildschirm anlassen, Dateien in „Download“ speichern, Meldungen über einen eigenen Hintergrunddienst abholen. Nach einer ReGo-Änderung am Aussehen braucht es eine neue APK (Workflow unten), Server-Änderungen kommen weiter per Add-on-Update. Die frühere Browser-Variante (PWA) gibt es seit 0.6.0 nicht mehr.

## In der App
- **Hochformat** und **feste Textgröße**: Die App folgt der Android-Schriftgröße nicht, weil die Oberfläche dafür gebaut ist und sich sonst Teile verschieben.
- **Kurzbefehle:** Lange auf das App-Symbol drücken zeigt „Ticket anzeigen“, „Meldungen“ und „Neue Strecke“. Ein Kurzbefehl lässt sich auf den Startbildschirm ziehen.
- **Symbol:** Ein Läufer mit Rucksack und Aktentasche. Der Hintergrund folgt dem System (dunkel bei hellem, hell bei dunklem System); je nach Launcher dauert es, bis ein Wechsel sichtbar wird. Launcher mit eigenem Symbol-Pack (zum Beispiel Niagara) zeigen stattdessen das Symbol aus dem Pack.
- **Themed Icon:** Ab Android 13 passt sich das Symbol der Farbe des Hintergrundbilds an, wenn du in den Android-Einstellungen die Option für designte Symbole eingeschaltet hast.
- **Benachrichtigungskanäle:** In den Android-Einstellungen (Apps → ReGo → Benachrichtigungen) gibt es vier Kanäle: „Verspätungen“, „Ausfälle und Ersatzverkehr“, „Baustellen“ und „Gleiswechsel“ (leise). Jeder lässt sich einzeln lauter, leiser oder ausschalten. Beim Update auf 0.6.0 wird der frühere Sammelkanal „Meldungen“ durch diese vier ersetzt.
- **Einstellungen:** Unter „Strecken“ steht ganz unten der Satz „Push, neues Handy und Rückmeldung findest du in den Einstellungen“. Er öffnet ein Blatt von unten mit den Push-Meldungen, der Testmeldung, „Neues Handy?“, der Rückmeldung und der Versionszeile. Die Zurück-Taste schließt es.
- **Testmeldung:** In den Einstellungen schickt „Testmeldung“ eine Meldung an das Handy. Sie kommt sofort (mit Firebase) oder bei der nächsten Abfrage (ohne Firebase, bis ca. 15 Minuten); die App sagt dazu, was gilt.
- **Einladungscode:** Hat der Server einen eingestellt (Add-on-Option `invite_code`), fragt die App bei einem neuen Gerät einmal danach. Wer schon angemeldet ist, merkt davon nichts.

**Meldungen:** Mit Firebase kommen Meldungen sofort: Der Server schickt nur einen leeren Anstoß, den Text holt die App selbst ab. Ohne Firebase fragt die App etwa alle 15 Minuten beim Server nach (öfter erlaubt Android für Hintergrundarbeit nicht). Ist eine Verspätung, ein Ersatzverkehr oder eine Baustelle vorbei, schreibt die App die Meldung in der Leiste kurz auf „behoben“ um und räumt sie danach weg.

**Sofort-Push einrichten (einmalig)**
1. Firebase-Projekt anlegen, darin eine Android-App mit dem Paketnamen `io.github.k0rbi02.rego` registrieren und `google-services.json` laden. Die Datei als Base64 (`base64 -w0 google-services.json`) in das GitHub-Geheimnis `GOOGLE_SERVICES_JSON_B64` legen.
2. In Firebase → Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel generieren“. Den ganzen Inhalt der JSON-Datei in die Add-on-Option `fcm_key` einfügen und das Add-on neu starten.
3. APK neu bauen (siehe unten) und installieren. In der App unter „Strecken“ → „Einstellungen“ die Push-Meldungen einschalten und „Testmeldung“ senden.
4. Kontrolle am Server: Die Statusseite `/status` zeigt „Sofort-Push: an“ und bei den Push-Abos „mit Firebase-Kennung“, und im Add-on-Protokoll steht beim Start „Push: Firebase-Schlüssel geladen“.

**Tickets:** Die App hat einen eigenen Speicher. Tickets aus einer älteren Browser-Installation vorher mit „Tickets sichern“ sichern und in der App mit „wiederherstellen“ einspielen.

## Einmal einrichten (GitHub, Repo K0RBI02/ReGo → Settings → Secrets and variables → Actions)
1. Secret `ANDROID_KEYSTORE_B64`: Inhalt der Datei `rego-keystore-b64.txt` (Signierschlüssel).
2. Secret `ANDROID_KEYSTORE_PASSWORD`: das zugehörige Passwort.
3. Optional Variable `REGO_HOST`, falls sich deine Adresse ändert (ohne `https://`). Standard: `rego.tail2a5f03.ts.net`.

## APK bauen
Der Bau startet von allein, wenn sich etwas unter `android/` oder `public/` ändert und gepusht wird. Die Versionsnummer der App kommt aus `version` in `rego/config.yaml`. Von Hand: Repo → Actions → „Android-App (APK) bauen“ → Run workflow. Nach etwa 5 Minuten liegt die Datei unter Releases (`app-v<Version>`).

## Installieren
Auf dem Handy im Browser die Release-Seite öffnen, `rego-<Version>.apk` laden und antippen (einmal „Aus dieser Quelle installieren“ erlauben). Eine neue Version einfach über die alte installieren: Tickets und Strecken bleiben, solange der Signierschlüssel derselbe ist. Eine vorherige TWA-Version (0.2.1) vorher deinstallieren.

## Handy-Wechsel
Die App schließt sich aus der Android-Sicherung aus. Auf dem alten Handy „Tickets sichern“ und in den Einstellungen (unter „Strecken“) einen Code für „Neues Handy“ erzeugen, auf dem neuen die Datei einspielen und den Code eingeben. Hat der Server einen Einladungscode, braucht das neue Handy zuerst diesen.

## Hinweise
- Der Server muss laufen. Ist er nicht erreichbar, zeigt ReGo den letzten Stand mit „Offline-Modus“. Läuft ReGo nur über Tailscale „Serve“, muss das Handy Tailscale an haben (im Mobilnetz geht das auch); bei „Funnel“ nicht.
- Kommen Meldungen verspätet, die Akku-Optimierung für ReGo ausnehmen.
- Kommen Meldungen nur alle ~15 Minuten, obwohl Firebase eingerichtet sein soll: `/status` öffnen. Steht dort „Sofort-Push: aus“, fehlt der Schlüssel im Add-on (`fcm_key`, Schritt 2) oder er ist nicht lesbar (das Protokoll sagt es beim Start). Steht dort „Sofort-Push: an“, aber „0 mit Firebase-Kennung“, hat das Handy keine Kennung gemeldet: APK mit Firebase bauen (Schritt 1 und 3), installieren und die Push-Meldungen in der App aus- und wieder einschalten.
- Der Signierschlüssel darf nie verloren gehen und nie ins Repo. Mit einem anderen Schlüssel lässt sich eine neue APK nicht über die alte installieren.
