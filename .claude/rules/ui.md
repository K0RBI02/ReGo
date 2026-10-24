---
paths:
  - "public/**"
  - "scripts/ui-smoke.mjs"
---

# Web UI (`public/`)

Loaded when you work on the UI or the screen test.

There is no framework and no build step. The same files are served by the server (browser, screen test), bundled into the APK (`android/app/build.gradle` copies `public/` except `js/native-config.js`, `.well-known/**` and `status.html`) and driven by tests. Vanilla JavaScript, inline styles in the markup, one tiny runtime.

## How a screen works (`js/dc-lite.js`)

A screen is `public/screens/<Name>.dc.html`:

```html
<x-dc>
  <helmet><style>…screen CSS, dark-mode rules, keyframes…</style></helmet>
  <div style="…">  …markup with {{path}} holes, <sc-if value="{{x}}">, <sc-for list="{{xs}}" as="x">… </div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":390,"height":844}}'>
class Component extends DCLogic {
  constructor(props) { super(props); this.state = {…}; }
  renderVals() { return { …everything the template reads… }; }
}
</script>
```

- Templates can only **look up paths** (`a.b.c`, plus the literals `true`/`false`); there are no expressions, comparisons or filters. Compute everything – including whole `style` strings, labels and the handlers – in `renderVals()`. Inside `<sc-for>` the loop variable and `index` are in scope.
- Handlers are attributes `onClick`, `onInput`, `onChange`, `onKeyDown`, `onFocus`, `onBlur`, `onPointerDown` whose value is `{{fn}}`; they are assigned as element properties. Attributes starting with `hint-` are dropped.
- `this.setState(patch | fn)` re-renders. Hooks the runtime calls if defined: `onData()` after every `REGO` refresh, `onHash(hash)` when only the anchor changed while the page stays (the router does not rebuild it, so inputs and scroll survive), `onDestroy()`.
- Every update builds the template into fresh nodes and `morph()` patches the live DOM: focus, cursor and scroll position are kept, and an input that has focus keeps what the user typed. Inline `style` attributes go through `el.style.cssText`, so the browser **rewrites colours to `rgb(…)`**; the dark-mode CSS relies on exactly that (see 'Styling rules').
- Screens are fetched from `/screens/<Name>.dc.html` once and cached; the component class is created with `new Function` (hence `unsafe-eval` in the CSP). Links like `href="Detail.dc.html#t1a2b3c4-m"` are intercepted by `app.js` and routed to `/Detail#t1a2b3c4-m`.
- The `.dc.html` structure (the `<x-dc>` root, `<helmet>`, a `DCLogic` component, the `$preview` props, `<script src="./support.js">` in the head) comes from the visual design the screens started in. Keep the structure when editing; do not "clean it up".

## Shell and router (`index.html`, `js/app.js`)

- `index.html` loads, in this order: `native-config.js`, `rlog.js`, `dc-lite.js`, `ticketcode.js`, `barcode-read.js`, `scan-client.js`, `rego-live.js`, `report.js`, `app.js`. Its CSS holds the chrome: `#app` (fixed, max 520 px wide, centred), the floating dock (`.rg-dock`, only the buttons are tappable), the header and scroll-fade helpers (`.rg-top`, `.rg-under`, `.rg-dockpad`, `.rg-scrolled`), the invitation gate, the commute-time slider (`.rg-dual`, two stacked range inputs whose own thumbs are invisible and only catch taps, with drawn knobs next to them).
- Paths: `/` (Main, or Onboarding1 when there is no route and onboarding is not done), `/Meldungen`, `/Detail#…`, `/Strecken`, `/Ticket`, `/Scan`, `/Onboarding1`–`3`. Unknown paths go to Main. Pages are mounted one after the other (`show()` with a token) so a slow older page can never overwrite a newer one.
- **Hash conventions:** `Detail#<tourId>-m`, `Detail#<tourId>.<n>-m` (the n-th departure of the route), `Detail#<incidentId>-m` (old links and push notifications), `Detail#<tourId>-l-<incidentId>` when opened from the incident list (`-m` = came from the main screen, `-l` = from the list; the tapped incident moves to the top); `Strecken#neu` opens the new-route form (Android shortcut), `Strecken#einstellungen` the settings sheet (its own history entry, so Back closes it first; the router calls `onHash`), `Scan#einrichtung-<dt|kt|other>` is setup step 2 (type preselected; after saving the setup goes on with step 3), `Ticket#neu` shows the "Ticket hinzugefügt" toast.
- **End of onboarding:** when navigating to Main with `REGO_pending` set and no route yet, `app.js` creates the first route (weekdays, the chosen times); on a `no-direct` refusal it runs the transfer search and saves the route with `transfers: 1` right away when something is found (nobody confirms a preview during setup).
- **Overlays:** the invitation gate (`R.invite.needed`), the full-screen "Sorry!" outage message (`R.outage`; not on Ticket, Scan or Onboarding, the ticket safe must always work), the beta splash (first start only, 3 s, tap closes).
- **Bars:** `syncBars()` paints page background, `theme-color` and (in the app) status and navigation bar from the first screen element's computed colour; `data-bar="top"` marks a top surface with its own colour (the card on the detail page). After every refresh the colour is re-synced because the detail page changes colour with the state.
- Location: used only when already allowed (no dialog at start), rounded to 2 decimals (~1 km), cached for 12 h, refreshed when the app opens; it only orders the routes by distance. Refresh runs every 30 s while visible and on `online`/visibility change.

