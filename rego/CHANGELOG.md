# Changelog

## 0.8.9 – Top of the route page

**Route page**
- The route name in the pill at the top takes two lines instead of ending with "…" (before: "Freising → München, Neup…"). With three lines in a row ("S1 › S4 › U5") on a narrow phone the type is a little smaller so that the name still fits.
- The map keeps as much room on the right as the longest stop name needs, so "Neuperlach Süd" is no longer cut to "Neuperlach S…".
- Two stops right next to each other with no omitted stops between them (like Hackerbrücke → München Hbf) get at least as much room as their names need, so the names no longer lie on top of each other.
- In the big card "05:47 · 1 Umstieg" stays together in one line instead of leaving "Umstieg" alone in the last line.

**Rebuild**
- Looks only: install the new APK (`app-v0.8.9`). The server logic and the API do not change; the add-on update only brings the same screens for the browser.

## 0.8.8 – Up to two transfers

**Routes with transfers**
- When nothing is left with one transfer – typically because a closure forces another change, like Freising → München-Neuperlach Süd – ReGo now looks for connections with up to two transfers. The order stays the same: direct first, then one transfer, and only if there is nothing with at most one transfer, up to two.
- This works when you create a route and for routes that already exist. A route asks for two transfers only while no usable connection with at most one is left, and goes back to one as soon as there is one again.
- Creating shows the preview "Gefunden · 2 Umstiege" with three trips and both transfers. Setup step 1 says "Gefunden: 2 Umstiege in A › B". The route list says "2 Umstiege · meist A › B".
- The main screen shows the three lines in a row of their own ("S1 › S4 › U5") and a line like "2 Umstiege · 4 und 6 Min.". If one of the two transfers gets tight or is missed, that is what the line says. The detail page lists the three trips with a transfer card between each, and the map shows three lines and both transfer stops.
- "Mit weniger als 3 Umstiegen nicht erreichbar" replaces the old text with 2, but only when the server really looked that far (an older server still says 2).
- ReGo only knows what the source knows. A closure that is not in the data cannot be found, and then the route still says "Keine Verbindung". The check for two transfers is simpler than the one for a single transfer: it takes the trips the source suggests and rates every transfer on its own.

**API**
- `POST /api/connections/search` can answer with `transfers: 2`: the sample route then has three `legs` and `changes: [{via, wait}, …]`. The new field `maxTransfers` says how far the search goes.
- A route with two transfers keeps `transfers: 1` in the profile. In the state it has `changes` (number of transfers), `via` as "A › B", three `lineIds`, a `transfer` line per departure and a map with three `legs` and `changes[]`.
- Creating a route with a transfer is refused with `no-connection` only if not even two transfers work.

**Map**
- Stop names with the place in front ("München, Moosach") are shortened to the stop ("Moosach").

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.8.8`) and update the add-on. The new app also works with an older server, and older apps keep working with the new server (they show a route with two transfers with its three lines, but the map is a plain line).

## 0.8.7 – Search while you enter

**New routes and setup**
- The search starts by itself as soon as both stops are chosen. There is no need to tap "Speichern" first to find out whether the route works. While ReGo searches, the form says "Sucht Verbindungen …" and "Speichern" waits ("Sucht …"). In the meantime you can set the activity time.
- The result shows up at the top of the form: "Direktverbindung gefunden", or the connection with one transfer as a preview (one tap on "Speichern" creates the route with that transfer), or "A → B: Mit weniger als 2 Umstiegen nicht erreichbar." (then "Speichern" stays blocked). If the sources do not answer, the form says "Sorry, gerade antwortet keine Quelle." and "Speichern" still works; ReGo looks again when you save.
- Setup step 1 does the same: the result stands next to "Weiter". "Weiter" waits for the search and stays blocked when nothing can be reached. A connection with one transfer is saved at the end of the setup, as before.

**API**
- `POST /api/connections/search` now also says whether there is a direct connection (`direct`: true, false or null if the source does not know). Only without a direct connection it looks for one with a transfer. If the source is on pause, it answers 503 with the code `source-paused`.

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.8.7`) and update the add-on. The new app also works with an older server (it then looks when you tap "Speichern", as in 0.8.6), and older apps keep working with the new server.

## 0.8.6 – One activity time

**New routes and setup**
- The time card is now called "Aktivitätszeit": the time in which ReGo is active for this route. There is only this one card; the question "Pendelst du auch zurück?" and the second card for the return trip are gone. A return trip is a route of its own for now ("Strecke hinzufügen").
- The button "Mit 1 Umstieg suchen" is gone. If a route has no direct connection, "Speichern" looks for one with one transfer by itself. What it finds shows up as a preview at the top of the form, and a second tap on "Speichern" creates the route with that transfer. The setup has nobody to confirm a preview, so a connection that is found there is saved right away.
- If nothing can be reached with at most one transfer, the form says "A → B: Mit weniger als 2 Umstiegen nicht erreichbar." If the sources do not answer, it says "Sorry, gerade antwortet keine Quelle …" instead of a wrong "no", and the next tap on "Speichern" searches again.

**Main screen**
- Every departure shows its arrival under the departure time ("an 08:12"). With replacement transport the extra time from the message is included.

