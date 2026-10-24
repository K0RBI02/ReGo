---
paths:
  - "server/**"
---

# Backend rules (`server/`)

Loaded when you work on the server. The behaviour for users is in `BACKEND.md`; this file is about how it is built, why, and what goes wrong.

Plain ES modules, Node >= 20 (CI uses 22), no build step, no framework. `createApp()` in `server/index.mjs` wires everything and takes injectable parts (`cfg`, `now`, `service`, `store`, `fcmClient`), which is how all tests run the real server with a mock provider, a temporary data directory and a fixed clock.

## What happens on `GET /api/state` (the heart of the app)

1. `guard.rate` (per address) and `guard.device` (per device, invitation code for devices the server does not know yet). The device ID comes from `X-Device` (or `?device=`) and has to match `^[A-Za-z0-9_-]{16,64}$`.
2. The handler notes the app version (`?app=`), then calls `service.getState(device, {lat, lon})`.
3. For every **active** tour, in parallel and each with a deadline of 12 s (`tourDeadlineMs`):
   - `windowState()` gives the commute-window mode and an *anchor*: up to 3 h before the window the route already asks for the trains of the window (`@HH:MM` goes into the cache key).
   - Source: `providers.forTourSafe(from, to)` picks the source (see `sources.md`); the query goes through `askTrips()` (cache with stale fallback, "last good answer" memory).
   - If the source fails, the route shows cached trips for up to 30 min and is marked `stale`; with nothing cached it shows "Keine Daten" and, if a source is paused, which one.
   - Routes with `transfers: 1` use the query "at most 1 transfer" (`transferJourneys`). If that answer has no trip still to come (`hasStart`), the service asks for up to 2 transfers (own cache key `…:t2`) and, if that helps, builds the route as a *chain* (up to 3 trips).
   - Builder: `buildTour` (direct), `buildTransferTour` (one transfer, with the second query `loadBLists` for the connecting trips at the transfer station), `buildChainTour` (two transfers). Replacement transport on a direct route triggers `loadShortcut` (is there a safe connection with one transfer that is at least 5 min earlier?).
   - Every builder returns `{tour, incidents}`.
4. Tours are sorted (`sortTours`: active first, then the window that is running, then the one coming later today, then by distance), incidents by severity; incidents that are over are dropped (`stillVisible`, delays get a grace of `delayGraceMin` = 10 min).
5. `connection.status` is `'error'` ("Server offline") only if every route failed with no data at all, or if a route shows cached data older than 5 minutes. A single route without data does not put a banner over the others.
6. The handler adds `contact` (feedback address) and, for an app older than `APP_LATEST`, `app: {latest, url}`.

## Module notes