## The data layer (`js/rego-live.js`, `window.REGO`)

The single object every screen reads. Fields: `tours`, `incidents`, `lines` (a Proxy that invents a grey line for unknown IDs), `settings`, `clock`, `connection {status: 'ok'|'offline'|'error', loading, lastSync}`, `theme`, `tickets`, `stations`, `info {app, server}`, `invite`, `outage`, `position`, `contact`, `app` (update hint), `deviceId`.

- `api(path, opts)` adds `x-device` and `x-invite` (URL-encoded), a 30 s timeout, and writes failures to the error log (`net`, `server`; never the query string). Errors carry `status`, `code`, `invite`.
- `refresh()` is single-flight: a call during a running one queues exactly one more round. `refreshOnce()` fetches `/state?lat&lon&app`, falls back to the cached state (`rego.state`, at most 6 h old) when the server is unreachable, and sets `outage` when there is nothing to show. A state with `connection.status === 'error'` is shown from the cache only if the cache knows all current routes and has departures (otherwise freshly created routes would vanish).
- Routes without any departure get `NONE_VIEW` so a screen never shows "pünktlich" for them.
- `actions`: `addTour`, `searchTransfer`, `probe`, `setActive`, `updateTour`, `removeTour` + `undoRemove` (remembers `GET /profile` first), ticket functions (`saveTicket`, `removeTicket`, `exportTickets`, `importTickets`, `ticketExpired`), `setThreshold`, `transferCode`, `claimTransfer`, `enablePush`, `disablePush`, `testPush`. `addTour` is double-tap safe (one request in flight).
- `makeProbe(onChange)` is the controller for "look at the chosen stops": when both stops are real stations it asks `/connections/search` (debounced for typed names), and exposes `view()` (`direct`, `transfer {route}`, `none {max}`, `sorry`, `busy`). Both the new-route form and setup step 1 use it. An older server that cannot say whether a direct connection exists yields `unknown` and the screens then show nothing.
- Stations: `searchStations(q)` answers from the local cache (last 400 stations in `rego.stations`) and asks the server after 450 ms; ordering prefers exact names and stations.
- `meldungen()` is the list shown under "Meldungen" and counted on the button: active routes only, visible incidents only, the same incident on outward and return trip merged into one card (`both`).
- `win` builds the commute-time slider values (`of`, `fresh('out'|'back')`, `view(w, set, opts)`, `text`): the track covers eight hours (04–12 for a start before noon, otherwise 12–20, longer if the period lies outside), steps of 30 min, handles at least 10 min apart; typed times in the time fields can be exact and widen the track.
- Small helpers: `shortRoute` (drops a doubled place: "Freising, Freising" → "Freising"), `feedback()` (mailto with prepared body, or the link, or the GitHub issue form; contains app and server version, never the device ID), update hint (`updateHint`, `updateBar`, `dismissUpdate`), `loadInfo`, `banner()`.

## What is stored on the phone