**Messages**
- Replacement transport names the trip it is about instead of saying that a whole line is replaced: "RE 5 ab 07:25 · mit Ersatzverkehr" (before: "Statt RE 5 fährt Ersatzverkehr · …").
- A route without a direct connection says "Lege die Strecke neu an, dann sucht ReGo auch mit 1 Umstieg."
- The text for a source on pause starts with "Sorry, …".

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.8.6`) and update the add-on. Older apps keep working with the new server.

## 0.8.5 – Calmer screens

**Main screen**
- The "Stand" time next to the app name is gone. When you are offline, the bar at the top already shows it.
- The hint about a new app version is now a bar at the very top, like the offline bar, instead of a pill under the title.
- The big line (for example "+6 Min.") has more air above and below. With "planmäßig" the icon now stays next to the text instead of slipping below it.
- "Strecke hinzufügen" on the empty main screen opens the form right away.
- The bar for old data now says "Server offline" instead of "Keine aktuellen Daten".

**Detail page**
- The icon and the minutes of a transfer are bigger, and the big line has more air as well.
- On the map, the spot a message is about (transfer, platform change) is a larger filled dot in the color of the message instead of a dashed ring.
- A platform change now comes before the departure it belongs to.
- A cancellation says "Stattdessen: …" for the next trip, so it no longer looks like the cancelled one. With replacement transport the text says "Statt RE 5 fährt Ersatzverkehr …", and the alternative is called "Ohne Ersatzverkehr".

**Routes**
- The state sits inside the switch ("An" / "Aus"), on the larger area, and the switch moved up a little. The same goes for the push switch in the settings.
- The settings sheet can also be pulled down with the finger (at the handle or the title); the cross stays.
- The commute time sliders move in half hours (before: quarter hours). Exact times are still typed into the time fields.

**Setup**
- Step 1 asks for one "Dein Reisezeitfenster" and creates the outward route; the return trip is added later through "Strecke hinzufügen".
- Step 2 offers "Deutschlandticket", "KlimaTicket" and "Anderes Ticket". A tap opens "Ticket hinzufügen" with the type already chosen; after saving, the setup goes on with step 3.
- Step 3 has only the big "Los geht's" button.

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.8.5`) and update the add-on.

## 0.8.4 – Connections during closures

**Routes with a transfer**
- The associations (MVV and MoBY) apply the limit of one transfer only after they have picked their best trips. When the network has closures the best trips need more transfers than allowed, so nothing was left and the route said "Keine Verbindung mit höchstens 1 Umstieg gefunden", although there are connections. ReGo now asks again with the limit inside the search (and, if that does not help either, for the trips with the fewest transfers) whenever the plain answer holds no trip that is still to come. The variant that worked is asked first for the next ten minutes.
- Creating a route no longer depends on the minute. If nothing is left today (closure, night), the check also looks at the next normal weekday morning, so a closure over the weekend does not stop a route that is meant for weekday mornings. The sample connection then shows its weekday ("Mo ab 07:42").
- The preview and the saved route still use the same query and the same cache, so they agree.

**Log**
- If no usable trip is left, the one line per route and ten minutes now says what each query returned: number of trips, first and last departure, how many are usable, transfers, and the source's own messages.

**Rebuild**
- Server only: update the add-on. The app stays at 0.8.0.

## 0.8.3 – Steadier connections

**Routes with a transfer**
- During closures an association (MVV) can answer a search for "at most 1 transfer" with nothing, or only with trips that have left already, although it found a connection a minute earlier: it first calculates a few candidate trips and only then drops the ones with too many transfers. ReGo now asks once more for the trips with the fewest transfers when that happens (and leaves it for five minutes if that brings nothing either).
- An answer without a trip right after a good one no longer turns a route into "Keine Verbindung mit höchstens 1 Umstieg gefunden": for ten minutes the trips of the last good answer that have not left yet are kept. This holds for all routes. The preview when creating a route and the saved route use the same query and the same cache, so they agree.
- The preview no longer offers a trip that has left already as the sample connection. If the source only returns such trips, the form says that the search was not possible just now ("Nochmal suchen") instead of "nothing found".

**Main screen**
- "Keine aktuellen Daten" over all screens now comes only when a route shows data that is at least five minutes old (before: right after the first refresh that failed). The route itself still marks older data.

**Log**
- If the source returns no trip for a route with a transfer, one line per route and ten minutes says what the source said (its own messages) and whether the second query helped. A route with a transfer that shows no departure although the source answered gets one line as well.

**Rebuild**
- Server only: update the add-on. The app stays at 0.8.0.

## 0.8.2 – A second source

**Timetable sources**
- If an association does not answer (MoBY: HTTP 429 for a day, but also timeouts, server errors and refusals), ÖBB and then Deutsche Bahn show the trips of its routes. The routes keep running; the stops are matched by name and position. ReGo does not guess: a stop without stored coordinates, a bus stop that has a station next to it, or a name that does not fit stays dark and says which source is closed, as in 0.8.1. Buses and trams are usually not in the railway data.
- Deutsche Bahn is asked only if ÖBB fails. An answer without trips ends the search, and an association that answers but does not know a route is not replaced.
- Stops that cannot be matched are not searched again for 15 minutes, and routes that start together share one search per stop.
- The closed source is still asked only once per pause. When it answers again, the routes switch back by themselves.
- One log line when a backup takes over and one when the association answers again.
- A refusal (HTTP 401/403) counts as "does not answer", like a timeout.

