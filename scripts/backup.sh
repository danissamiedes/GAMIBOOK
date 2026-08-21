#!/bin/sh
# Daily backup of the books and the storage volume (SPEC §13).
#
#   ./scripts/backup.sh /var/backups/ledger
#
# From cron, at 02:15 every day:
#   15 2 * * * cd /srv/ledger && ./scripts/backup.sh /var/backups/ledger >> /var/log/ledger-backup.log 2>&1
#
# A backup on the same machine as the database is not a backup — it dies with
# the box. Copy the output somewhere else (rclone, restic, scp) as a second
# step, and read RESTORING below before you need it.
set -eu

DEST="${1:-./backups}"
COMPOSE="${COMPOSE_FILE:-docker-compose.prod.yml}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%F)"

mkdir -p "$DEST"

# -Fc is the custom format: compressed, and pg_restore can be selective with it.
# Write to a temporary name and move it into place only on success, so a failed
# dump never leaves a plausible-looking file for tomorrow's cleanup to keep.
docker compose -f "$COMPOSE" exec -T db pg_dump -U ledger -Fc ledger > "$DEST/.ledger-$STAMP.dump.part"
mv "$DEST/.ledger-$STAMP.dump.part" "$DEST/ledger-$STAMP.dump"

# Receipts, logos, uploaded imports and cached PDFs. The PDFs regenerate; the
# receipts and the import files do not.
#
# A one-off container from the app service: it gets the same storage mount
# without needing the volume's Compose-prefixed name, and it works whether or
# not the app itself is currently up. --no-deps keeps it from starting Postgres.
docker compose -f "$COMPOSE" run --rm --no-deps \
  -v "$(cd "$DEST" && pwd)":/backup app \
  tar czf "/backup/.storage-$STAMP.tar.gz.part" -C /data/storage .
mv "$DEST/.storage-$STAMP.tar.gz.part" "$DEST/storage-$STAMP.tar.gz"

find "$DEST" -name 'ledger-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'storage-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name '.*.part' -mtime +1 -delete

printf '%s  ledger-%s.dump  %s\n' "$(date -Is)" "$STAMP" "$(du -h "$DEST/ledger-$STAMP.dump" | cut -f1)"

# RESTORING — see "Backup and restore" in README.md. The short version: stop the
# app first, because a database with a connection open to it cannot be dropped.
