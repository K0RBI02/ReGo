# ReGo Backend

The server side of ReGo, a minimalist public-transport app for commuters in the Alpine region of Bavaria and Austria. The Android app is described in [README.md](README.md), privacy in [PRIVACY.md](PRIVACY.md). This page is a short overview of how the backend works, not a manual.

It is a small Node.js server (Node ≥ 20, one runtime dependency: `hafas-client`). It

- fetches timetable data from several sources (regional transport associations, ÖBB, Deutsche Bahn),
- keeps the routes ("tours" in the API) and settings of each device,
- turns them into one ready-to-show state: next departures, delays, cancellations, platform changes, construction, replacement transport and connections with one transfer,
- decides when a device should be notified and nudges the app to fetch the message,
- serves the UI files that the app bundles, plus a status page.

There are no user accounts: a device is an anonymous random ID, and tickets never reach the server. It usually runs as a Home Assistant add-on on a Raspberry Pi behind Tailscale, but it also runs standalone.

## Running it

```sh
npm install
npm run demo     # sample data, no internet needed
npm start        # real data
npm test
```

Then open `http://127.0.0.1:8080/status` for the status page. The UI is also served at `/`, which is handy for trying things out; the product is the Android app.

### Home Assistant add-on

The recommended way. Setup and options are in [rego/DOCS.md](rego/DOCS.md). GitHub Actions builds the image for `aarch64` and `amd64`; the Pi only downloads it.

### Standalone

```sh
npm install --omit=dev
HOST=0.0.0.0 PORT=8080 REGO_DATA=/var/lib/rego npm start
```

The server speaks plain http; TLS is not part of it, put it behind a reverse proxy or Tailscale. For autostart, a minimal systemd user unit (`~/.config/systemd/user/rego.service`; adjust `WorkingDirectory`, then `systemctl --user enable --now rego` and `loginctl enable-linger $USER`):

