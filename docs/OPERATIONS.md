# Operations guide — install, run, test, maintain (Windows / macOS / Linux)

This is the step-by-step guide for getting the Shift Scheduler running and keeping it
running, on any of the three desktop platforms. For *what the app is* see
[`README.md`](../README.md); for the data model see [`DATA_MODEL.md`](./DATA_MODEL.md).

> **You do not need to be a developer to run this.** Follow your platform's section
> top-to-bottom. Copy/paste the commands as written.

---

## 0. What it needs (all platforms)

| Dependency | Version | Why |
|------------|---------|-----|
| **Java (JDK)** | **17 or newer** | The solver (Timefold) runs on a JVM under the hood. The app reads `JAVA_HOME` at runtime. |
| **Python** | **exactly 3.12** | Timefold / JPype have no wheels for 3.13+. 3.12 is required, not just "Python 3". |
| **Node.js** | **18 or newer** | Builds and serves the web UI. |
| **uv** | latest | Fast Python env/dependency manager used by the setup script. (Optional but recommended.) |
| A **Chromium browser** | — | Only for the end-to-end tests (Brave by default; Chrome works too). Not needed just to use the app. |

There is **no database**. The app is stateless: the "organization" you edit is a
*requirements document* held in the browser. To save your work, use **Export JSON** in the
app and re-**Import** it later (see §6, *Maintain / operate*).

The app serves the UI and the API together at **http://127.0.0.1:8000**.

---

## 1. macOS

### Install prerequisites (Homebrew)
```bash
# Homebrew: https://brew.sh  (install it first if you don't have it)
brew install openjdk@21 node uv
# Java for the app: the scripts default JAVA_HOME to Homebrew's openjdk@21.
```

### Set up, run, test
```bash
cd /path/to/shift_manager
./setup.sh        # one-time: creates the Python 3.12 venv + installs all deps
./run.sh          # builds the UI and serves everything on http://127.0.0.1:8000
./test.sh         # (optional) backend + end-to-end tests
```
Open http://127.0.0.1:8000. Press **Generate schedule**. Stop the server with `Ctrl+C`.

If your JDK is elsewhere, set it first: `export JAVA_HOME="$(/usr/libexec/java_home -v 17+)"`.

---

## 2. Linux

### Install prerequisites
Debian / Ubuntu:
```bash
sudo apt update
sudo apt install -y openjdk-21-jdk nodejs npm
curl -LsSf https://astral.sh/uv/install.sh | sh    # installs `uv`; restart your shell
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 # adjust to your distro's path
```
Fedora / RHEL:
```bash
sudo dnf install -y java-21-openjdk-devel nodejs
curl -LsSf https://astral.sh/uv/install.sh | sh
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
```
> `uv` provides Python 3.12 automatically (`uv venv --python 3.12` downloads it if missing),
> so you don't need a system Python 3.12. Find your JDK path with `readlink -f "$(which java)"`
> if the ones above don't match. Put the `export JAVA_HOME=...` line in `~/.bashrc` to persist it.

### Set up, run, test
```bash
cd /path/to/shift_manager
./setup.sh
JAVA_HOME="$JAVA_HOME" ./run.sh       # serves on http://127.0.0.1:8000
JAVA_HOME="$JAVA_HOME" ./test.sh      # optional
```

---

## 3. Windows

