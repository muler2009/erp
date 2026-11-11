#!/usr/bin/env bash
# Prove a backup is restorable: restore every schema into a throw-away database and compare row counts.
#   verify-restore.sh [backup_dir]    (default: the LATEST backup under $BACKUP_DIR)
# Exit code 0 only if every schema restored and every table has the same row count as the source.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DIR="${1:-$BACKUP_DIR/$(cat "$BACKUP_DIR/LATEST")}"
SCRATCH="verify_restore_$$"
trap 'dropdb --if-exists "$SCRATCH" >/dev/null 2>&1 || true' EXIT
(cd "$DIR" && sha256sum --check --quiet SHA256SUMS)
createdb "$SCRATCH"
psql -q -d "$SCRATCH" -c "DROP SCHEMA public CASCADE"   # the public dump carries its own CREATE SCHEMA
fail=0
for dump in "$DIR"/*.dump; do
  s="$(basename "$dump" .dump)"
  pg_restore --no-owner --single-transaction --exit-on-error --dbname="$SCRATCH" "$dump"
  src=$(psql -At -d "$PGDATABASE" -c "SELECT coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint),0) FROM information_schema.tables WHERE table_schema='$s' AND table_type='BASE TABLE'")
  dst=$(psql -At -d "$SCRATCH" -c "SELECT coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint),0) FROM information_schema.tables WHERE table_schema='$s' AND table_type='BASE TABLE'")
  if [[ "$src" == "$dst" ]]; then echo "OK    $s rows=$dst"; else echo "DIFF  $s source=$src restored=$dst"; fail=1; fi
done
exit $fail
