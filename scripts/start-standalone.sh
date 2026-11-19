#!/usr/bin/env bash
# Run the exact standalone artifact used by the production container.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Keep local/production secrets outside Next's automatic .env build discovery.
if [[ -n "${RMS_ENV_FILE:-}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$RMS_ENV_FILE"
  set +a
elif [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ ! -f .next/standalone/server.js ]]; then
  echo "Missing .next/standalone/server.js. Run npm run build first." >&2
  exit 1
fi
node scripts/clean-standalone.mjs
rm -rf .next/standalone/.next/static
cp -a .next/static .next/standalone/.next/static
mkdir -p .next/standalone/src/db
cp src/db/schema.sql .next/standalone/src/db/schema.sql
cp src/db/control-schema.sql .next/standalone/src/db/control-schema.sql

# standalone/server.js changes cwd to its own directory. Resolve the persistent
# database location before that happens so it can never select a traced database.
export RMS_DATA_DIR="${RMS_DATA_DIR:-$ROOT/data}"
if [[ "$RMS_DATA_DIR" != /* ]]; then export RMS_DATA_DIR="$ROOT/$RMS_DATA_DIR"; fi
if [[ -n "${RMS_DB_PATH:-}" && "$RMS_DB_PATH" != /* && "$RMS_DB_PATH" != ":memory:" ]]; then
  export RMS_DB_PATH="$ROOT/$RMS_DB_PATH"
fi
export HOSTNAME="${RMS_HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-3000}"
exec node .next/standalone/server.js
