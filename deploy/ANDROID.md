# ReGo auf dem Android-Handy

## Variante A: echte App (APK)
Die APK ist eine schlanke Hülle um ReGo (Trusted Web Activity): eigenes App-Symbol, keine Browserleiste, eigener Eintrag in der App-Liste. Die Oberfläche kommt weiter von deinem Server, deshalb braucht jede ReGo-Änderung nur das Add-on-Update, nicht eine neue APK. Push und die lokal gespeicherten Tickets bleiben wie bei der PWA.

**Einmal einrichten (GitHub, Repo K0RBI02/ReGo → Settings → Secrets and variables → Actions)**
1. Secret `ANDROID_KEYSTORE_B64`: Inhalt der Datei `rego-keystore-b64.txt` (Signierschlüssel).
2. Secret `ANDROID_KEYSTORE_PASSWORD`: das zugehörige Passwort.
3. Optional Variable `REGO_HOST`, falls sich deine Adresse ändert (ohne `https://`). Standard: `rego-beta-app.tail2a5f03.ts.net`.

**APK bauen:** Repo → Actions → „Android-App (APK) bauen“ → Run workflow. Nach etwa 5 Minuten liegt die Datei unter Releases (`app-v<Version>`).

**Installieren:** Auf dem Handy im Browser die Release-Seite öffnen, `rego-<Version>.apk` laden und antippen (einmal „Aus dieser Quelle installieren“ erlauben). Die alte PWA vorher deinstallieren oder einfach daneben lassen. Die Tickets bleiben erhalten, weil sie im Chrome-Speicher derselben Adresse liegen.

**Wichtig:** Der Signierschlüssel darf nie verloren gehen und nie ins Repo. Mit einem anderen Schlüssel lässt sich eine neue APK nicht über die alte installieren, und die Adressprüfung (`public/.well-known/assetlinks.json`, hinterlegt ist der Fingerabdruck des Schlüssels) schlägt fehl, dann erscheint oben eine Browserleiste.

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
