# ReGo auf dem Android-Handy installieren

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
