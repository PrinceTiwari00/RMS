#!/usr/bin/env bash
# Run from cron on the Docker host. Requires Node 22.5+ and, optionally, AWS CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

backup_file="$(node --experimental-strip-types --no-warnings scripts/backup-sqlite.ts)"
echo "Created verified SQLite backup: $backup_file"

# Authenticate with the EC2 instance role, not long-lived keys in .env.
# Configure S3 bucket retention/lifecycle separately from local retention.
if [[ -n "${RMS_BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$backup_file" "${RMS_BACKUP_S3_URI%/}/" --sse AES256 --only-show-errors
  echo "Copied backup to ${RMS_BACKUP_S3_URI%/}/"
fi