```ini
[Unit]
Description=ReGo
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/rego
Environment=HOST=127.0.0.1
Environment=PORT=8080
ExecStart=/usr/bin/env node server/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

## Configuration

All settings are optional environment variables; the add-on options map onto them (`provider` → `REGO_PROVIDER`, `fcm_key` → `REGO_FCM_KEY`, `invite_code` → `REGO_INVITE`, `contact` → `REGO_CONTACT`). The main ones:

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Port (default 8080) and bind address (default `127.0.0.1`, `0.0.0.0` for the LAN). |
| `REGO_DATA` | Data directory. |
| `REGO_PROVIDER` | `library` (default), `transport-rest` or `mock`, see below. |
| `REGO_INVITE` | Invitation code: new devices need it, known devices keep working. Empty: open. |
| `REGO_CONTACT` | Where testers send feedback: an email address or a web link. The app shows it in the settings; empty: the GitHub issue form. |
| `REGO_FCM_KEY` | Firebase service-account JSON for instant push (or a file `fcm.json` in the data directory). |
| `REGO_VERBOSE` | `1` logs source errors, slow requests and push activity. |
| `REGO_CORS` | Additional allowed origin for the API, for working on the UI. |

Source URLs, timeouts, retries, push interval and retention are in `server/config.mjs`.

## Timetable sources

ReGo is a private hobby project. The data comes from publicly reachable but **unofficial** interfaces, without any commitment or warranty: a source can change, become slower or be blocked. ReGo therefore stays deliberately small (few devices, few requests, rate limiting, optional invitation code). If it grew, the data would have to come from the official interfaces of the operators and associations.

| Source | Reached through |
|---|---|
| MVV, Bahnland Bayern (MoBY) | EFA services |
| ÖBB | `hafas-client`, transport.rest as fallback |
| Deutsche Bahn | transport.rest |

- `REGO_PROVIDER` selects how they are reached: `library` (EFA for the associations, ÖBB through the library with transport.rest as fallback, Deutsche Bahn through transport.rest), `transport-rest` (ÖBB and Deutsche Bahn both through transport.rest) or `mock` (sample data without network access, used by `npm run demo` and the tests).
- Which source answers a route depends on its stops: the association if both stops belong to the same one (MoBY, the wider one, if they belong to two), otherwise ÖBB if one end is in Austria, otherwise Deutsche Bahn. Stops are translated between sources by name and position.
- If an association does not answer (MoBY with HTTP 429, a timeout, a server error, a refusal), ÖBB and then Deutsche Bahn show the trips of its routes. The stops are translated by name and position, but strictly: the stop needs coordinates, a hit within 600 m has to have a fitting name (a bus stop is never replaced by the station next to it), and a stop that cannot be translated is not searched again for 15 minutes. The first source with trips wins, Deutsche Bahn is asked only if ÖBB fails. If the railway has no trips either, the route keeps the error of the association and says which source is closed; an association that answers but does not know a route is not replaced. Buses and trams usually are not in the railway data, so such routes stay dark. The log says once per outage that a backup took over, and once when the association answers again.
- The station search asks all sources in parallel, removes duplicates and caches the result.
- Answers are cached for a short time and concurrent requests share one source query. If a source fails, the last value is used for up to 30 minutes and marked as stale, and the source is left alone for a short pause. A route without usable data says so; it never shows "on time" without data. An answer without any trip that comes right after a good one does not replace it for ten minutes: the trips of the good answer that have not left yet are kept (an association can answer like this during closures).
- If a source answers "too many requests" (HTTP 429), ReGo stops asking it: for as long as the source says (`Retry-After`, at most 24 hours), otherwise 1 minute, then 2, 4 … at most 30 minutes, and then tests it with a single request. Until then the app shows the last state, `/status` marks the source as "pausiert" and `/api/status` says for how many more seconds it is left alone. A route that has no data because of that says which source is closed ("MoBY lässt gerade keine Abfragen zu"). A source also gets at most three requests at the same time.

## HTTP API

JSON over plain http. Every path except `/api/health` and `/api/status` needs the header `X-Device: <id>` (the anonymous ID the app generates once); a device the server does not know yet also needs `X-Invite` if an invitation code is set. Errors are `{error}` with a matching HTTP status. All responses carry security headers, and CORS is limited to the app's own origin.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness check (used by the add-on watchdog). |
| `GET /api/status` | Version, state of the sources (`ok`, and `pausedSec` while a source is left alone), number of devices (also per app version) and push subscriptions; no personal data. The page `/status` shows the same. |
| `GET /api/stations?q=` | Station search. |
| `GET /api/state` | The complete state of the device: routes with departures, incidents, settings, and the feedback address (`contact`). The Android app adds `?app=<version>`; if that app is older than `APP_LATEST`, the answer also carries `app: {latest, url}` for the update hint. |
| `POST /api/connections/search` | Looks for a connection with at most one transfer. `found` is `true`, `false` or `null` (unknown); 503 with `code: "source-paused"` if the source for this route has put ReGo on pause. |
| `POST /api/tours`, `PATCH /api/tours/:id`, `DELETE /api/tours/:id` | Create, change or delete a route. |
| `GET/PUT/DELETE /api/profile` | Read, replace (the app's undo) or delete the data of the device. |
| `PUT /api/settings` | Push threshold (3, 5 or 10 minutes). |
| `PUT /api/push/native`, `DELETE /api/push` | Enable or disable push for the device. |
| `POST /api/push/test` | Send a test notification. |
| `GET /api/notifications` | Collect the pending notifications (after a nudge, or about every 15 minutes). |
| `POST /api/transfer`, `POST /api/transfer/claim` | "New phone": a one-time code (valid for 10 minutes) moves routes and settings to another device. |

Creating a route checks it against the source first. Without a direct connection the answer is **422** (`no-direct`), and the app then offers to search with one transfer. "Hin und zurück" creates two linked routes; a device can have up to 20.

## What the state contains

`GET /api/state` returns what the UI needs, with the display text already in German. Per route: its schedule and commute window, up to three departures (planned and expected time, platform, delay) and a detail view for each. Next to the routes comes a list of incidents:

| Incident | Meaning | Push |
|---|---|---|
| `delay` | First delayed departure of a route (at least 3 minutes). | From the device's threshold. |
| `replacement` | Replacement transport, from the remarks of the source. | Always. |
| `construction` | Construction, from the remarks of the source. | Always. |
| `cancelled` | Cancelled trips in the next 3 hours. | Always. |
| `platform` | Platform change within the next 45 minutes. | Always, on a quiet channel. |
| `tight` | Connection at risk (routes with a transfer). | Always. |
| `missed` | Connection missed or cancelled. | Always. |

An incident has a stable ID (a hash of the route and its identifying details): it stays the same when only its numbers change, and a new day or another train is a new incident.

## Rules in short

**Commute window.** Every route has days and a departure window, for example 07:00–08:00. Before and during the window ReGo evaluates the trips in it. Outside it shows the next trains as usual, but without push. A departure more than 45 minutes away says "planmäßig" instead of "pünktlich", because the sources know few delays that far ahead.

**"Pünktlich" needs real-time data.** Every trip carries a flag whether its source has real-time data for the departure (an estimated time, or the status "monitored"). A near departure without it is not reported as on time: the view says "planmäßig" and "Ohne Echtzeit … Verspätungen unbekannt", and the app shows it neutral instead of with a green check. With a transfer, both trips need the data.

**Routes with one transfer.** They are created on the user's choice when there is no direct connection. The source only returns connections that still work in real time, so ReGo rates the transfer itself: for every departure it picks feeder, transfer station and connection anew and decides between ok, at risk and missed. The associations (EFA) apply the limit of one transfer only after they have calculated a few candidate trips, so during closures a search can come back with nothing or with trips that have left already; ReGo then asks once more for the trips with the fewest transfers, and the preview and the saved route use the same query and cache.

**Shortcut hint.** If a route without transfer has replacement transport, ReGo also looks for a safe connection with one transfer that arrives at least five minutes earlier and shows it on the incident page. It is only a hint, there is no extra incident and no push.

**Push.** Android only. With a Firebase key the server sends an **empty** nudge and the app fetches the text itself, so no message text goes to Google. Without a key the app asks about every 15 minutes. Every minute the server goes through the devices with push enabled:

- A delay is relevant from the device's threshold, every other kind while it is active. Each incident is reported once.
- A changed delay, number of cancelled trips or platform updates the notification silently. When an incident is over, the app rewrites the notification to "behoben" and removes it.
- New notifications come only in the push period of a route: on its days, from an hour before the window until 10 minutes after it ends. Outside, incidents stay visible in the app without push.
- Night quiet 23:00–04:00 (Berlin): no push at night, except for routes whose push period reaches into the night. A departure at 04:20 pushes from 03:20. Other routes and their notifications stay untouched until the morning.
- Routes with stale data produce no new notifications. If the push service cannot be reached, the batch is tried again at the next check.
- To keep the load on the sources low, this check refreshes a route that cannot push right now (outside its push period) only every 10 minutes. The app always asks for fresh data.

How to set up instant push is described in the [README](README.md#instant-push-firebase). The app's settings have a test notification.

## Data and limits

- Each device has one small profile file in the data directory. There are no tickets, names, e-mail addresses or accounts on the server; transfer codes and rate-limit counters live in memory only. The app also tells its version number with each state request; the last one is kept in the profile so that the status page can count app versions. Profiles of devices that have not been seen for 180 days are deleted, and there are at most 2000 profiles. More in [PRIVACY.md](PRIVACY.md).
- For a server that is reachable from the internet (for example through Tailscale Funnel): rate limits per address and per device (stricter for searches, ten new devices per hour and address), the optional invitation code (wrong codes are slowed down) and a size limit for request bodies.

## Troubleshooting

- `/status` shows version, sources, devices, push subscriptions and whether instant push is on. The add-on log starts with a network test and lists the errors of the sources. If ReGo hangs, switch on **Watchdog** in the add-on.
- If the timetable sources are down, the app shows the last state (at most 30 minutes old); once that data is five minutes old it also shows "Keine aktuellen Daten". If only the routes of one source have no data at all, they say so themselves ("Keine Daten") and the banner stays off for the others.
- A route stays dark ("Keine Daten") while its association is closed: ReGo could not match its stops for the backup (no coordinates stored, a bus stop, a name that does not fit) or the railway has no direct trip between them. Routes saved from the station search carry the coordinates of their stops.
- The log says "zu viele Anfragen" (HTTP 429): a source is slowing ReGo down. ReGo pauses that source by itself and tries again later; the log line says for how long and what the source answered, and `/status` marks the source as "pausiert". A source that asks for a day ("Retry-After 86400") is left alone for a day; a restart of the add-on makes ReGo ask once more. If the answer says the interface is not open data, ReGo cannot change that: the operator has to allow access. Fewer routes and no app left open on a second device ease the load. Every log line starts with the time, and the first one names the version.
- The test notification arrives only after minutes although Firebase is set up: open `/status`. "Sofort-Push: aus" means the key is missing or unreadable (the log says so at start). "an" with "0 mit Firebase-Kennung" means the phone never reported a token: use an APK built with Firebase and switch push off and on again in the app.
- The app asks for an invitation code: `invite_code` is set and the server does not know the device yet (fresh install, or after "delete profile").

## Development

```text
server/     index.mjs     HTTP server, routes, static files, background timers
            config.mjs    environment variables → settings
            service.mjs   builds the state of a device
            guard.mjs     rate limits, invitation code
            notifier.mjs  push decisions (fcm.mjs: Firebase delivery)
            providers/    timetable sources: EFA, HAFAS, hafas-client, mock
            domain/       incidents, transfers, commute window
            store/        profiles on disk, cache
public/     the UI (screens/*.dc.html, js/), also bundled into the Android app
android/    the Android app (WebView shell, notification service)
rego/       Home Assistant add-on: config.yaml, Dockerfile, run.sh, DOCS.md, CHANGELOG.md
test/       unit and API tests, with recorded responses in fixtures/
scripts/    ui-smoke.mjs (screen test), probe.mjs (records real responses)
```

- `npm test` runs all unit and API tests offline. `node scripts/ui-smoke.mjs` is the screen test: it starts ReGo with sample data, opens every screen in phone size and walks through the main flows; it needs Playwright (`npm i --no-save playwright && npx playwright install chromium`).
- CI (GitHub Actions): `build.yml` runs both tests and then builds the add-on images; `apk.yml` builds the signed APK (see the [README](README.md#building-the-apk)).
- Releasing: raise `version` in `package.json` and `rego/config.yaml` and add a heading `## <version> – <title>` at the top of `rego/CHANGELOG.md` (a test checks that all three agree), then push to `main`. A server-only change reaches the Pi through the add-on update; a change to `public/` or `android/` also needs the new APK, and then `APP_LATEST` in `server/config.mjs` is set to that release so that older apps get the update hint (a server-only release builds no APK, so it leaves `APP_LATEST` alone).
