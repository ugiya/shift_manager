#!/usr/bin/env bash
# Build an OFFLINE install bundle for a disconnected (air-gapped) target.
#
#   ./make-offline-bundle.sh [--platform native|linux|windows|all]
#
# Run on a CONNECTED "staging" machine that has ./setup.sh already run (a Python 3.12
# venv at backend/.venv), Node 18+, and `uv`. Produces at the repo root, per platform:
#
#   shift_manager-offline-bundle[-<platform>].tar.gz
#     └─ source + prebuilt frontend/dist/ + offline_wheels/ + INSTALL-OFFLINE.txt
#
# Copy the tarball to the target, extract it, follow INSTALL-OFFLINE.txt. See
# docs/OPERATIONS.md §7. There is no network at runtime, and none in the target steps.
#
# Platforms:
#   native   (default)  wheels for THIS machine's OS/arch (install-verifiable here)
#   linux               wheels for Linux x86_64  (manylinux 2014/2_17/2_28, cp312)
#   windows             wheels for Windows x64   (win_amd64, cp312)
#   all                 native + linux + windows
#
# Cross-platform wheels (linux/windows) are tag-correct but cannot be *install-tested*
# from a different OS. The Windows set fixes pip's host-marker bug (uvicorn[standard]
# pulls Unix-only uvloop / drops Windows-only colorama when resolved off-Windows) by
# requesting the Windows-correct set explicitly. For a guaranteed Windows/Linux bundle,
# run this script ON that OS (`--platform native`).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
PY="$ROOT/backend/.venv/bin/python"
REQ="$ROOT/backend/requirements.txt"

PLATFORM="native"
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --platform=*) PLATFORM="${1#*=}"; shift ;;
    -h|--help) awk 'NR>1 && /^#/{sub(/^# ?/,"");print;next} NR>1{exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

[ -x "$PY" ] || { echo "ERROR: backend/.venv missing — run ./setup.sh first." >&2; exit 1; }
command -v git >/dev/null || { echo "ERROR: git is required (uses 'git archive')." >&2; exit 1; }
"$PY" -m pip --version >/dev/null 2>&1 || uv pip install --python "$PY" pip >/dev/null

# ---- build the UI once (platform-independent) -------------------------------------------
echo "==> Building the frontend (dist/)"
(
  cd "$ROOT/frontend"
  if [ -d node_modules ]; then npm run build; else npm ci && npm run build; fi
)

# ---- download wheels for a platform into $1 (dir) ---------------------------------------
download() {  # $1=platform  $2=dest-dir
  local plat="$1" dest="$2"
  mkdir -p "$dest"
  case "$plat" in
    native)
      "$PY" -m pip download -r "$REQ" -d "$dest" ;;
    linux)
      "$PY" -m pip download --only-binary=:all: \
        --platform manylinux2014_x86_64 --platform manylinux_2_17_x86_64 --platform manylinux_2_28_x86_64 \
        --python-version 3.12 --implementation cp --abi cp312 \
        -r "$REQ" -d "$dest" ;;
    windows)
      # pip evaluates uvloop/colorama markers against THIS host, not win — so request the
      # Windows-correct set explicitly: strip [standard] and add its win components + colorama,
      # drop Unix-only uvloop. The real Windows `pip install -r requirements.txt` then resolves
      # markers correctly and finds everything here.
      local wreq; wreq="$(mktemp)"
      sed 's/uvicorn\[standard\]/uvicorn/' "$REQ" > "$wreq"
      printf '%s\n' httptools python-dotenv pyyaml watchfiles websockets colorama >> "$wreq"
      "$PY" -m pip download --only-binary=:all: \
        --platform win_amd64 --python-version 3.12 --implementation cp --abi cp312 \
        -r "$wreq" -d "$dest"
      rm -f "$wreq" ;;
    *) echo "ERROR: unknown platform '$plat'." >&2; return 1 ;;
  esac
}

# ---- pack a tarball: source + dist + wheels + INSTALL-OFFLINE.txt -----------------------
pack() {  # $1=suffix(or "")  $2=wheeldir  $3=family(unix|windows)  $4=human-target
  local suffix="$1" wheeldir="$2" family="$3" target="$4"
  local name="shift_manager-offline-bundle${suffix:+-$suffix}.tar.gz"
  local S; S="$(mktemp -d)/shift_manager"; mkdir -p "$S"
  git -C "$ROOT" archive HEAD | tar -x -C "$S"          # clean tracked source only
  cp -R "$ROOT/frontend/dist" "$S/frontend/dist"        # prebuilt UI (gitignored → add it)
  cp -R "$wheeldir" "$S/offline_wheels"
  {
    echo "Shift Scheduler — offline install ($target)"
    echo "==================================================="
    echo "Target needs the SAME OS + CPU arch + Python 3.12 as this bundle ($target)."
    echo "No internet is used by these steps or at runtime."
    echo
    echo "1. From offline media, install a JDK 17+ and Python 3.12; note the JDK path."
    if [ "$family" = windows ]; then
      echo "2. cd backend"
      echo "3. py -3.12 -m venv .venv        (or: python -m venv .venv, using Python 3.12)"
      echo "4. .venv\\Scripts\\python -m pip install --no-index --find-links ..\\offline_wheels -r requirements.txt"
      echo "5. \$env:JAVA_HOME=\"C:\\path\\to\\jdk\""
      echo "6. .venv\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000   (run from backend\\)"
    else
      echo "2. cd backend"
      echo "3. python3.12 -m venv .venv"
      echo "4. .venv/bin/python -m pip install --no-index --find-links ../offline_wheels -r requirements.txt"
      echo "5. JAVA_HOME=/path/to/jdk .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000   (run from backend/)"
    fi
    echo "7. Open http://127.0.0.1:8000"
    echo
    echo "frontend/dist is prebuilt, so Node is NOT needed on the target. No database —"
    echo "back up your org with the app's Export/Import JSON."
  } > "$S/INSTALL-OFFLINE.txt"
  tar -czf "$ROOT/$name" -C "$(dirname "$S")" shift_manager
  rm -rf "$(dirname "$S")"
  echo "   packed $name ($(du -h "$ROOT/$name" | cut -f1), $(ls "$wheeldir" | wc -l | tr -d ' ') wheels)"
}

build_one() {  # $1 = native|linux|windows
  local plat="$1" d; d="$(mktemp -d)"
  echo "==> Downloading wheels: $plat"
  download "$plat" "$d"
  case "$plat" in
    native)  pack ""             "$d" unix    "$(uname -s) $(uname -m) / Python 3.12 (this machine)" ;;
    linux)   pack "linux-x86_64" "$d" unix    "Linux x86_64 / Python 3.12" ;;
    windows) pack "windows-amd64" "$d" windows "Windows x64 / Python 3.12" ;;
  esac
  rm -rf "$d"
}

case "$PLATFORM" in
  native|linux|windows) build_one "$PLATFORM" ;;
  all) for p in native linux windows; do build_one "$p"; done ;;
  *) echo "ERROR: --platform must be native|linux|windows|all (got '$PLATFORM')." >&2; exit 1 ;;
esac

echo
echo "Done. Bundles at the repo root:"
ls -lh "$ROOT"/shift_manager-offline-bundle*.tar.gz 2>/dev/null || true
echo "Copy the right one to the target, extract it, follow INSTALL-OFFLINE.txt inside."
