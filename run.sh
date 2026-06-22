#!/usr/bin/env bash
# Build the frontend and serve the whole app (SPA + API) from FastAPI on :8000.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"

if [ ! -x "$ROOT/backend/.venv/bin/python" ]; then
  echo "Backend venv missing — run ./setup.sh first." >&2
  exit 1
fi

echo "==> Building frontend"
( cd "$ROOT/frontend" && npm run build )

echo "==> Serving on http://127.0.0.1:8000  (JAVA_HOME=$JAVA_HOME)"
cd "$ROOT/backend"
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
