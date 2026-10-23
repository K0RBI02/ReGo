# ReGo add-on

Runs the ReGo backend around the clock on your Home Assistant host: the Android app gets its timetable data, delays and push notifications from it. Routes, settings and push tokens of each phone are stored per phone in the add-on's `/data` and survive updates; tickets never reach the server. How the backend works: [BACKEND.md](https://github.com/K0RBI02/ReGo/blob/main/BACKEND.md). The Android app is built separately, see the [README](https://github.com/K0RBI02/ReGo#readme).

## Installation

1. Home Assistant → Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add `https://github.com/K0RBI02/ReGo`.
2. Install ReGo, set the options below, start it and enable "Start on boot".
3. Test in the home network: `http://<host>:8080/api/health`.
4. Updates: when a new version is available, ReGo shows an **Update** button. Do not uninstall the add-on, that loses the Tailscale login and all routes. To let Home Assistant restart ReGo if it ever hangs, switch on **Watchdog** under "Info".

## Options

- `invite_code`: invitation code for new devices (optional, recommended when ReGo is public). Empty: anyone may create a profile.
- `provider`: `library` (default), `transport-rest` or `mock` (sample data).
- `fcm_key`: Firebase service-account key (the complete JSON) for instant push. Empty: the app asks the server about every 15 minutes. How to get the key: [README](https://github.com/K0RBI02/ReGo#instant-push-firebase).
- `ts_mode`: `off`, `serve` (only devices in your tailnet) or `funnel` (public, also for friends without Tailscale). `ts_hostname`: device name in the tailnet (default `rego`). `ts_authkey`: Tailscale auth key, only needed for the first login.
- `contact`: where testers send feedback: an email address or a web link. The app shows it in the settings and prepares a mail to it (with app and server version). It is only sent to devices that know the server, not shown on the public status page. Empty: the app points to the GitHub issue form. Next to it the settings offer "Fehlerbericht speichern": a text file in the Download folder of the phone (versions, state, latest errors; no stops, routes, tickets or device ID) that testers can send along with their feedback.

## https through Tailscale

ReGo can join your tailnet as its own device and get an https address `https://rego.<your-tailnet>.ts.net`.

1. In the Tailscale admin (login.tailscale.com): DNS → enable **MagicDNS** and **HTTPS Certificates**.
2. Settings → Keys → **Generate auth key** (single use, not ephemeral). Put the key only into the add-on options.
3. Set `ts_authkey`, set `ts_mode` to `serve` or `funnel`, save and restart the add-on. The log shows the address.

`funnel` needs the "funnel" attribute in the Tailscale ACL (Admin → Access controls); new tailnets usually have it. After the first login the auth key can be removed.
