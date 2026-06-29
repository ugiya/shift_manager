#!/usr/bin/env bash
# Build an OFFLINE install bundle for an air-gapped (disconnected) target.
#
# Run this on a CONNECTED "staging" machine that has the SAME OS + CPU architecture
# + Python 3.12 as the target (the Timefold/JPype wheels are platform- and
# Python-version-specific). It produces, at the repo root:
#
#   offline_wheels/                      all backend pip deps, incl. Timefold's JARs
#   frontend/dist/                       the prebuilt UI (target needs no Node)
#   shift_manager-offline-bundle.tar.gz  source + dist + wheels + INSTALL-OFFLINE.txt
#
# Copy the .tar.gz to the target and follow its INSTALL-OFFLINE.txt. See
# docs/OPERATIONS.md §7. Prereq on THIS machine: ./setup.sh has been run (a Python
# 3.12 venv at backend/.venv), Node 18+, and `uv`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

WHEELS="$ROOT/offline_wheels"
BUNDLE="$ROOT/shift_manager-offline-bundle.tar.gz"
PY="$ROOT/backend/.venv/bin/python"

[ -x "$PY" ] || { echo "ERROR: backend/.venv missing — run ./setup.sh first." >&2; exit 1; }
command -v git >/dev/null || { echo "ERROR: git is required (uses 'git archive')." >&2; exit 1; }

echo "==> 1/3  Downloading backend wheels for this platform -> offline_wheels/"
# The project venv is Python 3.12 (matches the target); ensure it has pip, then download
# the full dependency closure as wheels.
"$PY" -m pip --version >/dev/null 2>&1 || uv pip install --python "$PY" pip >/dev/null
rm -rf "$WHEELS"; mkdir -p "$WHEELS"
"$PY" -m pip download -r "$ROOT/backend/requirements.txt" -d "$WHEELS"

echo "==> 2/3  Building the frontend (dist/)"
(
  cd "$ROOT/frontend"
  if [ -d node_modules ]; then npm run build; else npm ci && npm run build; fi
)

echo "==> 3/3  Packing the bundle"
STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/shift_manager"
mkdir -p "$STAGE"
git archive HEAD | tar -x -C "$STAGE"          # clean, tracked source only (no venv/node_modules/dist/summaries)
cp -R "$ROOT/frontend/dist" "$STAGE/frontend/dist"   # prebuilt UI (gitignored, so add it explicitly)
cp -R "$WHEELS" "$STAGE/offline_wheels"
cat > "$STAGE/INSTALL-OFFLINE.txt" <<'TXT'
Shift Scheduler — offline install (air-gapped target)
=====================================================
Target must have the SAME OS + CPU architecture + Python 3.12 as the machine that
built this bundle. No internet is used by these steps or at runtime.

1. From your offline media, install a JDK 17+ and Python 3.12. Note the JDK path.
2. cd backend
3. python3.12 -m venv .venv
4. .venv/bin/python -m pip install --no-index --find-links ../offline_wheels -r requirements.txt
5. cd ..
6. JAVA_HOME=/path/to/jdk   (export it; on Windows PowerShell: $env:JAVA_HOME="C:\path\to\jdk")
7. cd backend && JAVA_HOME="$JAVA_HOME" .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   (Windows: .\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000)
8. Open http://127.0.0.1:8000

frontend/dist is already built, so Node is NOT needed on the target. To save your
work without a network, use Export/Import JSON in the app (there is no database).
TXT

tar -czf "$BUNDLE" -C "$STAGE_PARENT" shift_manager
rm -rf "$STAGE_PARENT"

echo
echo "Done."
echo "  wheels : $(ls "$WHEELS" | wc -l | tr -d ' ') files in offline_wheels/"
echo "  bundle : $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
echo "Copy the .tar.gz to the target, extract it, and follow INSTALL-OFFLINE.txt inside."