| Key | Content |
|---|---|
| `rego.device` | the random device ID (24 chars) |
| `rego.tickets` | the tickets (name, validity, code image as data URL, optional original photo, payload, format) |
| `rego.state` | last state `{state, at, ts}` (6 h) |
| `rego.stations` | station cache (400) |
| `rego.invite` | invitation code the user entered |
| `rego.contact` | feedback address the server sent |
| `rego.push` | push switched on in the app |
| `rego.updateSeen` | app version for which the update bar was closed |
| `rego.errors` | error log (30 messages, 14 days) |
| `rego.onboarded`, `rego.splashSeen`, `rego.pos`, `rego.posAsked` | flags and the rounded location |
| sessionStorage `rego.log` | run log of this session (for the error report) |

All reads and writes are wrapped in try/catch; the app must work with storage blocked or full (saving a ticket then fails with a readable message and rolls back). The Android app is excluded from Android backups on purpose, so these keys exist on exactly one device.

## The screens

- **Main** – top: update bar, offline bar ("Offline-Modus | Stand: hh:mm", or "Server offline" when data is more than 5 min old). Hero card of the route that is most relevant (client-side order: window running → window later today → nearest, with the time of day deciding at equal distance) in the colour of its worst active incident, big line sized to the width (34–58 px) so the icon never slips below; up to three departures, each tappable (`Detail#<tour>.<n>-m`); for transfer routes the line chips are joined with chevrons, "an HH:MM" and a transfer line in a pill (orange when tight, red when missed); with two transfers the three chips get a row of their own. Other routes are white cards with a short state. Bottom dock: Meldungen (badge), Strecken, Ticket. Empty state offers "Strecke hinzufügen"; a failed first route shows its reason.
- **Meldungen** – one card per incident, pastel in the incident's colour, "beide Richtungen" when merged; sorted by distance, then severity.
- **Detail** – one page per route: card on top in the state colour (status bar takes that colour), big line, the trips as sections ("1. Fahrt", transfer card with platform → platform and minutes, "2. Fahrt"), "Danach" / "Nächste Verbindung" / "Stattdessen" card (tappable to that departure), the "Schneller mit 1 Umstieg" card, ticket hint for cross-border routes, a link to the official app, and the **schematic line map** (see below). More incidents of the route are listed below the first. A vanished incident shows "Beendet", a switched-off route "Pausiert".
  - *The map:* the server sends up to 7 stops with `hidden` counts; `_fit()` in `Detail.dc.html` measures the stop names and the width and keeps only as many stops as fit cleanly (start, destination, transfer stops and every stop the map points at always stay); omissions are drawn as a break in the line with two dots and the number. Names are rotated by 45° and need room to the right (a right margin that grows with the longest name).
- **Strecken** – the list of routes (line chips, "Mo–Fr · 07:00–08:00", an "An/Aus" switch inside the switch, "ändern", remove with undo toast), the form to add or change a route (stop fields with suggestions, the live look at the pair of stops, one "Aktivitätszeit" slider card, weekday chips), and the **settings sheet**: push on/off, delay threshold 3/5/10, test notification, "Neues Handy?" (create or enter a code), "Rückmeldung senden", "Fehlerbericht speichern", version line (app + server), links to privacy and GitHub. The sheet can be pulled down with a finger.
- **Ticket** – two big tabs (Deutschlandticket, KlimaTicket) plus a list of further tickets; shows the stored code image large on white, full brightness and screen kept on (`RegoNative.setBrightness/keepScreenOn`, wake lock in a browser); "Originalfoto zeigen" toggles between the freshly drawn code and the photo; "Tickets sichern / wiederherstellen" as a file; expired tickets are marked; the safe says that the control staff decides whether a code from ReGo counts.
- **Scan** – add a ticket: camera scan or a picture; choose type, name, validity; saves the cropped code image only (and optionally the original).
- **Onboarding 1–3** – step 1 first route ("Dein Reisezeitfenster", with the live look at the stops), step 2 ticket (three buttons that open Scan with the type chosen), step 3 "Los geht's".
- **`status.html`** – the public status page (version, sources with "pausiert", devices, apps per version, push, "Sofort-Push"); numbers only, no personal data.

## Styling rules

