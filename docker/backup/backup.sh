#!/bin/sh
# One backup run: dump -> verify -> encrypt -> upload -> exit.
#
# Required environment:
#   DATABASE_URL           postgres://... of the claude-mem database
#   BACKUP_AGE_RECIPIENT   age public key (age1...); the private key never
#                          reaches this service
#   R2_ENDPOINT            https://<account>.r2.cloudflarestorage.com
#   R2_BUCKET              bucket name
#   R2_ACCESS_KEY_ID       R2 S3 credentials scoped to that bucket
#   R2_SECRET_ACCESS_KEY
#
# Objects: daily/claude-mem-YYYY-MM-DD.dump.age every run, and on Sundays
# (UTC) also weekly/claude-mem-YYYY-MM-DD.dump.age. Deletion is the bucket's
# lifecycle rules. Vectors (observation_embeddings) are left out: the server
# recomputes them after a restore.
#
# Disk watch (optional): the database size is printed every run. With
# DB_VOLUME_BYTES set (the Postgres volume, e.g. 5000000000 on Hobby), a
# database past DB_SIZE_ALERT_PERCENT of it (default 70) fails the run after
# the upload, so the cron shows red in Railway months before writes stop.
set -eu

for var in DATABASE_URL BACKUP_AGE_RECIPIENT R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    echo "[backup] missing $var" >&2
    exit 1
  fi
done

day=$(date -u +%Y-%m-%d)
weekday=$(date -u +%u)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dump="$work/claude-mem.dump"

echo "[backup] dumping"
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --exclude-table-data=observation_embeddings \
  --dbname="$DATABASE_URL" --file="$dump"

echo "[backup] verifying"
entries=$(pg_restore --list "$dump" | grep -vc '^;')
if [ "$entries" -lt 1 ]; then
  echo "[backup] dump has no entries; refusing to upload" >&2
  exit 1
fi

echo "[backup] encrypting"
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$dump.age" "$dump"
rm -f "$dump"
size=$(wc -c < "$dump.age" | tr -d ' ')

upload() {
  curl --silent --show-error --fail --retry 3 --retry-all-errors \
    --aws-sigv4 "aws:amz:auto:s3" \
    --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
    --upload-file "$dump.age" \
    "$R2_ENDPOINT/$R2_BUCKET/$1" > /dev/null
  echo "[backup] uploaded $1 ($size bytes, $entries archive entries)"
}

upload "daily/claude-mem-$day.dump.age"
if [ "$weekday" = 7 ] || [ "${BACKUP_FORCE_WEEKLY:-}" = "1" ]; then
  upload "weekly/claude-mem-$day.dump.age"
fi
db_bytes=$(psql "$DATABASE_URL" -tAc 'SELECT pg_database_size(current_database())' | tr -d ' ')
echo "[backup] database size: $db_bytes bytes"
if [ -n "${DB_VOLUME_BYTES:-}" ]; then
  percent=$((db_bytes * 100 / DB_VOLUME_BYTES))
  echo "[backup] database uses ${percent}% of the volume"
  if [ "$percent" -ge "${DB_SIZE_ALERT_PERCENT:-70}" ]; then
    echo "[backup] ALERT: the database uses ${percent}% of its volume; resize it (Pro) or trim before writes stop" >&2
    echo "[backup] done (with disk alert)"
    exit 2
  fi
fi
echo "[backup] done"
