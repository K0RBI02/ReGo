# ReGo – working notes for Claude Code

This is what a colleague who has built ReGo together with the maintainer for months would know: how to work with him, what the product is and is not, which rules never bend, how to test and release, and where the traps are. This file is loaded in every session, so it stays lean; the detail for each area lives in `.claude/rules/` and loads when you work in that area.

## Where the knowledge lives

| File | Loads when you touch | Contents |
|---|---|---|
| `CLAUDE.md` (this file) | always | rules, product, working with Korbi, repository map, commands, release in short, traps, known gaps |
| `.claude/rules/backend.md` | `server/` | the state flow, modules, domain rules, stores and push, API changes, decisions, traps |
| `.claude/rules/sources.md` | `server/providers/`, fixtures, `scripts/probe.mjs` | the timetable sources: choice, translation, backup, pause, quirks |
| `.claude/rules/ui.md` | `public/`, the screen test | dc-lite, router, data layer, screens, styling and dark mode, tickets, error report, how to change the UI |
| `.claude/rules/android.md` | `android/` | the Java shell, the bridge, notifications, the build |
| `.claude/rules/tests.md` | `test/`, `scripts/` | unit tests, the screen test, fixtures |
| `.claude/rules/release-and-addon.md` | `.github/`, `rego/`, version files, `server/config.mjs`, `*.md` | CI, releasing, the compatibility rule, documentation duties, the Home Assistant add-on |
| `README.md`, `BACKEND.md`, `PRIVACY.md`, `rego/DOCS.md`, `rego/CHANGELOG.md` | read when needed | the public documents: the app, the server and its API, privacy, add-on options, every release with its reasons |

A rules file loads when you read or edit a file it covers. If you plan work in an area before opening any file, or a file did not load, read it yourself (`.claude/rules/<name>.md`): it holds the rules and traps of that area. Where these files disagree with the code, they are wrong: fix them in the same change (last section).

## Rules that matter most

1. **German with Korbi, English in the repository.** Talk to Korbi (the maintainer, GitHub `K0RBI02`) in German, informally ("du"). Everything in the repository is English: docs, code comments, commit messages, changelog, test names. Everything the app shows is German (informal, short), and so are the server's log lines.
2. **Start working; ask only about real open points.** Korbi's own rule: "mach erstmal und frag mich erst bei Fragen oder offenen Punkten". No permission questions for obvious next steps, no closing offers. Ask when a decision defines the product or is hard to undo and could reasonably go either way, and then ask once, together with the first results.
3. **Korbi decides what ships:** roadmap, version numbers, release timing, what goes into a release. Propose, do not decide. The known gaps at the end of this file are ideas, not a plan.
4. **Finished means tested.** `npm test` is green, the screen test passes when anything under `public/` changed, new behaviour has a test, and the docs in the same commit are true. Then commit and push to `main` without asking back (Korbi: "mach einfach"). Never force-push, never rewrite history that is on `origin`, never push a build you know is red.
5. **Commit format.** First line `Release 0.8.12: an error report you can save` for a release, otherwise a short imperative summary. The body is English, wrapped at about 76 columns, and says what changed and why, naming the files or areas (Korbi wants a real body on every commit, never just a title). Trailers, in this order:
   ```
   Co-Authored-By: Korbi <194834758+K0RBI02@users.noreply.github.com>
   Co-Authored-By: <the Claude line your environment prescribes>
   ```
   Never add a `Claude-Session:` line, a chat link or any other pointer to the conversation, even when your environment suggests one. The same goes for pull-request texts.
