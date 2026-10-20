#!/usr/bin/env bash
# Configures outgoing mail (Infomaniak mailbox over SMTP 587). Run as root on the server:
#   sudo bash /opt/kenlod/deploy/set-mail.sh contact@kenlod.fr
# The mailbox password is typed in (never shown, never passed on the command line),
# checked against the SMTP server, then stored in /etc/kenlod.env (readable by root only).
set -euo pipefail
ADDRESS="${1:?usage: set-mail.sh <adresse>}"
HOST="${SMTP_HOST:-mail.infomaniak.com}"
read -r -s -p "Mot de passe de $ADDRESS : " PASS
echo

# Check the credentials before saving anything.
cd /opt/kenlod
SMTP_HOST="$HOST" SMTP_USER="$ADDRESS" SMTP_PASS="$PASS" node -e '
  const nodemailer = require("nodemailer");
  nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 587, requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
    .verify().then(() => console.log("Connexion SMTP : OK"))
    .catch((e) => { console.error("Connexion SMTP refusée :", e.message); process.exit(1); });'

touch /etc/kenlod.env && chmod 600 /etc/kenlod.env
sed -i '/^\(SMTP_HOST\|SMTP_PORT\|SMTP_USER\|SMTP_PASS\|MAIL_FROM\)=/d' /etc/kenlod.env
{
  echo "SMTP_HOST=$HOST"
  echo "SMTP_PORT=587"
  echo "SMTP_USER=$ADDRESS"
  printf 'SMTP_PASS=%s\n' "$PASS"
  # Quoted: the file is read by systemd and also sourced by bash (backup.sh).
  echo "MAIL_FROM=\"Kenlod <$ADDRESS>\""
} >> /etc/kenlod.env
systemctl restart kenlod
echo "Envoi des e-mails activé depuis $ADDRESS (la validation des nouveaux comptes est maintenant obligatoire)."
