---
paths:
  - "server/providers/**"
  - "scripts/probe.mjs"
  - "test/fixtures/**"
  - "test/efa.test.mjs"
  - "test/limits.test.mjs"
  - "test/backup.test.mjs"
  - "test/closure.test.mjs"
---

# Timetable sources (`server/providers/`)

Loaded when you work on the sources. `BACKEND.md` explains the behaviour for users; this is the how.

## How the sources work

- **Clients:** `EfaClient` (`efa.mjs`; MVV and MoBY are EFA services speaking `rapidJSON`), `HafasClient` (`hafas.mjs`; the transport.rest HTTP API for DB and ÖBB), `createOebbClient` (`lib.mjs`; the `hafas-client` library, imported lazily so tests and CI work without `npm install`), and `mockFetch` (`mock.mjs`). All return the same normalised journey/leg shape (`dep`, `plannedDep`, `depDelay`, `platform`, `rt`, `remarks`, `line`, `product` …), so the domain code never knows which source it talks to. Normalisers set `rt` (real-time data present) – `departureDelay != null` for HAFAS, "estimated time or monitored" for EFA.
- **Choosing a source** (`build()` in `index.mjs`): the association if both stops belong to the same one; two associations (MVV + MoBY) → MoBY, the MVV stop is translated; one stop in an association and the other elsewhere → ÖBB if either end is in Austria, otherwise DB, the association's stop is translated; no association → ÖBB if either end is in Austria, otherwise DB. Stop IDs carry their origin (`moby|…`, `mvv|…`, DB IDs, ÖBB IDs); `regionOf()` derives AT/BY/DE from the ID or the coordinates.
- **Translation between sources** (`createTranslator`): by name and position. *Strict* mode (used when ReGo steps in for a closed association) needs coordinates, accepts a hit only within 600 m with a plausible name (`spotMatch`: what is special in the original name must be in the other, the other adds nothing but its place), and remembers a refused stop for 15 minutes. A source that is down says nothing about a stop: its error is passed on instead of claiming the stop does not exist.
- **Backup** (`withBackup`): if an association is down (timeout, HTTP 429/401/403/5xx, paused), ÖBB then DB answer with strictly translated stops; DB only if ÖBB fails; an answer without trips from the railway ends the search and the association's error stays (it names the closed source). An association that answers but does not know the route is not replaced. The log says once when a backup takes over and once when the association is back.
- **Pause** (`pause.mjs`, `SourcePause`): on HTTP 429 the source is left alone for `Retry-After` (up to 24 h) or 60 s doubling to 30 min; afterwards a single test request. `/api/status` shows `pausedSec`. A restart of the process clears it. Each EFA source takes at most 3 requests at once.
- **EFA quirks:** the associations apply "max. 1 transfer" only after choosing their best few trips, so during closures a plain query can return nothing or only trips that have left. `EfaClient` therefore has "stronger" variants of the query (`limit`: `ptOptionsActive=1` puts the limit inside the search and `calcOneDirection=1` keeps EFA from adding trips that have left; `lean`, only for transfer queries: additionally `routeType=LEASTINTERCHANGE`), asked when the plain answer has no usable trip; a variant that worked is asked first for 10 min, one that did not help is left alone for 5 min; the log notes what each returned (at most once per 10 min).
- **Station search** (`build().search`): asks all healthy sources in parallel; the railway sources only after the associations, only from 4 characters and only if no association has an exact hit (otherwise every key press would drive bahn.de into timeouts); once one source answers, the others get 2.2 s more (`GRACE_MS`); results are merged (a stop within 300 m with a related name is the same stop, the association's entry wins) and ranked (`rankOf`: exact names and stations first). Incomplete results (`list.partial`) are not cached. Special case: "Lindau Hbf" is called "Lindau (Bodensee) Insel" by the sources, so `RENAME` pins and renames it.
- **Mock** (`provider: 'mock'`): stops Fiktivia, München, Rosenheim, Salzburg …; routes S1, RE 2, RE 5 (its first trips carry replacement transport and a delay on purpose), RJX 61, RE 1, S4, U5, and a two-transfer pair Fiktivia → München-Neuperlach Süd. The tests and the screen test depend on this data: change it knowingly and run everything.

## Decisions and their reasons

- *Associations first.* MVV and MoBY (both EFA) are the primary sources in their regions. The first was added in 0.1.14 to get around a block on the Deutsche Bahn side, all of Bavaria followed in 0.1.18; they carry the regional network (S-Bahn, buses) with real-time data. ÖBB serves Austria, Deutsche Bahn is the choice where nothing else fits.
- *Leave a complaining source alone* (0.7.4, 0.8.1). On HTTP 429 the source is not asked again for as long as it says (up to 24 hours), then a single test request decides. MoBY once answered with `Retry-After: 86400` and "not an open data endpoint". A route that has no data because of this says which source is closed.
- *Backups never guess* (0.8.2). ÖBB then DB step in for a closed association only with strictly matched stops; a bus stop is never replaced by the station next to it; what cannot be matched stays dark and says why.
- *The station search is gentle*: 450 ms after typing, the railway sources only from 4 characters and only when no association knows the name exactly (0.1.27); results are merged and ranked; "Lindau Hbf" is pinned because the sources call it "Lindau (Bodensee) Insel" (0.1.30).
- *Small on purpose.* ReGo uses unofficial interfaces and stays deliberately small; if it grew it would need the official interfaces of the operators. Korbi has put that aside for now. README and PRIVACY say so openly.
- *One runtime dependency* (`hafas-client`, imported lazily); the unused `db-vendo-client` was removed in 0.2.0.

## Quirks and traps

- bahn.de hangs over IPv6. `rego/run.sh` sets `NODE_OPTIONS=--dns-result-order=ipv4first`; a standalone start (`npm start`) does not, so set it yourself where IPv6 hangs.
- EFA applies "at most 1 transfer" only after choosing its best trips, so closures give empty or past-only answers; the stronger queries above exist for that. The preview and the saved route must use the same query and cache key.
- `found: null` means "the source does not know right now" – never `false`.
- Source texts are messy: a place before the comma in stop names ("München, München Hbf"), train-number suffixes in line names, truncated notices ("… bis Frei"), HTML in remarks, bicycle notes and line information of other routes inside the remarks. The helpers that clean this exist (`lineLabel`, `shortName`, the EFA remark filter, `shortRoute` in the UI); reuse them.
- ÖBB stops without a standard number are assigned to a country by their coordinates; Austrian routes use the ÖBB app link, cross-border ones only the ticket hint.
- DB (and the ÖBB fallback) go through transport.rest, a shared community service that has been down before. ReGo absorbs short outages (stale data up to 30 minutes, source pause) but does not replace it.
- The real sources are rate-limited and unofficial: never poll them from tests, scripts or loops (tests use the mock provider and fixtures, see `tests.md`).

## Changing a source or the source logic

Providers return the normalised journey shape and set `rt`. Test with fixtures or hand-made answers, never with the real sources (`scripts/probe.mjs` records new fixtures; a human runs it, rarely). Think about the failure paths: pause on HTTP 429, the limit of three parallel requests, strict translation, the deadline of 12 s per route, stale data. Update the "Timetable sources" part of `BACKEND.md` and the changelog.
