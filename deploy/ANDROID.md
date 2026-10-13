# ReGo auf dem Android-Handy

## Variante A: echte App (APK)
Eine native Android-App: Die Oberfläche steckt in der App (eigenes Fenster, kein Browser), die Daten kommen von deinem ReGo-Server. Dafür kann sie Dinge, die eine PWA nicht kann: beim Ticket die Helligkeit auf Maximum und den Bildschirm anlassen, Dateien in „Download“ speichern, Meldungen über einen eigenen Hintergrunddienst abholen. Nach einer ReGo-Änderung am Aussehen braucht es eine neue APK (Workflow unten), Server-Änderungen kommen weiter per Add-on-Update.

**Meldungen:** Mit Firebase kommen Meldungen sofort: Der Server schickt nur einen leeren Anstoß, den Text holt die App selbst ab. Ohne Firebase fragt die App etwa alle 15 Minuten beim Server nach (öfter erlaubt Android für Hintergrundarbeit nicht).

**Sofort-Push einrichten (einmalig)**
1. Firebase-Projekt anlegen, darin eine Android-App mit dem Paketnamen `io.github.k0rbi02.rego` registrieren und `google-services.json` laden. Die Datei als Base64 (`base64 -w0 google-services.json`) in das GitHub-Geheimnis `GOOGLE_SERVICES_JSON_B64` legen.
2. In Firebase → Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel generieren“. Den ganzen Inhalt der JSON-Datei in die Add-on-Option `fcm_key` einfügen und das Add-on neu starten.
3. APK neu bauen (siehe unten) und installieren. In der App unter Strecken „Push-Meldungen“ einschalten.

**Tickets:** Die App hat einen eigenen Speicher. Tickets aus Browser/PWA vorher mit „Tickets sichern“ sichern und in der App mit „wiederherstellen“ einspielen.

**Einmal einrichten (GitHub, Repo K0RBI02/ReGo → Settings → Secrets and variables → Actions)**
1. Secret `ANDROID_KEYSTORE_B64`: Inhalt der Datei `rego-keystore-b64.txt` (Signierschlüssel).
2. Secret `ANDROID_KEYSTORE_PASSWORD`: das zugehörige Passwort.
3. Optional Variable `REGO_HOST`, falls sich deine Adresse ändert (ohne `https://`). Standard: `rego.tail2a5f03.ts.net`.

**APK bauen:** Repo → Actions → „Android-App (APK) bauen“ → Run workflow. Nach etwa 5 Minuten liegt die Datei unter Releases (`app-v<Version>`).

**Installieren:** Auf dem Handy im Browser die Release-Seite öffnen, `rego-<Version>.apk` laden und antippen (einmal „Aus dieser Quelle installieren“ erlauben). Eine vorherige TWA-Version (0.2.1) vorher deinstallieren.

**Handy-Wechsel:** Die App schließt sich aus der Android-Sicherung aus. Auf dem alten Handy „Tickets sichern“ und unter Strecken einen Code für „Neues Handy“ erzeugen, auf dem neuen die Datei einspielen und den Code eingeben.

**Wichtig:** Der Signierschlüssel darf nie verloren gehen und nie ins Repo. Mit einem anderen Schlüssel lässt sich eine neue APK nicht über die alte installieren, kann nicht darüber installiert werden.

## Variante B: PWA über Chrome
ReGo ist eine PWA: Chrome macht daraus eine App mit eigenem Icon, ohne Browserleiste und ohne Play Store.
Dafür braucht die Seite **https**. Der einfachste und private Weg ist Tailscale (nur deine eigenen Geräte kommen drauf).

## 1. Einmalig: Tailscale
1. Auf Lab02 und auf dem Handy Tailscale installieren, beide mit demselben Konto anmelden.
2. Im Tailscale-Adminbereich (login.tailscale.com → DNS) **MagicDNS** und **HTTPS Certificates** aktivieren.

## 2. ReGo auf Lab02 starten
    cd ~/rego && npm install
    npm start                       # oder als Dienst, siehe deploy/rego.service
    tailscale serve --bg 8080       # macht daraus https://<lab02>.<dein-tailnet>.ts.net

`tailscale serve status` zeigt die Adresse.

## 3. Aufs Handy
1. Tailscale auf dem Handy öffnen (muss verbunden sein).
2. In Chrome die https-Adresse öffnen.
3. Menü ⋮ → **App installieren** (oder „Zum Startbildschirm hinzufügen“).
4. ReGo vom Startbildschirm öffnen, Strecke anlegen. Beim ersten Antippen von „Push ab … Min.“ fragt Android nach der Benachrichtigungs-Erlaubnis.

## Hinweise
- Kamera-Scan und Push funktionieren nur über https.
- Lab02 muss laufen und das Handy muss Tailscale an haben, sonst zeigt ReGo den letzten Stand mit „Offline-Modus“.
- Akku-Optimierung für Chrome ausnehmen, wenn Push verspätet ankommt.
- Zugriff von überall: Tailscale funktioniert auch im mobilen Netz.
