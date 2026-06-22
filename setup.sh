#!/usr/bin/env bash
# One-time setup: backend venv (Python 3.12) + frontend deps.
# Prerequisite: a JDK 17+ (e.g. `brew install openjdk@21`), Python 3.12 via uv,
# and Node 18+. See README.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Backend: creating Python 3.12 venv + installing deps"
cd "$ROOT/backend"
uv venv --python 3.12
uv pip install -r requirements.txt

echo "==> Frontend: installing npm deps + Playwright is configured to use Brave"
cd "$ROOT/frontend"
npm install

echo "Done. Now run ./run.sh (app) or ./test.sh (all tests)."
