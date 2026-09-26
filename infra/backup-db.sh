#!/usr/bin/env bash
# Вариант для Linux VPS (на Windows используйте python infra/backup_db.py).
# Резервная копия Postgres в ОТДЕЛЬНЫЙ бакет S3-совместимого хранилища.
set -euo pipefail

TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
DUMP_FILE="/tmp/marketplace-backup-${TIMESTAMP}.dump"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required}"

trap 'curl -fsS -X POST "${BACKUP_ALERT_WEBHOOK:-http://127.0.0.1:9/}" -d "Backup FAILED at $(date -u)" || true' ERR

pg_dump "${DATABASE_URL}" --format=custom --no-owner --file="${DUMP_FILE}"

aws s3 cp "${DUMP_FILE}" \
  "s3://${BACKUP_S3_BUCKET}/postgres/${TIMESTAMP}.dump" \
  --endpoint-url "${BACKUP_S3_ENDPOINT}"

if [ "$(date -u +%u)" = "7" ]; then
  aws s3 cp "${DUMP_FILE}" \
    "s3://${BACKUP_S3_BUCKET}/postgres/weekly/${TIMESTAMP}.dump" \
    --endpoint-url "${BACKUP_S3_ENDPOINT}"
fi

rm -f "${DUMP_FILE}"

echo "Backup uploaded: ${TIMESTAMP}.dump"