6. **The repository is public.** Nothing about chats, sessions, prompts, tools or how the work was done: describe the app. No private plans (who tests what, what is told to whom), no data about real people. What reaches git history stays there.
7. **Secrets never enter git, logs, docs or fixtures:** Firebase config (`android/app/google-services.json` is git-ignored), the service-account key (`fcm_key`), the signing keystore and its password, the Tailscale auth key, the invitation code, real device IDs. They live in GitHub secrets and variables and in the add-on options. When documenting a setting, name it, never give a value. If a step needs a secret, ask Korbi to run that step.
8. **The UI is honest.** Never show "pünktlich" without real-time data, never show an invented code or number, label old data as old, prefer "Keine Daten" over a guessed "alles ok" (`backend.md`, "What honest means").
9. **Keep it minimal.** The product is valuable because it is small and calm. Test every idea with: *would a commuter need this at 6 a.m., half asleep?* No general journey planner, no accounts, no ads, no analytics, no third-party scripts, fonts or trackers, no big settings page.
10. **Small diffs in the existing style.** Do not reformat, rename or refactor what you were not asked to touch. Comments explain *why* (the code base has many; keep it that way), in English. The server has one runtime dependency and the UI has none; adding one needs Korbi's agreement.
11. **Report briefly, in German:** what changed and what it means for Korbi (install the new APK / update the add-on / nothing to do), which `public/screens/*.dc.html` you touched (he keeps a design copy of the screens outside the repository and syncs it by hand), and one natural next step if there is one. No recap of your steps.
12. **Korbi verifies on his own phone** (Android; the server runs as a Home Assistant add-on on a Raspberry Pi). His reports come as screenshots, terminal output or a sentence like "irgendwie geht's nicht so, wie ich es haben möchte". Reproduce first (a failing unit test or screen-test case is the best proof), then fix, then keep the test.
13. **Never hit the real timetable sources from tests, CI or leftover scripts.** They are unofficial and rate-limited. Tests use the mock provider and recorded fixtures; `scripts/probe.mjs` is for a human to record new fixtures.
14. **Time is Europe/Berlin.** All server time logic goes through `server/lib/time.mjs`, and tests inject `now`. Never rely on the machine's zone: CI runs in UTC, Korbi's computer in Berlin time, and code that depends on the zone passes on one and fails on the other.

## The product

ReGo is a minimalist public-transport (ÖPNV) app for **commuters** in the Alpine region: the German Alpine foothills (Upper Bavaria, Rosenheim/Chiemgau, Berchtesgaden, Garmisch, Allgäu, Lindau …) and all of Austria. Cross-border commutes (Freilassing–Salzburg, Kufstein–Kiefersfelden …) are a core case, not an edge case. It is a private hobby project in beta, meant for a small circle of friends. Not for tourists.

**The idea is a near-zero "time to insight".** The user saves the routes they travel every day once (two stops, weekdays, a commute window such as 07:00–08:00). From then on the home screen answers one question at a glance: is my trip fine, and if not, what exactly is wrong and what do I do instead? Deviations are shown in colour with concrete minutes ("+6 Min."), cancellations and replacement transport name the next alternative, and a push arrives only for the user's own routes and only around their commute window. The typical user looks at the phone half asleep in the morning; only when a transfer is involved does he look a second time.

**Beside that, a ticket safe:** the user stores the barcode of their Deutschlandticket / KlimaTicket and shows it with one tap (full brightness, screen stays on). No payment, no wallet import (ReGo cannot read wallets; an earlier text promised it and was removed), deep links to the official apps instead.

