#!/usr/bin/env bash
# Installs or updates Kenlod on a fresh Ubuntu 24.04 server. Run as root:
#   bash setup.sh <domaine1> [domaine2 ...]
# The application archive must be at /tmp/kenlod.tgz.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: setup.sh <domain> [domain...]"; exit 1; }
DOMAINS="$*"
export DEBIAN_FRONTEND=noninteractive

# Small droplets (512 MB) need swap for apt and npm.
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null || ! node -v | grep -q '^v24'; then
  apt-get update -q
  apt-get install -yq curl ca-certificates gnupg ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -yq nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

id kenlod >/dev/null 2>&1 || useradd --system --home /var/lib/kenlod --shell /usr/sbin/nologin kenlod
mkdir -p /opt/kenlod /var/lib/kenlod /var/backups/kenlod
chown kenlod:kenlod /var/lib/kenlod
chmod 700 /var/lib/kenlod /var/backups/kenlod

# Deploy code (data lives in /var/lib/kenlod and is never touched here).
rm -rf /opt/kenlod.new
mkdir /opt/kenlod.new
tar xzf /tmp/kenlod.tgz -C /opt/kenlod.new
(cd /opt/kenlod.new && npm ci --omit=dev --no-audit --no-fund)
rm -rf /opt/kenlod.old
[ -d /opt/kenlod ] && mv /opt/kenlod /opt/kenlod.old
mv /opt/kenlod.new /opt/kenlod

install -m 644 /opt/kenlod/deploy/kenlod.service /etc/systemd/system/kenlod.service
touch /etc/kenlod.env && chmod 600 /etc/kenlod.env
# Links in e-mails point to the first domain.
grep -q '^APP_URL=' /etc/kenlod.env || echo "APP_URL=https://$1" >> /etc/kenlod.env

# The first domain serves the site, the others redirect to it.
MAIN="$1"
shift
cat > /etc/caddy/Caddyfile <<EOF
$MAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	header -Server
	log {
		output file /var/log/caddy/kenlod.log {
			roll_size 20mb
			roll_keep 5
			roll_keep_for 2160h
		}
	}
}
EOF
for d in "$@"; do
  printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$d" "$MAIN" >> /etc/caddy/Caddyfile
done

install -m 755 /opt/kenlod/deploy/backup.sh /etc/cron.daily/kenlod-backup

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable kenlod >/dev/null 2>&1
systemctl restart kenlod
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:3000/api/auth/me && break; sleep 1; done
systemctl is-active kenlod caddy
curl -fsS -o /dev/null -w 'app: HTTP %{http_code}\n' http://127.0.0.1:3000/api/auth/me