- **Palette (fixed, from `THEME`):** all fine `#EAF6CF`; info / no data / platform change `#D4EDF6`; delay / connection at risk `#FDE3CF`; cancellation / replacement transport / connection missed `#F9D6D2`; construction `#FDF3DC`. Text `#1C1A1A`, secondary text `#4A4747`, page `#F7F7F7`, white cards `#fff`, hairlines `#E8E8E8`, focus ring `#2F6BFF`. Line badges use the line's own colour (`server/lib/lines.mjs`, by product type, with the Munich U-Bahn colours); every line colour keeps at least 4.5:1 contrast with its white text, so check that when you add one.
- **Type:** Instrument Sans, Regular for 400–500 and Bold for 600–800, shipped in `public/fonts/` (SIL OFL text included). Nothing is loaded from a third party; the CSP would block it (`font-src 'self'`). The `<link>` to Google Fonts in a screen's `<helmet>` is ignored by `dc-lite` (only its `<style>` is used).
- **Layout:** designed at 390 × 844, must hold down to 320 px width and up to 520 px (`#app` is capped there). No horizontal scroll, no text overlapping, tap targets 44–64 px, labels for screen readers (`aria-label`, `role="status"`/`"alert"`), visible focus.
- **Dark mode:** six screens (Main, Meldungen, Detail, Strecken, Ticket, Scan) carry a long block of attribute-selector rules in their `<helmet>`: `[style*="background: rgb(247, 247, 247)"]{background:#121212 !important}` and so on, inside `@media (prefers-color-scheme: dark)`. The same block exists a second time under `html.rg-dark` (a hook of the design copy; nothing in the app sets that class). **When you introduce a colour in an inline style, add its dark counterpart to both blocks of every screen that shows it, and write the colour exactly as the browser will rewrite it (`background: #FDE3CF` becomes `background: rgb(253, 227, 207)`).** The incident colours keep dark text in dark mode; SVG strokes and fills of `#1C1A1A` are flipped. The Onboarding screens are fixed pastel screens without dark rules. The status bar colour follows `syncBars()`.
- **Motion:** short fade/slide-in animations; `prefers-reduced-motion` switches them off.

## Tickets, scanning and the code image

- `ticketcode.js` (`window.RegoCode`, also `require()`-able): own QR and Aztec **encoders** (`qrEncode`, `azEncode`), `regenerate(bytes, format)` to redraw a clean, high-contrast code from decoded bytes, and `parseTicket(raw)`/`analyse` that read ticket data from the payload (type such as Deutschlandticket, validity dates; the payload can contain zlib-compressed parts that are inflated with `DecompressionStream`). No dependencies.
- `barcode-read.js` (`window.RegoRead.decode({data, width, height}, {formats, scales})` → `{format, bytes, box} | null`): own QR and Aztec **reader** (binarise adaptive/Otsu, finder patterns, Reed–Solomon), no Google Play services. `scan-worker.js` runs it in a Web Worker; `scan-client.js` (`RegoScan.decode(imageData)`) talks to the worker and falls back to the main thread.
- A saved ticket: `{id, slot: 'dt'|'kt'|null, name, validUntil: 'DD.MM.YYYY', image: dataURL (cropped, or redrawn code), original: dataURL|'', payload: string, format: string}`. The ticket file for backup is `{app: 'ReGo', version: 1, savedAt, tickets}`; import validates every field and caps sizes.
- Tickets and all of this code never touch the network.

## Error log and error report

- `rlog.js`: `RLOG(msg)` keeps a run log of the session; `RLOGE(kind, msg)` writes to the error log (`rego.errors`): kinds `js`, `net`, `server`, `quelle`, `app`; max 30 distinct messages, 14 days; the same message again counts up (`n`, first/last time) and moves to the end. `clean()` strips query strings (they carry what was typed) and long codes with digits (device ID, tokens) **before** anything is stored, and shortens to 140 characters. `window.onerror` / `unhandledrejection` feed `js` entries (the harmless `ResizeObserver loop` message is ignored).
- `report.js`: "Fehlerbericht speichern" builds one text file (`rego-fehlerbericht-YYYYMMDD-HHMM.txt`): app, server, Android and WebView versions, screen size, connection state, number of routes and tickets, the server's public status, the error log and the run log. No stops, routes, tickets, location, device model or device ID. In the app it goes through `RegoNative.saveFile` (returns whether it worked) into Download, in a browser it is a download. It waits at most 4 s for the server and is written without it if there is no connection.
- Rule: never put anything personal into either log. If you add a log call, check that the message cannot contain a stop name, a route, a ticket, a coordinate or the device ID.

## Changing the UI