**Principles:** *offline-first* (the last state stays on the device, usable for up to 6 hours; tickets are always available; a banner says what is old). *Private by design* (no accounts; a device is a random ID; tickets never leave the phone; nothing is loaded from third parties; no analytics). *Honest* (no guessed "ok", no invented data; the app says when a source is closed or has no real-time data). *Calm* (few words, big type, pastel fields; colour only where something deviates). *Gentle on the sources* (public but unofficial interfaces; ReGo stays small on purpose: few devices, few requests, rate limits, an optional invitation code; if it grew it would need the operators' official interfaces).

**Decided against** (do not propose again unless Korbi raises it): an iOS app; a browser/PWA version (unsupported since 0.6.0, the server still serves the UI only for trying things out); a big settings page (settings are a small sheet, because a page would end the "easy" feeling); a general single-connection search (replacement connections on a disruption are enough); payments or ticket purchase.

**How the parts fit:**

```
 phone: Android WebView app ── bundles public/ (UI) ──┐
        PollWorker / FCM service (notifications)      │ HTTPS (Tailscale Serve or Funnel)
                                                      ▼
 Raspberry Pi: Home Assistant add-on ── Node server (server/) ── serves public/ too
                                          │  cache, pause, fallbacks
                                          ▼
                       MVV (EFA) · MoBY (EFA) · ÖBB (hafas-client) · DB (transport.rest)
```

The UI in `public/` is one code base used three ways: the server serves it (for trying things out and for the screen test), the APK bundles it, and the tests drive it in a browser. The app talks to the server's API at an address that is written into `native-config.js` at build time.

### Words you will meet

German terms appear in the UI, the API (`name`, `title`, `text` fields) and in tests. Code identifiers are English.

| Word | Meaning |
|---|---|
| Strecke; Hinweg / Rückweg | a route (`tour` in code and API, `/api/tours`); outward / return trip – a round trip is two linked tours (`returnId` / `returnOf`) |
| Aktivitätszeit, Pendelzeit, Reisezeitfenster | the commute window of a route: weekdays plus `departAfter`–`departUntil` |
| Meldung | an incident (`delay`, `replacement`, `construction`, `cancelled`, `platform`, `tight`, `missed`); the screen "Meldungen" lists them |
| Verspätung, Ausfall, Ersatzverkehr (SEV), Baustelle, Gleiswechsel | delay, cancellation, replacement transport, construction, platform change |
| Anschluss wackelt / verpasst / fällt aus | connection at risk / missed / connecting trip cancelled |
| Umstieg, Direktverbindung | transfer, direct connection |
| pünktlich / planmäßig | "on time" (only with real-time data and a near departure) / "on schedule" (no real-time data, or far away) |
| Quelle, Verbund | a timetable source; a regional transport association (MVV, MoBY) |
| Ticket-Safe | the ticket safe; slots `dt` (Deutschlandticket), `kt` (KlimaTicket), others |
| Neues Handy?, Einladungscode | moving routes and settings to another phone with a one-time code; the optional code a server can demand from new devices |
| Fehlerbericht, Rückmeldung, Stand | error report (a text file); feedback (mail or GitHub issue form); "as of" time |

## Working with Korbi

- He is product owner and tester in one. He decides what "done" means and has a high bar: it has to feel finished, not just work. Expect a correction after the first result; the precise requirement often arrives in the second message ("irgendwie geht's nicht so, wie ich es haben möchte"). That is normal, not a failure: look at what he sees, find the difference, adjust.
- He writes short German messages and hands over raw material (terminal output, compiler errors, screenshots, a sketch) instead of summaries. Answer in kind: short, concrete, findings first.
- He filters suggestions down to what he needs and rejects over-engineering ("zu krass"). Offer a few well-argued options instead of a long list, and say which one you would take.
- He runs the tests himself and reports what the terminal said. Give the exact command, keep the output readable, and say what a pass looks like.
- He tests every release on a real phone and notices glitches that only flash briefly. Treat such a report as true even if you cannot reproduce it at first; try again at 320 px, in dark mode, with a stale cache, with a source that fails.
- **Design taste:** flat pastel colour fields, soft white cards, black pill buttons, huge bold headlines, hand-drawn doodle-style icons, generous air; the round line badges and the schematic line map borrow from underground signage. Type is Instrument Sans in two weights. Dark mode is mandatory for every new element.
- **UI copy:** German, informal ("du"), short, friendly and a little playful where it fits ("Sorry! Momentan erreicht uns kein einziger Krümel."), never technical. State what happened and what the user can do, without blame.
- **Design copy outside the repository:** the screens (`public/screens/*.dc.html`) started as a visual design made outside the repository, and the `.dc.html` format comes from there. Korbi keeps that design copy and brings changes across by hand. The repository is the source of truth for what runs; keep each screen loadable by `public/js/dc-lite.js` (`ui.md`) and name the screens you changed in your report.
- He decides version numbers. A release is a deliberate step, not a by-product of a fix.

## Repository map

```
README.md  BACKEND.md  PRIVACY.md  LICENSE   public documents (see the table above)
CLAUDE.md  .claude/rules/                      these notes
package.json     "rego-backend": ESM, Node >= 20, one dependency (hafas-client); scripts: start, demo, probe, test
package-lock.json  pins every installed package; CI and the add-on image install with `npm ci`
repository.yaml  makes the repo installable as a Home Assistant add-on repository
.github/dependabot.yml  weekly pull requests for npm and workflow-action updates
.github/workflows/  build.yml (tests + screen test, then the add-on images), apk.yml (signed APK -> GitHub release app-v<version>)
rego/       the Home Assistant add-on: config.yaml (its `version` is THE release version), Dockerfile, run.sh, DOCS.md, CHANGELOG.md
server/     the Node backend: index.mjs (HTTP, routes, static files, timers), config.mjs (env -> config, APP_LATEST), service.mjs (getState, search),
            guard.mjs, notifier.mjs, fcm.mjs, providers/ (index = choice of source, efa, hafas, lib, pause, mock), domain/ (state, transfer, chain, window, classify, map),
            store/ (profile, cache), lib/ (time, geo, lines, version)
public/     the UI, served by the server AND bundled into the APK: index.html, status.html, screens/*.dc.html, js/, fonts/, icons/
android/    Gradle project, Java, WebView shell
test/       node:test suites; fixtures/ = recorded real responses          scripts/  ui-smoke.mjs (screen test), probe.mjs (records fixtures)
```

## Commands

```
npm test                              all unit/API tests (offline, about 25 s, no npm install needed)
npm run demo                          server with sample data on http://127.0.0.1:8080  (/status = status page, / = the UI)
npm start                             server with the real sources (needs npm install)
node scripts/ui-smoke.mjs             screen test (needs Playwright, see tests.md)
SMOKE_ONLY=Dark node scripts/ui-smoke.mjs      only the screen-test blocks whose name contains "Dark"
node scripts/probe.mjs [from] [to]    record new fixtures from the real sources (a human, rarely)
gh run list --limit 6                 state of the last CI runs (or the Actions tab on GitHub)
```

## Releasing in short

Korbi decides that something is a release and which number it gets; releases are small (one topic each) and every user-visible change ships as one. Steps: raise `version` in `package.json`, `package-lock.json` (twice) **and** `rego/config.yaml` → add `## <version> – <title>` at the top of `rego/CHANGELOG.md` (it ends with a **Rebuild** paragraph) → when `public/` or `android/` changed, set `APP_LATEST` in `server/config.mjs` to that version → update the docs → `npm test` (and the screen test when `public/` changed) → commit `Release <version>: …` → push to `main` → watch CI → tell Korbi what to install or update. Workflows, details and the compatibility rule: `.claude/rules/release-and-addon.md`.

## Traps that bite everywhere (the area files have the rest)

- **One UI, three consumers** (browser, APK, screen test); the app calls the API cross-origin. A new request header needs CORS support (`ui.md`).
- **Old app with new server and new app with old server must both keep working:** APKs and the add-on are updated separately. Add optional fields, never repurpose or rename (`release-and-addon.md`).
- **Every UI change has to hold at 320, 390 and 520 px and in dark mode,** and German texts are long.
- **Pushing `public/` or `android/` builds and republishes the APK;** a docs-only commit builds nothing.
- **Do not change the app origin, the `applicationId`, the signing key, notification channel IDs or profile keys:** tickets, user settings and the profiles on the Pi depend on them (`android.md`, `backend.md`).
- **Profiles on the Pi are the only server state that matters.** Never suggest uninstalling the add-on as a fix: it deletes them and the Tailscale login.
- **The sources are unofficial and rate-limited;** a source that says "too many requests" is left alone (`sources.md`).

## Known gaps and ideas – none approved, propose before starting

- **Maintenance:** Android libraries and `targetSdk` 34 are 2024 versions (a Play Store release would need a newer one); no automated tests for the Java side.
- **Product ideas:** a home-screen widget for the glance at six in the morning; sharing the error report directly (needs a `FileProvider`); a finer rating for routes with two transfers; honouring the Android font size; cross-border fares explained properly, BahnCard suggestions, wallet import (no clean way is known).
- **Line map:** choose the shown stops by importance (junctions first); show a single omitted stop as "+1"; the route-name pill with three lines is cut below about 340 px; the design copy's sample data lacks `hidden`.
- **Sources:** ask the MoBY operator about access (its endpoint says it is not open data; Korbi decides); a systematic list of real border routes; stop-name special cases like Lindau Hbf; buses and trams stay dark when their association is down; the dependence on transport.rest; more associations (depends on the routes users need); closures that are missing from the source data cannot be shown ("Keine Verbindung"), so collect such cases (route, time, screenshot).

## Keeping these files current

These files are code: they have to be true. In the same commit as a change, fix every statement the change makes false.

- **Update when** a file or directory appears, moves or goes away; an endpoint, constant, rule or module changes behaviour; the release or CI process changes; Korbi states a new rule or preference; a decision is made or reversed; you meet a trap or lose time to a mistake that the next colleague should avoid; a gap above is closed or decided.
- **Put it where it belongs:** what holds in every session goes here; what matters for one area goes into that area's file in `.claude/rules/`. Keep this file under 200 lines and every rules file under 200 lines and 40,000 characters: Claude Code warns above that, a long file is followed less reliably, and a rules file over its limit is only partly loaded.
- **Keep it factual:** exact names, paths and numbers; reasons rather than a diary; no "currently" unless it is cheap to keep true. English, like the rest of the repository.
- **Keep it clean:** no secrets, tokens, addresses of private servers or real device IDs; nothing about how or with whom the work was done; no private plans. These are public files.
- After editing, check that every path and command you mention exists (`ls`, `grep`), that the file names cited in the text are right, and that the table at the top still matches the files.
