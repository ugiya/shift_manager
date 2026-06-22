#!/usr/bin/env bash
# Run the full test suite: backend (pytest) + e2e (Playwright CLI on Brave).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
# Point Playwright at Brave (override with BRAVE_PATH if installed elsewhere).
export BRAVE_PATH="${BRAVE_PATH:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"

echo "==> Backend tests (pytest)  JAVA_HOME=$JAVA_HOME"
( cd "$ROOT/backend" && .venv/bin/python -m pytest -q )

echo "==> Building frontend for e2e"
( cd "$ROOT/frontend" && npm run build )

echo "==> e2e tests (Playwright CLI driving Brave)"
# Playwright's webServer starts the backend (serving the built SPA) if needed.
( cd "$ROOT/frontend" && npx playwright test )

echo "All tests passed."
