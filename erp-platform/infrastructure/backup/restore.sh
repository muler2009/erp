#!/usr/bin/env bash
# Restore ONE schema from a backup directory.
#   restore.sh <backup_dir> <schema> [target_database]
# Without target_database it restores into $PGDATABASE (the live database): the schema is replaced.
# Use a scratch database first (see verify-restore.sh). Checksums are verified before anything is touched.
set -euo pipefail
DIR="${1:?backup directory}"; SCHEMA="${2:?schema name}"; TARGET="${3:-${PGDATABASE:?PGDATABASE}}"
[[ "$SCHEMA" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid schema name" >&2; exit 1; }
[[ -f "$DIR/$SCHEMA.dump" ]] || { echo "no dump for $SCHEMA in $DIR" >&2; exit 1; }
(cd "$DIR" && sha256sum --check --quiet SHA256SUMS) || { echo "checksum mismatch: backup is damaged" >&2; exit 1; }
echo "restoring $SCHEMA from $DIR into $TARGET"
# --clean --if-exists drops the schema's objects first; the dump was taken as a single transaction snapshot.
pg_restore --no-owner --clean --if-exists --single-transaction --dbname="$TARGET" "$DIR/$SCHEMA.dump"
echo "restored $SCHEMA"
