---
paths:
  - ".github/**"
  - "rego/**"
  - "repository.yaml"
  - "package.json"
  - "package-lock.json"
  - "server/config.mjs"
  - "*.md"
---

# CI, releasing, documentation and the add-on

Loaded when you touch workflows, `rego/`, version files, `server/config.mjs` or the documents.

## The workflows

**`.github/workflows/build.yml` ("Build add-on")** – on every push to `main` that touches `rego/**`, `server/**`, `public/**`, `scripts/**`, `test/**`, `package.json`, `package-lock.json` or the workflow itself (and by hand); on a pull request (Dependabot's) only `test` and `screen-test` run:
1. `test` – Node 22, `npm ci`, `npm test`.
2. `screen-test` – `npm ci`, `npm install --no-save playwright`, `npx playwright install --with-deps chromium`, `node scripts/ui-smoke.mjs`.
3. `build` – only after both are green: builds `rego/Dockerfile` with the repository root as context for `aarch64` (runner `ubuntu-24.04-arm`) and `amd64`, and pushes `ghcr.io/<owner>/rego-addon-<arch>:<version>` and `:latest` (`<version>` is read from `rego/config.yaml`).

**`.github/workflows/apk.yml` ("Build Android app (APK)")** – on every push to `main` that touches `android/**`, `public/**` or the workflow, and by hand (optional input `host`):
1. version from `rego/config.yaml`; server address from the input, else the repository variable `REGO_HOST`, else a built-in default;
2. **guard:** the job stops with a clear message when the release `app-v<version>` does not exist yet and `APP_LATEST` in `server/config.mjs` is not that version. The workflow reads the value with `sed` from the line `export const APP_LATEST = '<version>';`, so keep that line exactly in that shape;
3. Firebase: `android/app/google-services.json` is written from the secret `GOOGLE_SERVICES_JSON_B64`; without it the APK is built without instant push (warning in the log);
4. signing: keystore from the secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD`; without them the APK is signed with the debug key and cannot be installed over a properly signed one;
5. `gradle -p android assembleRelease` (Java 17, Gradle 8.9 installed by the workflow) with `-PrgHost`, `-PrgVersionName=<version>` and `-PrgVersionCode=<run number of the workflow>`;
6. the file is named `rego-<version>.apk`, uploaded as a workflow artifact and attached to the GitHub release `app-v<version>` (created if it is missing; a file of the same name is replaced).

**CodeQL** (GitHub's default setup, not a file in the repository) runs on every push.

A commit that touches only other files (`CLAUDE.md`, `README.md`, `BACKEND.md`, `PRIVACY.md`, …) starts neither build. Note that `rego/CHANGELOG.md` and `rego/DOCS.md` are under `rego/` and do start `build.yml`.

## Cutting a release

Korbi decides that something is a release and which number it gets. Releases are small and frequent (one topic each) and every user-visible change ships as one. Everything goes to `main` directly; there are no feature branches or pull requests unless Korbi asks for one.

1. Raise `version` in `package.json`, in `package-lock.json` (at the top and under `packages[""]`) **and** in `rego/config.yaml` (the same number; `rego/config.yaml` is the source of truth for CI). `npm version <x.y.z> --no-git-tag-version` changes both npm files at once.
2. Add a heading `## <version> – <title>` at the top of `rego/CHANGELOG.md`, right below `# Changelog` (English, en dash, short title in sentence case, for example `## 0.8.12 – An error report you can save`). A test (`features.test.mjs`) checks that package.json, the lock file, config.yaml and the newest changelog heading agree; it reads the number with `^##\s*\[?v?(\d+\.\d+\.\d+)`.
3. If `public/` or `android/` changed in this release, set `APP_LATEST` in `server/config.mjs` to the new version, so that older apps get the update hint. A release that changes only the server leaves `APP_LATEST` alone (no APK is built for it). `beta.test.mjs` checks that it is a real version and never ahead of the server's.
4. Update the documents that the change touches (see 'Which document to touch').
5. `npm test`; the screen test if `public/` changed.
6. Commit: first line `Release <version>: <what changes for the user, short>`, then an English body (what and why, by area), then the two `Co-Authored-By` trailers from rule 5 in `CLAUDE.md`.
7. Push to `main` and watch CI (`gh run list`, or the Actions tab): tests, screen test, add-on images, APK (when `public/` or `android/` changed), CodeQL. A red `main` is worse than a late release: fix forward at once and tell Korbi.
8. Tell Korbi in German what to do: install the new APK from the GitHub release `app-v<version>` and/or update the add-on in Home Assistant, and which screens changed.

**Changelog style.** English. Bold labels per area (`**Main screen**`, `**Routes**`, `**Timetable sources**`, `**API**`, `**App**`, `**Log**`, …), then bullets that say what the user sees now and, for a fix, what was wrong before; real German UI strings in quotes; numbers and thresholds named. A change to the HTTP API gets an `**API**` block (fields added, what an older app or server does with them). Every entry ends with a **`**Rebuild**`** paragraph: what to install (the new APK `app-v<version>`, the add-on update, or both) and the compatibility sentence ("The new app also works with an older server, and an older app keeps working with the new server."). Look at the entries from 0.8.0 on as a model; the 0.1–0.4 entries are terse one-liners from the beta days.

## Who gets what – and the compatibility rule

| Changed | Phone | Server (Raspberry Pi) |
|---|---|---|
| only `server/`, `rego/`, `scripts/`, `test/` | nothing to do | add-on update (version must be higher, or Home Assistant shows nothing) |
| `public/` or `android/` | new APK installed by hand (the update hint tells older apps) | add-on update as well, because the server serves the UI too |

**Old app with new server, and new app with old server must both keep working.** APKs are installed by hand at different times and the add-on is updated separately, so at any moment several app versions talk to one server version. In practice: add API fields, never repurpose or remove them while an app that reads them can exist (`rows` is kept for old UIs, `skips` stays next to `hidden`, the server still accepts `pushWindow` and ignores it); the UI must work when a new field is missing (it takes the numbers from `skips` when there is no `hidden`) and the server must work when an old app does not send a new parameter; profiles on disk must keep loading, so new profile fields are optional with a default and existing keys are never renamed. Say in the changelog what an older counterpart does.

**Push to `public/` or `android/` means an APK build.** Every such push builds an APK and publishes `rego-<version>.apk` under the release of the version in `rego/config.yaml`; with an unchanged version this silently replaces the file of an existing release (with a higher `versionCode`). That is one more reason why UI changes normally go out together with a release. In the same way a push that touches `server/`, `public/`, `rego/` and so on rebuilds the add-on image `:<version>` and `:latest`; a Pi only picks it up when the version number is higher.

## Which document to touch

| If you change … | … update |
|---|---|
| what the app does for the user (screens, texts, permissions, install steps) | `README.md` ("In the app", "Permissions", "Install") |
| the HTTP API, the state, a rule (window, transfers, push), a source, a config variable | `BACKEND.md` (the table or paragraph that describes it) |
| what is stored, where, for how long, or what is sent to whom | `PRIVACY.md` **and** the privacy part of `README.md`; the statements there must stay true |
| an add-on option | `rego/config.yaml` (`options` **and** `schema`), `rego/run.sh`, `rego/DOCS.md`, the configuration table in `BACKEND.md` |
| anything that ships | `rego/CHANGELOG.md` (see 'Cutting a release') |
| the structure of the code, a rule that matters, a decision, a trap | `CLAUDE.md` or the `.claude/rules/` file of the area |

Documents are English and plain (Home Assistant shows `rego/CHANGELOG.md` and `rego/DOCS.md` inside its own UI; no HTML there). The app's texts are German. Comments in code explain *why*. A statement in a document that is no longer true is a bug.

## The Home Assistant add-on (`rego/`)

- `config.yaml`: slug `rego`, architectures `aarch64` and `amd64`, image `ghcr.io/k0rbi02/rego-addon-{arch}`, port 8080, watchdog on `/api/health`. Options: `contact`, `invite_code` (password), `provider` (`library` | `transport-rest` | `mock`), `ts_mode` (`off` | `serve` | `funnel`), `ts_hostname`, `ts_authkey` (password), `fcm_key` (password). Adding or changing an option means changing `config.yaml` (options **and** schema), `run.sh`, `rego/DOCS.md` and, if it maps to a variable, BACKEND.md.
- `Dockerfile`: built by CI with the repository root as context (the Pi only pulls). Base `node:22-alpine`; the `tailscaled` and `tailscale` binaries are copied from the official Tailscale image; `npm ci --omit=dev` from `package.json` and `package-lock.json`; copies `server/`, `public/`, `rego/config.yaml` (as `/app/config.yaml`, which is how the server reads its version in the container) and `rego/run.sh`. `.dockerignore` keeps `node_modules`, `data`, `dist`, `test`, `.git`, `.github` and zip files out of the build context.
- `run.sh`: reads `/data/options.json`; exports `HOST=0.0.0.0 PORT=8080 REGO_DATA=/data REGO_VERBOSE=1` and `NODE_OPTIONS=--dns-result-order=ipv4first` (bahn.de hangs over IPv6); maps options to `REGO_PROVIDER`, `REGO_FCM_KEY`, `REGO_INVITE`, `REGO_CONTACT`; runs a network self-test (bahn.de over IPv4 and IPv6, MVV) so the log shows what the container can reach; optionally starts `tailscaled` in userspace networking (state in `/data/tailscale`) and `tailscale serve` or `funnel --bg 8080`; then `exec node server/index.mjs`. `/data` survives add-on updates; never ask the user to uninstall (that loses the Tailscale login and all profiles).
- Updating: Home Assistant shows an Update button when `version` in `rego/config.yaml` (as published) is newer than the installed one and the image `…:<version>` exists. The image is built by `build.yml` on every push that touches `rego/`, `server/`, `public/`, `scripts/`, `test/`, `package.json` or `package-lock.json`.

## Dependencies, the lock file and Dependabot

- `package-lock.json` pins `hafas-client` and everything below it. CI and the add-on image install with `npm ci`, which takes exactly the lock file and fails when it does not match `package.json`. Without it every image build took the newest `hafas-client` 6.x, and an update could change how ÖBB answers without any commit.
- Changing a dependency: `npm install <package>@<version>` (it rewrites both files), commit `package.json` and `package-lock.json` together, run `npm test`. The one-dependency rule in `CLAUDE.md` still holds.
- `.github/dependabot.yml` looks every Monday for npm updates and for new versions of the workflow actions, and opens at most 3 pull requests of each kind. They are the one kind of pull request in this repository. On the pull request `build.yml` runs the unit tests and the screen test but builds no image; merge only when both are green. Merging into `main` runs them again and rebuilds the add-on image under the current version, which a Pi only picks up with the next release. So a dependency update ships with a release, and its changelog entry says so. A major update (`hafas-client` 7) changes the range in `package.json`; read its changelog first, the ÖBB client (`server/providers/lib.mjs`) depends on its API.
- Workflow actions are on their newest major version, all on Node 24. The exception is `gradle/actions/setup-gradle`, kept on v5 and excluded from major updates in `dependabot.yml`: from v6 its caching is a proprietary component under its own licence. An action update that touches only `apk.yml` runs no check on the pull request; it is proven by the APK build after the merge, which republishes the APK of the current version.

## Adding or changing an add-on option

`rego/config.yaml` (`options` **and** `schema`), `rego/run.sh` (read the option, export the variable), `rego/DOCS.md`, and – when it maps to an environment variable – `server/config.mjs` and the configuration table in `BACKEND.md`. Secrets are `password?` in the schema and are never echoed to the log.

## Traps

- **Pushing `public/` or `android/` builds and republishes the APK** (see 'Who gets what'). A docs-only commit (`CLAUDE.md`, `.claude/`, `README.md`, `BACKEND.md`, `PRIVACY.md`) starts neither build; `rego/CHANGELOG.md` and `rego/DOCS.md` sit under `rego/` and do start `build.yml`.
- **Keep `export const APP_LATEST = '<version>';` in exactly that shape**; the APK workflow reads it with `sed`.
- **Every APK build gets a higher `versionCode`; the signing key must stay the same** (`android.md`).
- **Do not suggest uninstalling the add-on as a fix:** it deletes all profiles and the Tailscale login (`/data`).
