- An invite code (if the server requires one) is stored on the server only in the add-on options.
- Device profiles that have not queried the server for 180 days are automatically deleted. In the app you can delete a profile at any time.

Only on your device
- The invite code you entered (if any).
- Tickets (image of the barcode, name, validity). They never leave your device. You create the backup file via "Backup tickets" yourself. The camera is used only to scan tickets; images are not uploaded.
- The Android app opts out of Android automatic backups (`allowBackup=false`). When switching devices, use "Backup tickets" and "New phone".

Sharing / external requests
- Timetable queries from the server go to MVV, Bahnland Bayern (MoBY) and ÖBB. For Deutsche Bahn routes (and as a fallback for ÖBB), the server queries the public service transport.rest (v6.db.transport.rest), which in turn queries the railway. Only stops and times are transmitted, no device ID; requests originate from your server's address and identify themselves as "ReGo" with the project URL.
- Unofficial sources: these are publicly accessible but unofficial APIs. ReGo is a private hobby project — there is no guarantee or commitment, and the project is kept small. If it scales, official interfaces would be used (see README, “Note on timetable sources”). The privacy rules of the individual data providers apply to those sources.
- Links in the settings (under “Routes”: Privacy, ReGo on GitHub) open a GitHub page in the browser. GitHub will only receive a request when the page is opened; the app does not prefetch anything.
- Instant push (optional): the server sends an empty trigger via Google Firebase to the app. Google learns the device's Firebase token and the timestamp, but not the notification text. Without a Firebase key in the add-on options the app polls the server about every 15 minutes.
- Remote access runs over Tailscale (Serve: only your devices, Funnel: publicly reachable). Tailscale sees the usual connection metadata.

Status page (`/status`): shows only counts and states (version, source states, number of devices and push subscriptions, whether instant push is configured). It contains no personal data. The status page is public if the server is publicly reachable.
