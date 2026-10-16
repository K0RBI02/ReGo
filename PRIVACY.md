# Privacy Policy

ReGo is a private hobby project in beta. This document explains what data is stored and where it is sent. There are no user accounts, no advertising, and no usage analytics. The app does not load third-party scripts.

Data stored on the server (your Home-Assistant add-on)
- An anonymous random ID per device.
- Your saved routes (start, destination, days, time), settings, and the timestamp when the device last checked in (used only for cleanup).
- If you enable push: the Firebase identifier of the device (only when the app was built with immediate-push and the server has a Firebase key). The push itself contains no message text; the app fetches the text from the server.
- Pending notifications (title, text, time) are stored briefly on the profile until the device picks them up.
- No personal names or email addresses are stored. A coarse location (rounded to about 1 km) may be sent to help with sorting but is not stored permanently.
- Device-move codes ("New phone") are held only in server memory for up to 10 minutes and are not written to disk.
- To prevent abuse, the server keeps in-memory counters of how often an IP address makes requests and how many new devices originate from it. These counters are kept in RAM only and are not persisted.
- If the server requires an invitation code, it is stored only in the add-on options on the server.
- Device profiles that have not checked in for 180 days are automatically deleted. You can delete a profile anytime in the app.

Data kept only on your device
- Any invitation code you entered.
- Tickets (barcode image, holder name, validity) remain on the device and never leave it. Use the "Export tickets" backup to save them yourself. The camera is used only for reading tickets.
- The Android app is excluded from automatic Android backups (`allowBackup=false`). When switching devices, use "Export tickets" and "Move device".

Sharing and external services
- Timetable queries go from the server to providers such as MVV, Bahnland Bayern (MoBY), and ÖBB. For Deutsche Bahn routes (and as a fallback for ÖBB) the server queries the public transport service.
- Unofficial sources: publicly reachable but unsupported interfaces may be used. ReGo is a small hobby project and cannot guarantee availability or API stability for unofficial sources.
- The links in settings (under "Routes": Privacy, ReGo on GitHub) open a GitHub page in the browser; GitHub only sees your request when you open that link.
- Immediate push (optional): the server sends an empty trigger through Google Firebase. Google will learn the Firebase device identifier and the timestamp but not the message text.
- Remote access uses Tailscale when configured (Serve: limited to your devices; Funnel: public). Tailscale will see usual connection metadata.

Public status page
- The status page (`/status`) shows only numbers and states (version, source status, number of devices and push subscriptions, whether immediate push is configured). It does not display personal data.

Retention & deletion
- Temporary secrets and short-lived codes are kept in memory only and not on disk.
- Profiles are removed after 180 days of inactivity. Users can remove profiles at any time using the app.

Security
- The project uses minimal data storage and prefers in-memory-only handling for short-lived secrets.
- There are no user accounts or emails saved, and the app avoids server-side analytics.

About this project
- ReGo is a hobby project without warranties. If you rely on unofficial data sources, their availability is not guaranteed.

Contact
- For questions, open an issue on the repository: https://github.com/K0RBI02/ReGo