- **`server/index.mjs`** – security headers on everything (CSP `default-src 'self'` plus inline and eval for the UI runtime, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, permissions-policy camera/geolocation for self). CORS only for `cfg.corsOrigin` and `https://appassets.androidplatform.net` (the app's own origin), allowed request headers `content-type, x-device, x-invite`. Request bodies are limited to 64 KB (413); bodies must be JSON objects. Error shape `{error, code?}`; `422` carries `code: 'no-direct' | 'no-connection'`, `503` `code: 'source-paused'`, `403` from the invitation gate carries `invite: true` (and `wrong: true` for a wrong code). Static files: extension-less paths fall back to `index.html` (the router lives in the browser), `/status` serves `status.html`, fonts are cached for a week. Transfer codes ("Neues Handy?") are held in memory (6 characters, 10 min, at most 500 open, 10 failed claims per minute). `main` prefixes log lines with Berlin time, installs `unhandledRejection`/`uncaughtException` handlers so one stray error does not kill the server, purges old profiles every 24 h and runs `notifier.tick()` every `notifyEverySec`.
- **`server/config.mjs`** – everything is an environment variable with a default (list in BACKEND.md and in the file). Notable: `ttl` (search/stop 24 h, journeys 30 s, state 15 s), `staleMaxSec.journeys` 30 min, `mapBudgetMs` 5 s, `incidentMinDelay` 3 min, `REGO_PROFILE_DAYS` 180, `REGO_MAX_PROFILES` 2000, `REGO_NOTIFY_SEC` 60, `REGO_NOTIFY_IDLE_DAYS` 21. `APP_LATEST` is the newest downloadable app version (release rule in `release-and-addon.md`). `contactOf()` accepts only an email address or an http(s) link.
- **`server/service.mjs`** – see 'What happens on `GET /api/state`'. Constants worth knowing: `B_DEADLINE_MS` 4 s (connecting trips, shortcut), `XFER_RESULTS` 8, `KEEP_GOOD_SEC` 600 (an answer without a trip right after a good one does not replace it for 10 min; EFA does this during closures), `BANNER_AFTER_SEC` 300. `commuteSample()` = next weekday 07:30, at least 2 h ahead. `searchTransfer()` looks in this order and stops at the first hit: now with ≤ 1 transfer → the sample morning with ≤ 1 → now with ≤ 2 → the sample morning with ≤ 2. A trip that has left already is never offered as a sample. The preview and the saved route use the same query and the same cache key, so they cannot disagree.
- **`server/guard.mjs`** – token buckets (defaults: per address burst 200, 3/s; per device burst 60, 1/s; searches burst 20, 0.5/s; 10 new devices per hour and address; 10 wrong invitation codes, then slowed to one per minute). `X-Forwarded-For` is trusted only from private or Tailscale peers. The invitation code is compared with `sha256` + `timingSafeEqual`; devices that already have a profile skip the check. Limits can be overridden through `cfg.limits` (tests and the screen test raise them to avoid noise).
- **`server/notifier.mjs`** – decides which incidents become notifications (see 'Stores and push'). **`server/fcm.mjs`** – Firebase HTTP v1 without a library (service-account JWT signed with RS256 through `node:crypto`); sends only a data message `{n: '1'}` with high priority and a 1 h TTL; returns `'ok' | 'gone' | 'error' | 'off'`; the key comes from `REGO_FCM_KEY` (JSON) or `<dataDir>/fcm.json`.
- **`server/lib/`** – `time.mjs` (`TZ = Europe/Berlin`; `berlin(ms)`, `fromBerlin(date, time)`, `hhmm`, `weekday`, `shortDate`, `toMin`), `geo.mjs` (`distanceKm`, `regionOf(stop)` → `'AT' | 'BY' | 'DE'` from the stop ID and bounding boxes), `lines.mjs` (line label and colour: product colours, Munich U-Bahn colours), `version.mjs` (`cleanVersion`, `isNewer`).

## Domain rules (`server/domain/`)

- **`window.mjs`** – the commute window. Constants: `WINDOW_DEFAULT_LEN` 60 min (routes that only know `departAfter`), `WINDOW_MIN_LEN` 10, `ANCHOR_LEAD_MIN` 180 (show the window's trains up to 3 h ahead), `PUSH_LEAD_MIN` 60 and `PUSH_TAIL_MIN` 10 (push from one hour before the window until 10 min after it), `FAR_MIN` 45 (a departure further away is "planmäßig"). `windowState(schedule, nowMs)` → `{mode, anchor, endMs}` with `mode` = `now` (the window is running), `soon` (it begins later today), `done` (it was earlier today) or `off` (not a commute day for this route, or no times known); `anchor` is the start of the window when it is at most 3 h away (then the trains of the window are requested), `endMs` the end of today's window. `windowView` is what goes to the UI (`schedule` with a complete `departUntil`, and `window: {from, until, mode}`); `pushActive` and `pushAtNight` gate notifications; a route without known times may always push but stays quiet at night.
- **`state.mjs`** – `buildTour` for direct routes, the shared pieces (`okState`, `okView`, `THEME`, `severityOf`, `appLinkFor`, `ticketHintFor`), `stillVisible`. A departure list shows at most 3 trips that have not left (2 min grace), sorted by actual departure; cancelled trips become one `cancelled` incident per line (next 3 h, at most 2 lines); a delay incident exists from `incidentMinDelay` (3) minutes; a platform change within 45 min is its own quiet incident (at most 2, never twice with the delay of the same trip); remarks are classified into replacement transport and construction (`classify.mjs`: German regexes such as `ersatzverkehr|schienenersatz|SEV|ersatzbus` and `baustell|bauarbeit|langsamfahr|gleisarbeit|streckensperr`). Without an incident the route gets the "all fine" view.
- **Incident IDs** are stable: `i` + the first 8 hex characters of a SHA-1 over the route ID and the identifying details (kind, line, day, planned time). The ID survives changing numbers (a delay growing from +6 to +9 is the same incident) and changes for another day or another train. The notifier, the app's deep links and "behoben" depend on that.
- **Severity:** replacement and cancellation 3; construction 1 (2 from 10 min); platform 1; delay 1 / 2 (≥ 5) / 3 (≥ 10).
- **`transfer.mjs`** – routes with one transfer. For every departure the builder picks feeder, transfer station and connecting trip anew (`transferVias`), loads the connecting trips at the transfer station (`bLists`) and rates the transfer itself, because the source only returns connections that still work in real time. `MAX_WAIT_MIN` 30 (longer planned waits are not shown unless nothing else exists), `TIGHT_MIN` 3 (less buffer = "Anschluss wackelt"), minimum transfer time estimated 2–6 min (default 4), `SHOWN` 3 departures, at most 2 connection incidents per route. States per departure: ok, tight (`tight`), missed (`missed`, with the next connection), connecting trip cancelled; replacement transport on the feeder keeps the connection as long as the stated extra time fits. `previewRoute` makes the sample for the creation preview; `shortcutFor` implements "Schneller mit 1 Umstieg" (`SHORTCUT_MIN_SAVING` 5 min, the detour may leave up to 30 min later, at least 3 min to change, nothing cancelled, no replacement transport on the detour).
- **`chain.mjs`** – up to two transfers (`MAX_CHAIN` 3 trips). Simpler rating: it takes the trips the source suggests and rates every transfer on its own (ok / tight when the trip before is late and the buffer is under 3 min / missed). `hasStart(journeys, now, max)` answers "is there a trip still to come": not gone yet (2 min grace), the first trip not cancelled, and no more than `max` trips in the chain. A route stores `transfers: 1` either way ("with transfers"); two transfers only show while nothing with one is left.
- **`map.mjs`** – the schematic line map of the detail page: up to 7 stops sampled from the trip (`sampleStops`, must-keep stops first), `shortName()` drops the place before the comma, `buildMap` returns `{stations, hubIndex, haloIndex, connections, disrupted, alternative}` plus, for routes with transfers, `legs` (one per trip), `transfer` (one transfer) or `changes` (two), and `skips` / `hidden`. `hidden` is the exact number of omitted stops between two neighbours; `skips` is the older form (only 2 or more). The UI may drop further stops to fit the width and folds them into the "+N" (`ui.md`, 'The screens').

## What "honest" means in the data

- A departure carries `rt` (real-time data present). "pünktlich" needs `rt` and a departure within 45 min; otherwise `okState()` says "planmäßig" (`far: true`), and a near departure without real-time data is `noRt: true` (neutral look, "Ohne Echtzeit · … Verspätungen unbekannt"). With a transfer every trip needs `rt`. A known delay is always shown.
- A route without a usable departure never says "pünktlich": `noDeparturesView` says "Keine Daten" (source down), "Fällt aus" (cancelled) or "Keine" (no direct connection).
- Old data is labelled: `stale: true` on the route, `connection.status 'error'` when it is more than 5 min old, `lastSync` shows the time of the data.
- A source that cannot say whether a connection with two transfers exists leads to "Keine Daten", never to "no connection" (`found: null`).
- `THEME` (colours, labels, icons per incident kind) exists twice – in `server/domain/state.mjs` and in `public/js/rego-live.js`. Both must stay identical; a test guards it.

## Stores and push

- **Profile** (`store/profile.mjs`): one JSON file per device in `<data>/profiles/<deviceId>.json`, written atomically (temp file + rename) behind a per-device lock chain. A corrupt file is moved aside as `.corrupt-<timestamp>` and the device starts fresh. Shape:
  ```
  { tours: [{ id: 't' + 8 hex, name, from: {id, name, lat?, lon?}, to: {…}, active, period: 'am'|'pm',
              schedule: {days: ['Mo'…], departAfter: 'HH:MM', departUntil: 'HH:MM'},
              returnOf?, returnId?, transfers?: 1 }],
    settings: { pushThresholdMin: 3|5|10, delayGraceMin: 10 },
    push: null | { native: true, fcm?: <token> },
    app?: <last app version>, lastSeen, updatedAt,
    notified, shownDelay, goneCount, outbox }      // notifier bookkeeping
  ```
  At most 20 tours per device and 2000 profiles; profiles unseen for 180 days are purged. `addTours` validates (stops need ID and name, start ≠ destination), is idempotent for the same stops and schedule (double taps), switches an existing route without a transfer to `transfers: 1` when the user now creates it with one, creates a linked pair for `roundTrip`, and links a single new route that runs a saved route backwards to it as its return trip (stop ID or name, only while that route has no return trip; the first match wins). `replaceProfile` (the app's undo) takes only known fields and leaves settings and the push subscription untouched.
- **Cache** (`store/cache.mjs`, `TtlCache`): `get(key, ttl, fn, {maxStaleSec})` shares concurrent calls, serves stale data when the source fails (up to `maxStaleSec`), leaves a key alone after a failure (10 s, doubling up to 60 s), holds at most 1500 entries; `peek(key)` is used for deadline fallbacks.
- **Notifier** (`notifier.mjs`): every `notifyEverySec` (60) it runs through all profiles with push on. Per device it calls `getState(…, {background: true})` (routes that cannot push right now are refreshed only every 10 min), then:
  - *relevant*: a delay from the device's threshold; every other kind while `validity.activeNow`.
  - *fresh* = relevant, not yet in `notified`, and the route is in its push period (`pushActive`); *updates* = a known incident whose number changed (`changeOf`: delay minutes, count of cancellations, platform) – sent silently; *cleared* = an incident missing for 2 passes in a row (`GONE_TICKS`) → the app rewrites the notification to "behoben".
  - Night quiet 23:00–04:00 Berlin, except for routes whose push period reaches into the night (a departure at 04:20 pushes from 03:20); at night only such routes are looked at and nothing else is touched.
  - Routes with stale data produce no new notifications and nothing is judged as gone.
  - Bookkeeping stays in the profile (`notified` is kept 3 days or while the incident exists; the outbox holds at most 20 entries). If Firebase delivery fails (`'error'`) the bookkeeping is rolled back so the next pass tries again.
  - The notification texts are built in `textFor()`; each entry has `tag: 'inc|<incidentId>'`, `kind`, `line`, `url: '/Detail#<id>-m'`, `update?`, `clear?`. The app polls `GET /api/notifications` (empties the outbox) after a nudge or every ~15 min.

## Changing the API or the state

- Additive, optional fields. Keep old fields while an old app can exist: `rows` is kept for old UIs, `skips` stays next to `hidden`, `pushWindow` is accepted and ignored. Never repurpose a field.
- The UI must cope when a new field is missing (an old server) and the server must cope when an old app does not send a new parameter: both directions have to work (the compatibility rule is in `release-and-addon.md`).
- Profiles on disk must keep loading: new profile fields are optional with a default, existing keys are never renamed.
- Update `BACKEND.md` (API table, state description) and the `**API**` block of the changelog entry; test the new and the old shape.

## Adding an incident kind or a notification

`THEME` in **both** places (`server/domain/state.mjs`, `public/js/rego-live.js`; a test compares them), `severityOf`, the classification (`classify.mjs`), the notifier (relevance, `textFor`), the channel in `PollWorker.channelFor` (a new kind may need a new channel with a new ID; never rename an existing one, see `android.md`), dark-mode colours in every screen that shows it (`ui.md`), the table in `BACKEND.md`, tests in `features`/`push`, and a block in the screen test.

## Decisions and their reasons

Mostly from `rego/CHANGELOG.md`, where the version numbers lead to the full story. Do not reverse any of these without Korbi.

- *One transfer first, two only as a fallback* (0.8.8): only when a closure leaves nothing with at most one transfer. A route stores `transfers: 1` either way ("with transfers").
- *ReGo finds routes with a transfer; the user does not switch them on* (0.7.0, 0.8.6, 0.8.7). A pair of stops without a direct connection is searched by itself. A pair that nothing reaches is refused (`no-connection`). A source that does not answer never turns into "no connection": the route is created anyway, because ReGo does not guess. The app side is in `ui.md`.
- *The return trip is a route of its own* (0.8.6); the server can still create a linked pair (`roundTrip`), and since 0.8.13 it links a new route that runs a saved one backwards (the app recognises it through `ends` on every route of the state and suggests the times). "Hinweg"/"Rückweg" are shown only for real pairs (0.1.35), and the same disruption in both directions is one card.
- *Push only around the commute* (0.7.2): from one hour before the window until 10 minutes after it, on its days, so that a push means "this matters for the trip you are about to take". Night quiet 23:00–04:00 with an exception for early commutes (0.7.3).
- *Cancellations and platform changes are incidents of their own* (0.6.0). The platform change is quiet. "Anschluss wackelt" and "verpasst" push while current, whatever the threshold; a "wackelt" that becomes "verpasst" is a new incident.
- *Honest data* (0.5.1, 0.8.0): no "pünktlich" without real-time data, a route without a departure says why, old data is labelled. The banner "Server offline" appears only for a complete outage or when shown data is older than 5 minutes (0.8.1, 0.8.3).
- *A good answer is not replaced by an empty one right after it* (0.8.3): for 10 minutes the trips of the last good answer that have not left yet are kept; EFA answers like this during closures.
- *The window decides what is shown* (0.7.2): up to 3 hours before the window its trains are shown; a departure beyond 45 minutes is "planmäßig".
- *Incident IDs are stable* (a hash of the route and the identifying details, 0.5.0): a growing delay updates its notification instead of sending a new one, and a new day is a new incident.
- *Small on purpose* (0.6.0): rate limits per address and per device, at most 10 new devices per hour and address, an optional invitation code, 64 KB request bodies. The load on the sources is in `sources.md`.
- *The nudge is empty* (0.3.1): Firebase carries `{n: '1'}` and the app fetches the text from ReGo, so no message content reaches Google.

## Traps

- **Time.** Always `server/lib/time.mjs` (Europe/Berlin), always injectable. CI runs in UTC. The changeover days (last Sunday of March and October) are tested for the time conversion (`domain.test.mjs`); departure times, commute windows and push around such a night are worth a look afterwards.
- **`found: null` means "the source does not know right now".** Never turn it into `false` / "no connection".
- **The preview and the saved route must use the same query and the same cache key** (`…:t1`, fallback `…:t2`); otherwise "Gefunden" can turn into "Keine Verbindung".
- **Stale and cached data.** The state of a route can come from the cache, from the last good answer (10 min) or be stale (up to 30 min); `stale: true` and `connection.status` carry that to the UI. When you build something that asks a source, decide which case applies and how the UI says so.
- **Profiles on disk are the only server state that matters.** They live on the Pi, survive add-on updates and must stay loadable by every future version (optional fields, defaults, never rename). Uninstalling the add-on deletes them and the Tailscale login: never suggest it as a fix.
- **Logs are German and free of personal data.** Log lines start with the Berlin time, the first one names the version. Do not add log lines that tie a device to its stops or routes, and never log tickets or tokens (the verbose search line shows the typed query, without any device). Verbose logging only with `REGO_VERBOSE`.
- **The real limits are strict** (stop search: burst 20, then one request per 2 s), but the tests lift them, so a too-chatty UI or job passes the tests and fails on the phone.
- **Notification tags** are `inc|<incidentId>`: changing how incident IDs are built silently re-sends everything.
- **The mock provider is shared** by the demo, the unit tests and the screen test (`sources.md`, `tests.md`).