Edit the `.dc.html`. German texts, informal. Check 320, 390 and 520 px wide and dark mode; every new colour gets its dark counterpart in both blocks of every screen that shows it (see 'Styling rules'). No external resources. Keep tap targets at 44 px or more and give controls an accessible name. Business rules and texts that depend on data belong in the server's state (the UI mostly renders what the server says), so that the app, the tests and older apps agree. If the screen needs a new field it must cope without it (an older server; the compatibility rule is in `release-and-addon.md`). Add a `check()` block to the screen test (`tests.md`), run it, and name the changed screens in the report to Korbi.

## Decisions and their reasons

- *One "Aktivitätszeit" per route; the return trip is a route of its own* (0.8.6). Two sliders per direction (0.7.2) made setup heavy. The server can still create a pair (`roundTrip`); the app does not offer it yet.
- *Routes with a transfer are found by ReGo, not switched on* (0.7.0, 0.8.6, 0.8.7). There is no "always with transfer" setting. The search starts as soon as both stops are chosen, the preview shows what was found, and a second tap on "Speichern" creates the route; in setup nobody can confirm a preview, so it is saved right away. A source that does not answer leaves "Speichern" working (ReGo does not guess).
- *Settings are a small sheet, not a page* (0.6.1); it keeps the list tidy and the app "easy".
- *Fixed text size and portrait only* (0.6.0): the layout shifted with the Android font size. Honouring it is an open question (`CLAUDE.md`, known gaps).
- *Tickets stay on the phone*: only in the app's storage, `allowBackup` is off, "Tickets sichern" writes a file the user controls, nothing is sent. The safe says that the control staff decides whether a code from ReGo counts. No payment, no wallet import.
- *Location is only for ordering routes by distance*: approximate permission is enough, rounded to about 1 km, kept 12 hours, asked only when already granted (no dialog at start).
- *The error report is a file the user saves and sends himself* (0.8.12). ReGo never sends it; it holds no stops, routes, tickets, location, device model or device ID.

## Traps

- **One UI, three consumers.** The same `public/` runs in a browser against the server, inside the APK and in the screen test. In the APK it is served from `https://appassets.androidplatform.net` and calls the API **cross-origin** (the address comes from `native-config.js`; in a browser it is empty = same origin). A new request header must be added to the server's CORS list (`content-type, x-device, x-invite`) or the app shows "Netzwerkfehler" while the browser works; the CORS headers also have to be on error and 429 answers (a test guards that). More in `android.md`.
- **dc-lite is small on purpose.** Templates only look up paths (no `a || b`, no `===`, no filters). Compute in `renderVals()`. When something "does not render", the cause is nearly always an expression in a template.
- **Inline styles become `rgb(…)`.** The dark mode keys on that; a colour that is written differently from how the browser serialises it gets no dark counterpart and stays bright on a dark page. The contrast scan in the screen test catches the worst cases.
- **Colours and `okState` exist twice** (`server/domain/state.mjs`, `public/js/rego-live.js`); a test compares them. Change both.
- **Widths.** Check 320 px (small phones), 390 px, 412 px and 520 px (tablets, the `#app` cap). Several releases (0.8.9, 0.8.10) were corrections of the line map at some width. Long German words ("Zugausfall", "pünktlich") and long stop names are the usual victims. Korbi notices glitches that only flash briefly.
- **Fonts and the CSP.** `default-src 'self'`: nothing is loaded from elsewhere (no web fonts, analytics or remote images). The fonts are shipped in `public/fonts/`. The screen test fails on any blocked request.
- **Storage limits.** A ticket carries a code image (and optionally the original photo) as a data URL, and `localStorage` is small. Saving catches `QuotaExceededError`, says so in plain words and rolls back; any new storage code does the same and tolerates storage being unavailable.
- **Do not hammer the search.** Never call the station search per key press without the 450 ms debounce (the real rate limits are strict, the tests lift them).
- **A bridge method may be missing.** If `MainActivity` gets a new `RegoNative` method, the UI must feature-detect it (`window.RegoNative && RegoNative.x`): an older APK does not have it.
- **Logs.** The file name of a script error loses its `?v=…` before `clean()` runs so that the line number survives. Anything added to the error log or the report must be checked against "no stops, routes, tickets, location, device model, device ID" (see 'Error log and error report').
- **Interaction details that were bugs once** (0.5.0): a route created while a refresh was running got lost (refresh is single-flight and queued); a double tap created a route twice (the button says "Speichert …", the server is idempotent for the same stops and times); when saving, removing, undoing or toggling fails the display must jump back; the Android bars must follow the page colour; nothing may flash green at start.
