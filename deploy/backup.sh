#!/usr/bin/env bash
# Daily backup of the Kenlod database (files already live in the bucket).
set -euo pipefail
set -a
. /etc/kenlod.env
set +a
cd /opt/kenlod
DATA_DIR=/var/lib/kenlod BACKUP_DIR=/var/backups/kenlod \
  /usr/bin/node --disable-warning=ExperimentalWarning server/backup.js >> /var/log/kenlod-backup.log 2>&1