You have two options. **WSL2 is the smoothest** (you then just follow the Linux steps);
native PowerShell works too but uses manual commands (the `.sh` scripts don't run there).

### Option A — WSL2 (recommended)
```powershell
wsl --install        # in an admin PowerShell; installs Ubuntu. Reboot if prompted.
```
Then open **Ubuntu** and follow **§2 Linux** exactly (the repo lives under your WSL home,
e.g. `~/shift_manager`, or access the Windows copy under `/mnt/c/...`). Open
http://127.0.0.1:8000 in your normal Windows browser.

### Option B — native Windows (PowerShell)
Install prerequisites with `winget`:
```powershell
winget install EclipseAdoptium.Temurin.21.JDK
winget install OpenJS.NodeJS.LTS
winget install astral-sh.uv
# Open a NEW PowerShell window so PATH updates take effect.
```
Set `JAVA_HOME` (adjust the version folder to what got installed):
```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.4.7-hotspot"
# To persist across sessions:
[Environment]::SetEnvironmentVariable("JAVA_HOME", $env:JAVA_HOME, "User")
```
Set up:
```powershell
cd C:\path\to\shift_manager
cd backend
uv venv --python 3.12
uv pip install -r requirements.txt
cd ..\frontend
npm install
cd ..
```
Run (builds the UI, then serves on http://127.0.0.1:8000):
```powershell
cd frontend; npm run build; cd ..
cd backend
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
Open http://127.0.0.1:8000. Stop with `Ctrl+C`.

Run tests (native Windows):
```powershell
cd backend; .\.venv\Scripts\python -m pytest -q; cd ..
cd frontend; npm run build
# point Playwright at an installed Chromium browser:
$env:BRAVE_PATH = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
npx playwright test
```
If you don't have Brave, install Playwright's bundled Chromium instead
(`npx playwright install chromium`) and set the project's `executablePath` accordingly, or
set `BRAVE_PATH` to your Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`.

---

## 4. Daily run (after the one-time setup)

| Platform | Start the app | Stop |
|----------|---------------|------|
| macOS / Linux / WSL | `./run.sh` | `Ctrl+C` |
| Windows (native) | `cd frontend; npm run build; cd ..\backend; .\.venv\Scripts\python -m uvicorn app.main:app --port 8000` | `Ctrl+C` |

Then open **http://127.0.0.1:8000**. There's nothing else to start — one process serves
both the UI and the API.

**Hot-reload dev mode** (only if you're changing the code): run the backend on `:8000`
and, in a second terminal, `cd frontend && npm run dev` (UI on `http://localhost:5173`,
proxied to the backend).

---

## 5. Running the tests

| Platform | Command |
|----------|---------|
| macOS / Linux / WSL | `./test.sh` |
| Windows (native) | see §3 Option B, "Run tests" |

`test.sh` runs the backend unit tests (pytest), builds the UI, then the end-to-end tests
(Playwright). The e2e tests need a Chromium browser (Brave by default; override with the
`BRAVE_PATH` environment variable). Expected today: **backend 937 passed, e2e 87 passed**.

---

## 6. Maintain / operate

**Saving and restoring your data (important — there is no database).**
The app is stateless; your edited org lives only in the browser tab. To keep it:
- In the app, open **Requirements → Export JSON** to download the full document (lossless).
- To restore it later (or move it to another machine), use **Import** and pick that file.
- CSV export is a *lossy* employee roster only (no carry-over) — use JSON for a true backup.
- Carry a solved week into the next with the **Carry to …** button (carry-over).

**Updating to a newer version of the code.**
```bash
git pull
./setup.sh          # re-installs deps if requirements/package.json changed
./run.sh
```
(Windows native: `git pull`, then re-run the `uv pip install` / `npm install` steps from §3.)

**The port (8000) is busy / a stale server is running.**
Something is already on `:8000` (often a previous run). Free it:
- macOS / Linux / WSL: `lsof -ti tcp:8000 | xargs kill`
- Windows (PowerShell): `Get-NetTCPConnection -LocalPort 8000 | Select-Object -Expand OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }`
This also matters before tests: the e2e runner reuses an existing `:8000` server, so a stale
one can serve old code — kill it first.

**Common problems**
| Symptom | Fix |
|---------|-----|
| App won't start; JVM / `JAVA_HOME` error | A JDK 17+ must be installed and `JAVA_HOME` set to it (see your platform's section). |
| `pip`/`uv` fails building Timefold or JPype | You're not on Python **3.12**. Recreate the venv: `uv venv --python 3.12`. |
| Blank page / old behaviour after an update | Rebuild the UI: `cd frontend && npm run build`, then restart the server. |
| e2e can't find a browser | Set `BRAVE_PATH` to your Brave/Chrome executable, or `npx playwright install chromium`. |
| A view shows a crash screen | Click **Try again** (or **Reload page**). Errors are recoverable without losing the server. |

**Where things are** (for operators):
- Backend code: `backend/app/` · tests: `backend/tests/`
- Frontend code: `frontend/src/` · tests: `frontend/e2e/`
- Data model (authoritative): `docs/DATA_MODEL.md` · domain glossary: `CONTEXT.md`
- Decisions: `docs/adr/` · contributor guardrails: `CLAUDE.md`

There are no secrets, no external services, and no network calls — the app runs entirely
on `localhost`. Backups = exported JSON files; keep them wherever you keep documents.

---

## 7. Offline / air-gapped (disconnected) install

**At runtime the app needs no network** — no CDN, web fonts, analytics, outbound API calls, or
runtime downloads; the UI is served from `localhost`, and the solver runs a local JVM against
JARs bundled inside the Timefold package. Only **installation** pulls from the internet. So a
disconnected machine needs, at run time, just three things:

1. **A JDK 17+** (with `JAVA_HOME` set to it),
2. **Python 3.12** with the backend dependencies installed (the `backend/.venv`),
3. **A prebuilt `frontend/dist/`** (Node is *build-time only* — not needed to run).

(The Brave/Chrome browser + Playwright are only for the e2e tests, never to run the app.)

### Easiest: set up once while connected, then disconnect
If the machine can reach the internet **once**, run `./setup.sh` (and `./run.sh` once to build
`dist/`) while online. After that it runs fully offline. On the disconnected machine **don't use
`./run.sh`** (it rebuilds `dist/`, which needs Node) — `dist/` is already built, so start the
server directly:
```bash
cd backend
JAVA_HOME=/path/to/jdk .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# open http://127.0.0.1:8000
```

### Truly air-gapped target (never online): build a bundle on a staging machine
On a **connected** machine with the **same OS + CPU architecture + Python 3.12** as the target
(the Timefold/JPype wheels are platform- and Python-version-specific), after `./setup.sh`:
```bash
./make-offline-bundle.sh
```
This produces `shift_manager-offline-bundle.tar.gz` (source + prebuilt `dist/` +
`offline_wheels/` + an `INSTALL-OFFLINE.txt`). It does, equivalently, by hand:
```bash
backend/.venv/bin/python -m pip download -r backend/requirements.txt -d offline_wheels   # all wheels incl. Timefold JARs
cd frontend && npm run build                                                              # prebuild dist/
```
Copy the `.tar.gz` to the target (plus offline installers for a **JDK 17+** and **Python 3.12**),
extract it, and follow `INSTALL-OFFLINE.txt`:
```bash
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install --no-index --find-links ../offline_wheels -r requirements.txt
cd .. && cd backend && JAVA_HOME=/path/to/jdk .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
No Node on the target (`dist/` is prebuilt), no database, no network. If the target's OS/arch or
Python minor version differs from the staging machine, the wheels won't match — rebuild the
bundle on a matching staging machine.
