#!/usr/bin/env sh
set -eu
if [ "${1:-}" = "" ]; then
  echo "usage: scripts/db-restore.sh backups/robflow-YYYYmmddTHHMMSSZ.dump" >&2
  exit 2
fi
docker compose exec -T postgres pg_restore --clean --if-exists -U "${POSTGRES_USER:-robflow}" -d "${POSTGRES_DB:-robflow}" < "$1"
