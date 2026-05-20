#!/usr/bin/env sh
set -eu
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/robflow-$STAMP.dump"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-robflow}" -d "${POSTGRES_DB:-robflow}" -Fc > "$OUT"
echo "$OUT"