**Rebuild**
- Server only: update the add-on. The app stays at 0.8.0.

## 0.8.1 – A source says no

**Timetable sources**
- A source that asks for a long pause is left alone for as long as it asks, up to 24 hours (before: at most 30 minutes). MoBY answered with "HTTP 429, Retry-After 86400" and "This endpoint is not an open data endpoint. Please contact the portal owner": ReGo no longer knocks every half hour, it asks once a day. Restarting the add-on makes ReGo ask once more.
- A route that has no data because of that says which source is closed ("MoBY lässt gerade keine Abfragen zu. ReGo fragt später wieder an.") instead of "the source does not answer".
- "Mit 1 Umstieg suchen" says the same when the source for the route is on pause, instead of "Bitte gleich noch einmal versuchen".
- One log line per pause (with what the source answered) instead of one line per route and minute.

**Main screen**
- Routes without any data no longer put "Keine aktuellen Daten" on top of the routes that are fine. The banner stays for a complete outage and for old data shown from the cache; routes without data say so themselves.

**API**
- `GET /api/status`: a source on pause carries `pausedSec` (seconds until ReGo asks again).
- `POST /api/connections/search`: 503 with `code: "source-paused"` if the source for the route has put ReGo on pause.

**Rebuild**
- Server only: update the add-on. The app stays at 0.8.0.

## 0.8.0 – Ready for testers

**Honest status**
- **No "pünktlich" without real-time data:** If a departure is close but its source has no real-time data for it, ReGo no longer says "pünktlich". The main screen and the details page say "Ohne Echtzeit · … planmäßig · Verspätungen unbekannt", in a neutral light-blue look with a small "i" instead of the green check. A known delay is always shown. With a transfer both trips need real-time data. Far-away departures still just say "planmäßig". Older apps show the same words but keep the green look.

**Feedback**
- **Feedback address:** The new add-on option `contact` takes an email address or a link. The app shows it in the settings at "Rückmeldung senden": the mail comes with a subject and the app and server version, and the address is written out below it for phones without a mail app. Without the option the GitHub form opens as before. The address is only delivered to known devices, it is not on the public status page.

**App version**
- **Update hint:** The app tells the server its version with every request for the current state. If a newer app exists, the main screen shows a bar "Neue App-Version …" (it can be closed) and the settings a line with the download. The server notes the last version per device, and the status page shows how many devices use which version.
- Apps older than 0.8.0 do not report a version and get no hint: install this one by hand once.

**Tickets**
- The ticket safe says that the control staff decides whether a code from ReGo counts (keep the original ticket ready), and the note about where tickets live names the app data. Adding a ticket from a picture is worded "Bild mit Barcode".

**Privacy**
- `PRIVACY.md` lists the app version, the feedback address and the update link.

**API**
- `GET /api/state` accepts `?app=<version>` and returns `contact` (a string, may be empty) and, if that app is older than the newest one, `app: {latest, url}`. `GET /api/status` carries `apps: {version: count}`.
- Departures that are close but have no real-time data carry `noRt: true` (and `far: true`, so older apps say "planmäßig"); their views carry `noRt: true` too.

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.8.0`) and update the add-on.

## 0.7.4 – Gentler on the sources

**Timetable sources**
- A source that answers "too many requests" (HTTP 429) is now left alone: for as long as it asks (`Retry-After`), otherwise one minute, then two, four … at most 30 minutes. After the pause a single request tests whether it answers again. Before, the routes kept asking every minute even then. Until it answers, the app shows the last state (at most 30 minutes old) and the status page marks the source as "pausiert".
- At most three requests run at the same time per association.
- A source that does not answer is no longer reported as "stop not found on the other side of the border" when a route needs a stop translated between two sources.
- The station search leaves out a source on pause and does not keep the incomplete answer.

**Push**
- The push check refreshes routes that cannot push right now (another weekday, outside the push period) only every 10 minutes instead of every minute. The app itself still asks for fresh data.

**Log**
- Every log line starts with the time (Berlin), and the start line names the version. The line for a pause says what the source answered.

**Rebuild**
- Server change only: update the add-on. The app itself stays the same.

## 0.7.3 – Early commutes

**Push**
- The night quiet (23:00–04:00) now has an exception for early and late commutes. A route whose push period (one hour before its window until 10 minutes after the window ends) reaches into the night still pushes while that period runs: for a departure at 04:20 that is from 03:20. Every other route, and routes without commute times, stay quiet until morning.
- At night only routes in such an exception are checked. Notifications of other routes are not touched until the morning check.

**Rebuild**
- Server change only: update the add-on. The app itself stays the same.

## 0.7.2 – Commute time

**Routes**
- **Commute time:** When you set up or change a route you choose the window in which you leave – per direction from … to … There are two sliders for it (outward trip 04:00–12:00, return trip 12:00–20:00, in quarter hours); the time can also be tapped and typed. The handles do not overtake each other (at least 10 minutes apart), and a typed time outside the range widens the slider. When setting up with "Hin und zurück", each direction gets its own window (default 07:00–08:00 and 16:30–17:30). ReGo aligns everything with it.
- **Existing routes** get their previous "ab" time plus one hour as the window. It can be adjusted under "Strecke ändern". The list now shows "Mo–Fr · 07:00–08:00".

**Main screen**
- **The train in your window:** At the top is the route whose window is running right now, then the ones that still come today (the earliest first), then the rest. Before the window (up to three hours before) the route already shows the trains in it; before and during the window only trips up to its end count, and if there are none in it, the next ones. "Danach" may look beyond the window.
- **Outside the window** and on days when you do not commute there, ReGo shows the next trains as before, but without push.
- **"planmäßig" instead of "pünktlich":** If the departure is more than 45 minutes away it says "planmäßig". For trips that far away the source hardly knows any delays yet. A known delay is always shown.

**Push**
- Push now only comes for routes during their commute time: on the route's days from one hour before the window until 10 minutes after it ends. The night quiet 23:00–04:00 stays.
- The switch "Nur rund um die Abfahrtszeit benachrichtigen" in the settings is gone, the commute time replaces it. The end of a window does not mark an existing incident as "behoben".

**Settings**
- The link "Datenschutz" opens the new page `PRIVACY.md` (the former `DATENSCHUTZ.md` no longer exists).

**API**
- `POST /api/tours` accepts `schedule.departUntil` as well as `returnAfter` and `returnUntil`, `PATCH /api/tours/:id` accepts `schedule.departUntil`. If only `departAfter` arrives (older app), the window keeps its length.
- Routes carry `schedule.departUntil` and `window: {from, until, mode}`, departures carry `far: true` if they are more than 45 minutes away. `PUT /api/settings`: `pushWindow` is still sent by older apps, accepted and ignored.

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.7.2`) and update the add-on.

