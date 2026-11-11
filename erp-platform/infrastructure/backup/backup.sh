#!/usr/bin/env bash
# Logical backup: one custom-format dump per schema (public + every tenant) and the file store, with checksums.
# A per-schema layout lets one tenant be restored without touching the others.
#
# Env: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE  BACKUP_DIR (default ./backups)  FILE_STORAGE_ROOT (optional)
#      RETENTION_DAYS (default 14)  BACKUP_UPLOAD_CMD (optional, e.g. "aws s3 sync {dir} s3://bucket/erp/")
set -euo pipefail

: "${PGDATABASE:?PGDATABASE is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$STAMP"
mkdir -p "$OUT"
umask 077

echo "backup $STAMP -> $OUT"
# Schemas: public plus every tenant schema recorded in the registry. Names come from our own table
# and are still validated before use.
SCHEMAS=$(psql -At -c "SELECT schema_name FROM tenants_tenant WHERE is_platform = false ORDER BY schema_name" || true)
for s in public $SCHEMAS; do
  [[ "$s" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "refusing odd schema name: $s" >&2; exit 1; }
  pg_dump --format=custom --no-owner --schema="$s" --file="$OUT/$s.dump"
  echo "  dumped $s ($(du -h "$OUT/$s.dump" | cut -f1))"
done

if [[ -n "${FILE_STORAGE_ROOT:-}" && -d "$FILE_STORAGE_ROOT" ]]; then
  tar -C "$FILE_STORAGE_ROOT" -czf "$OUT/files.tar.gz" .
  echo "  archived files"
fi

(cd "$OUT" && sha256sum * > SHA256SUMS)
echo "$STAMP" > "$BACKUP_DIR/LATEST"

# Prune old backups only after the new one is complete.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

if [[ -n "${BACKUP_UPLOAD_CMD:-}" ]]; then
  eval "${BACKUP_UPLOAD_CMD//\{dir\}/$OUT}"
fi
echo "backup complete"
