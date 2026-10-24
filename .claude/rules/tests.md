---
paths:
  - "test/**"
  - "scripts/**"
---

# Tests

Loaded when you work on tests or scripts. Two layers: fast offline tests of the server and of the browser scripts, and a slow screen test that drives the real UI in a browser. Both have to be green before a push; CI runs both again.

## Unit and API tests (`npm test`)

`npm test` is `node --test`: it runs every `test/*.test.mjs`. Currently 219 tests in 17 files, about 25 seconds, completely offline, and it needs no `npm install` (`hafas-client` is imported lazily by the real ÖBB client only). CI runs it on Node 22 in UTC.

| File | What it guards |
|---|---|
| `domain.test.mjs` | remark classification, region by stop ID, Berlin time (incl. the day the clocks change), map sampling, cache, profile store, a first end-to-end run on the mock provider, recorded real responses, "New phone" codes, departure list order |
| `robust.test.mjs` | invalid request bodies (400, never a crash), double taps, route limits, undo, damaged profile files, deadlines when a source hangs, the "no departure" view (never "pünktlich"), push isolation between routes |
| `realtime.test.mjs` | the `rt` flag per source, `okState` ("pünktlich" only with real-time data), the neutral "Ohne Echtzeit" look, transfers needing real time on both trips |
| `window.test.mjs` | commute window: end, modes over the day, push period, night exception, route order, creating and changing routes with times |
| `transfer.test.mjs` | one transfer: sections, states (on time, tight, missed, connecting trip cancelled, replacement on the feeder), stable incident IDs, `hidden` counts on the map |
| `chain.test.mjs` | up to two transfers: sections, map names, tight/missed/cancelled, replacement, delay wording |
| `shortcut.test.mjs` | "Schneller mit 1 Umstieg": what counts as safe, when it stays silent |
| `closure.test.mjs` | EFA during closures (plain query, `limit`, fewest transfers, remembering what worked), preview and saved route seeing the same trips, the sample morning |
| `efa.test.mjs` | EFA client: stop search, connections, remarks, HTML to text, request dates in Berlin time, retries |
| `limits.test.mjs` | source pause (`Retry-After`), at most three parallel EFA requests, pause for transport.rest, translation when a source does not answer |
| `backup.test.mjs` | stop-name matching, strict translation, ÖBB then DB when an association is down, shared searches |
| `push.test.mjs` | relevance and texts, once per incident, silent updates, "behoben", Firebase failure and retry, test notification |
| `features.test.mjs` | cancellations, platform changes, colours (server and app agree), version agreement, no route without a direct connection, rate limits, invitation code, CORS headers on 429 answers |
| `beta.test.mjs` | feedback address, version comparison, `APP_LATEST`, update hint, what the public status page shows, noting the app version |
| `errorlog.test.mjs` | error log (counting, limits, no personal data), error report, saving into Download (runs `rlog.js`/`report.js` in `node:vm`) |
| `ticketcode.test.mjs`, `barcode-read.test.mjs` | the QR/Aztec encoder and the own reader |

**How a test is built.** The real server runs inside the test: `createApp({ cfg: { ...config, provider: 'mock', dataDir: <temporary directory>, notifyEverySec: 0, limits: {…} }, now: () => fixedMs })`, `server.listen(0)`, requests by `fetch` with an `X-Device` header. Pure functions (`windowState`, `buildTour`, `okState`, …) are called directly. **Time is always injected** and the tests use fixed dates; never read the real clock. Source clients are given a fake `fetch` that answers from `test/fixtures/` or from small hand-made objects. Browser scripts without dependencies (`ticketcode.js`, `barcode-read.js`) can be `require()`d; `rlog.js` and `report.js` run in `node:vm` with a small stand-in for `window`/`localStorage`. Objects created inside the `vm` context have another `Array` prototype, so compare them with the `plain()` helper (JSON round trip) or `assert.deepEqual` fails on equal arrays.

**Fixtures** (`test/fixtures/*.json`: DB and ÖBB journeys/locations/stop, EFA stops and trip) are real responses recorded with `scripts/probe.mjs`. That script talks to the real sources: a human runs it rarely, after `npm install`, never from CI or in a loop (rule 13 in `CLAUDE.md`).

**Writing tests.** A test name is a sentence that states the behaviour ("Connection missed: the next connection is shown, incident with the highest urgency"). For a bug Korbi reports, write the failing test first. A test that needs special data builds it inline; it does not edit the mock provider (many tests and the screen test share its data).

## The screen test (`scripts/ui-smoke.mjs`)

It starts the real server (mock provider, rate limits lifted, temporary data directory) and drives the real UI in headless Chromium through Playwright, in phone size (390 × 844, touch). It first opens six screens (`/`, `/Meldungen`, `/Strecken`, `/Ticket`, `/Scan`, `/Onboarding1`) and fails on any JavaScript error, console error, failed request, HTTP status ≥ 400 (a blocked resource shows up here), sideways scrolling or empty page. Then come 34 blocks written as `check('<name>', async () => { … })`, each a flow: double tap on "Speichern", commute-time sliders, undo, refresh while creating, "Neues Handy?", a 320 px phone, dark mode (including a contrast scan), several incidents on one route, creating with one or two transfers, live search while typing stops, the transfer and chain views, "Schneller mit 1 Umstieg", missing real-time data, tickets, update hint and feedback, the settings sheet, the error report, long names and the line map at several widths. Findings are collected and printed at the end; the exit code is 1 if there are any.

- **Setup:** Playwright is not a dependency: `npm install --no-save playwright && npx playwright install chromium` (CI does exactly this). With a Chromium that already exists, set `PW_CHROMIUM=/path/to/chromium`. A full run takes several minutes.
- **While iterating:** `SMOKE_ONLY='<part of a check name>' node scripts/ui-smoke.mjs` runs only the matching blocks. Run the whole test before you push.
- **When:** whenever anything under `public/` changes, and when the server changes something the UI reads. Add a `check()` block for every new behaviour of the UI; that is where 320 px, dark mode and "does it really work with a finger" are proven. Helpers: `suggest(n, text)` types into the n-th stop field and picks the first suggestion, `j(path, method, body)` calls the API as the test device, `st` / `mu` are the sample stops Freising and München.
- **Fragile by nature:** the test looks for German texts and depends on the mock data. If you change a visible text, search the test for it and update it in the same commit. Playwright dismisses `confirm()` dialogs unless a handler accepts them; removing a ticket asks with `window.confirm`, so a check that removes tickets has to accept the dialog.

## Shared data and history

- `provider: 'mock'` serves the demo, the unit tests and the screen test (stops, lines, the pair with two transfers; see 'Mock' in `sources.md`). Change it knowingly and run everything; a test that needs special data builds it inline.
- The screen test had dropped out of the CI flow unnoticed between 0.3.0 and 0.5.0. The `build` job in `build.yml` needs both `test` and `screen-test`; keep it that way.