## 0.7.1 – Faster with 1 transfer

**Incidents**
- **"Schneller mit 1 Umstieg":** If a route without a transfer has replacement transport, ReGo also looks for connections with one transfer. If one arrives at least 5 minutes earlier at the destination than the trip with replacement transport, the incident's page shows a green card with the two lines, the transfer including the waiting time, and the arrival ("An 07:56 statt 08:13", "−17 Min."). Only what surely works is shown: at least 3 minutes to change, nothing is cancelled, no replacement transport on the detour, and the first trip is still reachable. If there is nothing faster, nothing appears. There is no switch, no additional push and no new incident.
- If the replacement transport is not the top incident of the route, the hint appears as a line in its card.

**Routes**
- **Old routes with "Keine":** Instead of "ReGo zeigt nur Fahrten ohne Umstieg." the main screen now says how to proceed: "Lege die Strecke neu an, dann bietet ReGo dir 'Mit 1 Umstieg suchen' an."

**API**
- Incidents about replacement transport on routes without a transfer additionally carry `view.shortcut` if there is a faster detour.

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.7.1`) and update the add-on.

## 0.7.0 – Routes with 1 transfer

**Routes**
- **"Mit 1 Umstieg suchen":** If there is no direct connection between two stops, the "Neue Strecke" form says so as before and shows the button "Mit 1 Umstieg suchen" below it. If ReGo finds something, a preview appears ("Gefunden · 1 Umstieg") with both lines, the transfer station and the waiting time; "Speichern" then creates the route with a transfer, with "Hin und zurück" both directions. If ReGo finds nothing even so, it says so honestly ("Auch mit 1 Umstieg habe ich zwischen A und B nichts gefunden.") and nothing is created. If you change a stop, the preview disappears again.
- **No switch:** There is no setting "always with a transfer". A transfer is only added when you explicitly search for it on a route. The sentence "ReGo zeigt nur Fahrten ohne Umstieg." has been dropped from the error message.
- **List:** A route with a transfer shows two line dots with an arrow and below them "1 Umstieg · meist München Hbf".
- **Older routes without a direct connection** ("Keine") can be converted: if you create such a route again with the same days and the same time, the notice with "Mit 1 Umstieg suchen" comes again. If ReGo finds something, the existing route becomes a route with a transfer instead of appearing twice.

**Main screen and detail page**
- **ReGo chooses the transfer anew for every departure:** Feeder, transfer station and connecting trip can differ for every departure. Each row shows departure, both lines, the arrival at the destination and the transfer ("Umstieg München Hbf · 9 Min."). More than 30 minutes of planned waiting time at the transfer do not count, unless there is nothing else.
- **The states:** "pünktlich"; "Anschluss wackelt" (the feeder is late, less than 3 minutes remain); "Anschluss verpasst" (no buffer left, ReGo shows the next connection with the new arrival) and "Anschluss fällt aus" (the connecting trip is cancelled, even with an on-time feeder). Replacement transport on the feeder: "Anschluss bleibt erreichbar" as long as the stated extra time suffices, otherwise the connection is at risk or missed.
- **Detail page:** two sections ("1. Fahrt", "2. Fahrt") with a transfer card between them (platform → platform, minutes). The map shows both lines, marks the transfer station (with a warning ring when at risk or missed), the disrupted section and the time pills for departure and arrival, which change color on a delay. Long routes are shown shortened, omitted stops appear as "+5" on the line.
- If the timetable source returns only direct trips for a route with a transfer, the usual rules for direct routes apply.

**Incidents and push**
- **New kinds:** "Anschluss wackelt" (orange) and "Anschluss verpasst" (red). Both always come as push while they are current, independent of the delay threshold. If a "wackelt" becomes a "verpasst", that is a new incident (new push, no silent update). On Android they use the channel "Verspätungen".
- Cancellation of the feeder, platform change (also of the connecting trip), replacement transport, construction and delay exist as for direct routes, each with the affected line.

**API**
- New: `POST /api/connections/search` looks for a connection (direct or with 1 transfer) and returns a preview; `found: null` means "the source is not answering right now".
- `POST /api/tours` accepts `transfers: 1`. Without a direct connection it answers with 422 and `code: "no-direct"`, with `transfers: 1` and no connection at all with 422 and `code: "no-connection"`; any other value for `transfers` is a 400. If the source does not answer, the route is created as before.
- Routes carry `transfers`, `via` and `lineIds`, departures `lineIds`, `arrTime` and `transfer`, views `sections`. The flat list `rows` is kept for older UIs.

**Rebuild**
- Looks and server changed: install the new APK (`app-v0.7.0`) and update the add-on. An old app does not know routes with a transfer and cannot display them correctly.

## 0.6.2 – New app icon

**Android**
- **New icon:** The app icon is now a runner with a backpack and briefcase, in a plain, single-color style. The background follows the system: on a light system it is dark with a light runner, on a dark system light with a dark runner. With "themed icons" switched on (Android 13 or newer) Android tints the runner to match the wallpaper. How immediately the icon changes when switching between light and dark depends on the launcher.

## 0.6.1 – Settings, main screen, push diagnostics

**Routes**
- **Settings:** Push notifications with the test notification, "Neues Handy?", feedback and the version line are no longer in the list but in a sheet that slides up from the bottom. It is opened with the sentence "Push, neues Handy und Rückmeldung findest du in den Einstellungen →" under "Meine Strecken". The back button, a tap on the dimmed rest or Esc close it again; the app stays where it is. This keeps the list tidy even with many routes.

**Main screen and detail page**
- **Check mark slipped down:** With longer words like "pünktlich" the check mark on the main screen jumped below the word. The big line now adjusts its size to the width (between 34 and 58 px) and the check mark stays next to it on the right, also on small phones. The same on the detail page.
- **"Danach" and "Nächster Zug" are tappable:** The card at the bottom of the detail page leads to the page of that departure. This now also applies when you look at the first departure and everything is on time (card "Danach" with "pünktlich"); before, there was nothing there or a card without effect. A detail page exists as before for the first three departures of the list; if the next trip is the fourth, the card stays a pure display.
- **Android bars:** On the detail page the status bar at the top has the color of the card (green, gray, or black when "offline") and the navigation bar at the bottom that of the sheet. Before, a white strip remained above the card. With the full-screen notice "Sorry!" (no data at all) both bars have the pink color of the notice.

**Push diagnostics**
- **Status page:** `/status` now shows whether the server has a Firebase key ("Sofort-Push: an/aus") and, for the push subscriptions, how many phones have reported a Firebase token. Both are just numbers. This makes it possible to see without guessing why notifications only arrive every ~15 minutes.
- **Log:** At startup the server writes whether the key (add-on option `fcm_key`) was loaded. A missing or unreadable key was not noticeable anywhere before.
- The error message of the test notification now names the path "Strecken → Einstellungen".

**Rebuild**
- Looks and app changed: install the new APK (`app-v0.6.1`). The server changed as well: update the add-on.

## 0.6.0 – Cancellations, platform changes, invitation code, app only

**New incidents**
- **Cancellation:** If a trip on your route is cancelled in the next 3 hours, there is now an incident of its own, "Ausfall". Before, this was kept quiet and the route simply showed the next train. Several cancelled trips of the same line are in one incident.
- **Platform change:** If a train departs from a different platform in the next 45 minutes, a separate, quiet incident arrives ("Gleis 3 statt Gleis 2"). Even if the train is on time.
- **Test notification:** Under "Strecken" a button sends a test notification to your phone so you can see whether push arrives. Whether it comes immediately (Firebase) or only at the next poll (up to about 15 minutes), the app says so.
- **Notification channels (Android):** "Verspätungen", "Ausfälle und Ersatzverkehr", "Baustellen" and "Gleiswechsel" are channels of their own. In the Android settings of ReGo each can be made louder, quieter or switched off individually. The previous collective channel "Meldungen" is removed on the first fetch; your own settings for it are lost in the process.
- **"Behoben":** If a delay, replacement transport or construction is over and the notification is still in the notification shade, it is briefly rewritten to "… behoben" (silently) and disappears after a few seconds. Cancellations and platform changes simply disappear. If you have already swiped the notification away, nothing happens.

**Routes**
- **Route without a direct connection:** It can no longer be created. The form says "Zwischen X und Y habe ich keine Direktverbindung gefunden. ReGo zeigt nur Fahrten ohne Umstieg." If the timetable source is not answering right now, the route is created anyway (ReGo does not guess). The same applies to outward and return trip: both directions are checked.
- **Version line** under "Strecken": app and server version, plus links to the privacy text and the project on GitHub.
- Existing routes without a direct connection stay as they are (they keep showing "Keine") and can be deleted.

**Operation and security**
- **Rate limiting:** The server limits requests per address (200 at once, then 3 per second) and per device (60, then 1 per second), the stop search more tightly (20, then 1 every 2 seconds) and new devices per address to 10 per hour. Above that it answers with "429" and the waiting time (`Retry-After`). `/api/health` for the watchdog stays free, the log has at most one line per minute about it. Behind Tailscale the real sender address from `X-Forwarded-For` counts.
- **Invitation code (optional):** New add-on option `invite_code`. If it is set, new devices need the code; the app then shows an input screen. Devices the server already knows continue without further ado. Wrong codes are slowed down (10 attempts, then one per minute). Leave it empty = open as before.
- **Note on the timetable sources:** The README and the privacy text now say openly that ReGo uses unofficial or public interfaces (MVV, MoBY, ÖBB, transport.rest), without any warranty, and that a larger operation would need the official interfaces of the transport companies.

**App only**
- The browser version is no longer maintained. Removed: service worker, web manifest, browser push (and with it the VAPID keys including `vapid.json`), the PWA icons. The server still serves the UI (for trying it out), the Android app is what is supported. Push now runs natively only: Firebase nudge or polling every ~15 minutes.
- `PUT /api/push` and `GET /api/push/key` no longer exist. Old browser subscriptions in existing profiles are skipped (they deliver nothing any more).
- The add-on option `contact` has no function any more and stays only so that existing settings remain valid.

**Android app**
- Portrait only.
- Fixed text size: The app no longer follows the Android font size, because parts of the UI shifted.
- Shortcuts on the app icon (long press): "Ticket anzeigen", "Meldungen", "Neue Strecke".
- Themed icon for Android 13 and newer.

**Appearance**
- Other routes (not the nearest) show their state as a white card with an icon instead of just text.
- Line label in the map at most 12 px.
- With replacement transport and construction the date is no longer shown twice.
- Status card: the icon no longer shrinks with long text. Incident card rearranged.
- Very narrow phones (320 px): departure row tighter, "pünktlich" no longer touches the platform info, code input wraps.
- If creating the first route fails, the reason is shown on the start screen, not just briefly as a notice.

## 0.5.1 – Honest about missing departures
- **Route without a departure:** If there was no direct connection for a route (or no data at the moment), the main screen still said "Alles pünktlich", the route was missing in the list, and the detail page said "Beendet". Now it honestly says "Nächste Abfahrt: Keine" with the reason (no direct connection found, trips cancelled, source not answering). The route stays in the list, the detail page shows start and destination, and under "Strecken" there is a short hint.
- A switched-off route shows "Pausiert" instead of "Beendet" on the detail page.
- **Font:** Instrument Sans (SIL Open Font License) is now included in the app and the add-on. Before, the app fell back to the system font because the font file had never been shipped. The font is cached for a week.
- More incidents of a route: heading with the delay at the top right, incident text and below it a short line each ("ab 01:12 (geplant 01:00)", "an 02:30", "Nächster Zug: …") instead of one long, wrapping line.
- Detail page: routes without a line no longer have an empty gray dot.
- "Rückmeldung senden" under "Strecken": the whole sentence is tappable (larger area).
- Add-on: The address for the watchdog is set. If you switch on the "Watchdog" switch for ReGo under "Info" in Home Assistant, Home Assistant restarts ReGo by itself if it hangs. The identification towards the timetable services now names the project address.
- Cleaned up: the file for the former browser variant of the app (`assetlinks.json`) is removed.

## 0.5.0 – Big bug hunt
The whole app was checked for bugs. The most important:

**Incidents and push**
- The push title is now also correct for lines with spaces ("RE 5 +8 Min." instead of just "RE"), likewise the "behoben" notification in the browser.
- The same delayed train on a different day is reported again; long construction sites are no longer reported anew every three days.
- If the data source fails for one route, only the notifications of that route pause. The others keep running.
- App devices from which nothing came for 21 days (app deleted) are no longer checked.

**Server**
- Invalid requests (not a JSON object) result in "400" instead of a server error.
- A route that is sent twice (double-tapped) is created only once.
- "Rückgängig" keeps the coordinates of the stops and does not overwrite settings.
- A damaged profile file no longer locks the device out, it is set aside.
- When a data source is disturbed, the app waits at most 12 seconds per route, the source is then left alone for a short time, and old trips are shown for at most 30 minutes.
- Upper limits against abuse: cache, open transfer codes (500), number of profiles (2000). The public status page is cached for 30 seconds.
- A forgotten error in a background operation no longer terminates the backend.

**UI**
- A newly created route sometimes got lost when refreshing at the same time. Double-tapping "Speichern" created it twice. Both fixed (the button shows "Speichert …").
- If saving, removing, undoing or toggling fails, the display jumps back instead of showing something wrong.
- "Neues Handy": before replacing existing routes the app asks.
- New switch "Push-Meldungen" under Strecken (on/off). The threshold (3/5/10 min.) now only changes the threshold.
- Route page: The tapped incident is on top, the number on the incidents button counts like the list, an incident that no longer exists shows "Beendet" (instead of the incident of another route), the card fits on narrow phones, line labels no longer lie on the alternative line.
- Dark mode: The card "Neues Handy?" is readable.
- Large font: fewer overlaps in the departure list and the status card. Onboarding can be scrolled on small screens.
- Ticket: The screen stays on also after returning to the app (browser). If the code image is missing, an honest notice is shown instead of an invented random code.
- Offline, no state older than 6 hours is shown any more. No green flash at startup any more, and quick navigation does not overwrite a newer page.

**Android app**
- Colors of status and navigation bars are taken over correctly, dark mode follows the phone.
- If the web view crashes (low memory), the app recovers instead of closing. On rotation or mode change the state is kept.
- For sorting by distance the approximate location is enough.

**Development**
- 14 new server tests. The screen test now additionally checks double tapping, undo, apply code, small phone, dark mode and several incidents per route. It runs before every build again (it had accidentally dropped out of the flow since 0.3.0).

## 0.4.4
- When scrolling, the content fades out softly at the top (main screen, incidents, routes) instead of vanishing hard under the header.

## 0.4.3
- Incidents: every incident is a card of its own again (overview), all lead to the shared page of their route.

## 0.4.2
- Departure list: trips that have already left are no longer shown, order by actual departure, trips from tomorrow are marked "morgen".
- Detail page: Austrian routes link the ÖBB app instead of DB Navigator, cross-border ones only the ticket hint.
- Names like "München, München Hbf" are shortened to "München Hbf".

## 0.4.1
- One detail page per route: construction, replacement transport and delay are together on one page, in the incidents one card per route.
- Main screen: the next three trips of the nearest route are tappable and open a detail page of their own (delay, platform, map, the trip after).
- Sorting by location: distance first (time of day only at equal distance), the distance is shown below the route. The Android app asks for location permission at start, the browser once from two routes.

## 0.4.0
- New phone: generate a code under Strecken and enter it on the new device, routes and settings are copied (code valid for 10 min., usable once).
- Feedback: the link opens a prefilled GitHub form.

## 0.3.2
- Default address of the app and of the tailnet name: `rego` (https://rego.tail2a5f03.ts.net).

## 0.3.1
- Instant push via Firebase for the Android app (the server sends only an empty nudge, the app fetches the text itself). New add-on option `fcm_key`.

## 0.3.0
- Real native Android app (instead of a browser shell): brightness for the ticket, download folder, own notification service.
- The server allows the app origin (CORS) and knows native push (`PUT /api/push/native`).

## 0.2.1
- Android app (APK) as a shell around ReGo: project under `android/`, GitHub builds it (workflow "Build Android app (APK)"), instructions in the README.
- The server serves `/.well-known/assetlinks.json` so that the app runs without a browser bar.

## 0.2.0
First mini version after the beta.
- Routes can be changed (time and weekdays) via "Ändern" on the route.
- Push only around the departure: new switch under the push settings, ±20 minutes around the time of the route on its days.
- Tickets: message when the storage is full, "Tickets sichern" and "Tickets wiederherstellen" as a file, expired tickets are marked.
- Detail page: "geplant 00:18" instead of a struck-through time, "Nächste Verbindung" instead of "Alternative", link "Im DB Navigator ansehen".
- Short offline bar: "Offline-Modus | Stand: hh:mm".
- Beta notice at start only the very first time.
- App icon: shortcuts "Ticket anzeigen" and "Meldungen" (long press).
- Status page at `/status`.
- Security: the stop search needs the device ID, security headers (CSP among others), profiles unused for 180 days are deleted, a privacy text (`DATENSCHUTZ.md`, now `PRIVACY.md`).
- Cleaned up: unused library db-vendo-client removed, font file request (404) removed, the screen test runs before every build.

## 0.1.35-beta
- "Hinweg" and "Rückweg" now only appear for real round-trip pairs, no longer guessed by time.
- Incidents: The same disruption on outward and return trip appears as one card ("beide Richtungen"). "nach Nähe sortiert" now only appears when the location is known.
- Server: a broken address gives 400 instead of 500, an oversized request 413 with text, test push without a subscription 409 instead of "ok".
- The contact line under Strecken links to the GitHub issues. Default device name in the tailnet: `rego-beta-app` (applies only to new installations).

## 0.1.34-beta
- Fixed empty silent "ReGo" notifications: That was the short placeholder signal on removal. It now appears as "Aktualisiert" for only 2.5 s and is then closed.
- When an incident is over, the notification briefly becomes "<line> · behoben" (silent) and is removed after 6 s.
- If a push arrives without new content, the generic message "Neue Meldung auf deiner Strecke" no longer appears.

## 0.1.33-beta
- Notifications stay current: if the delay changes (e.g. +6 → +9 min.), the existing notification is updated quietly instead of showing a new one.
- If the delay is gone (or the train has left), the notification disappears automatically from the notification shade (after about two minutes without the incident).

## 0.1.32-beta
- Ticket screen: There is room at the bottom for the button "Ticket hinzufügen", the last ticket can be scrolled up completely.
- Location: fetched anew every time the app opens (20 s instead of 8 s) and remembered for 12 hours so that the nearest route comes first.

## 0.1.31-beta
- The offline display now names the reason (e.g. "Offline-Modus · Server 500", "Zeitüberschreitung" or "keine Verbindung zum Server"). Requests abort after 30 s.
- Log: error responses of the API (HTTP 400 and above) are now in the log.

## 0.1.30-beta
- Lindau Hbf: The station is called "Lindau (Bodensee) Insel" or "Lindau Inselbahnhof" at the sources and could not be found via "Lindau Hbf". The search now shows it at the very top as "Lindau (Bodensee) Hbf" for "Lindau Hbf / Hauptbahnhof / Bahnhof".

## 0.1.29-beta
- The railway search (ÖBB/DB library) returns up to 12 instead of 8 results so that stations further down (e.g. Lindau Hbf) are not cut off.
- A check script (`probe-lindau`, since removed) showed how Lindau Hbf is named at ÖBB and MoBY.

## 0.1.28-beta
- The ticket screen can be scrolled (card and further tickets), the button "Ticket hinzufügen" stays at the bottom.
- Display "Beta" instead of "Beta01".
- Log: for every search the first results of each source are included (for troubleshooting).

## 0.1.27-beta
- Relief for ÖBB/DB: The search asks the railway servers only from 4 characters and only if the association does not know the station exactly (before at every key press, which drove ÖBB into timeouts). Input waits 450 ms.
- IPv4 first (bahn.de hangs here over IPv6) – this should end the ÖBB timeouts.
- Border routes: "Freilassing (Obb), Freilassing" is now found at ÖBB via simpler spellings.

## 0.1.26-beta
- Search: "Lindau Hb" now finds Lindau Hbf (with several words, the first word is searched additionally, stations with a matching word beginning come first).
- The version number is now simply called "-beta".

## 0.1.25-beta01
- App icon: two crossing lines with stops on pastel green (status bar: the same symbol in one color).

## 0.1.24-beta01
- App icon: stamp lettering (rough edges) for "RE" and "GO" next to the line with stops.

## 0.1.23-beta01
- New app icon: one line with three stops on a light green ground, "RE" top left, "GO" bottom right.

## 0.1.22-beta01
- New app icon: three parallel traffic lines as a bundle (green = running, white = neutral, yellow = disruption), each ending at a stop. Replaces the "R".

## 0.1.21-beta01
- New app icon: an "R" as a traffic line with stops (home screen, add-on, browser tab, status bar). Clearly legible even at very small sizes.

## 0.1.20-beta01
- New: add-on icon and logo for Home Assistant.
- New: single-color status bar symbol for notifications (before, a white square).
- Push: New notifications no longer replace each other; the fetch of the notification text aborts after 8 s instead of hanging.
- Push: If delivery to the push service fails, ReGo tries again in the next run instead of losing the notification.
- The log now shows every delivery: `Push an fcm.googleapis.com: HTTP 201 angenommen` (or the error).

## 0.1.19-beta01
- Fix: The stop search finds stations reliably again ("Kempten Hbf", "Lindau Hbf"): ranking across all sources, words may be in any order ("Kempten Hbf" finds "Kempten (Allgäu) Hbf"), five suggestions instead of four.
- Fix: On the detail page the line circle at the top shows the line of the displayed incident (e.g. RE5), no longer the first line of the route (S3).
- The train-number suffix "(Zug-Nr. …)" is also removed from ÖBB/DB data.
- Log: shows when ReGo falls back to ÖBB for routes involving Austria.

## 0.1.18-beta01
- New: all of Bavaria via Bahnland Bayern (Rosenheim/Chiemgau, Allgäu, Berchtesgaden, Garmisch …) with real-time data, plus border towns in Austria (e.g. Freilassing → Salzburg).
- Routes between MVV and Bavaria stops work (the MVV stop is translated).
- Routes with an end in Austria: if Bahnland Bayern finds nothing, ReGo tries via ÖBB.
- The stop search sorts better: exact name and stations first, duplicate entries from MVV and Bavaria are merged.

## 0.1.17-beta01
- Fix: The number on the warning symbol now matches the list under Meldungen (before, the top incident was missing).
- Fix: Incident cards stack below one another and are no longer squeezed into each other; long texts run through completely (also in the detail).
- Fix: Train numbers in the line circle ("RE5(Zug-Nr.79030)") become "RE5"; longer abbreviations adapt.
- Fix: truncated association notices ("… bis Frei") are replaced by the first whole sentence.
- Shorter route names: "Freising, Freising" becomes "Freising", the same place at both ends is left out once.
- With replacement transport or construction without a delay there is no "+0 Min." any more.

## 0.1.16-beta01
- Fix: ÖBB stops without a standard number are assigned to Austria via the coordinates (correct label, the route runs via ÖBB).

## 0.1.15-beta01
- Fix: The stop search finds Austrian stops again (it waits for ÖBB instead of cutting it off after 0.6 s; incomplete search results are not cached).
- The log shows per search which source delivered how many results (`Suche "…": mvv 5, oebb 3`).

## 0.1.14-beta01
- The add-on now comes as a ready-made image from GitHub (no building on the Pi any more).
- New: timetable data from MVV (Upper Bavaria, Alpine foothills), the DB block is bypassed.
- Border traffic: German MVV stops are translated for ÖBB; routes with one end in Austria run via ÖBB.
- Faster app start (cache first) and faster search (blocked sources are paused).
- Default device name in the tailnet: `rego-beta01`.
