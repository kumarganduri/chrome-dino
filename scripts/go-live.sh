#!/usr/bin/env bash
# One-time go-live. Run only after approving: it publishes code and creates
# paid infrastructure.
#
#   1. push to gitlab.com/kumarganduri14/chrome-dino (repo-local SSH key)
#   2. create Fly app dino-forever-kumar (sin) + 1 GB volume, set DEPLOY_KEY
#   3. deploy the live server
#   4. write ~/.dino-forever.env so trainer/sync.ts can talk to the server
#
# Afterwards, in GitLab: make the project public (Settings → General →
# Visibility).
# (optional: web/config.js already points at the Fly app; FLY_API_TOKEN enables deploy-on-push).
set -euo pipefail
cd "$(dirname "$0")/.."

APP=dino-forever-kumar
REGION=sin

echo "▶ 1/4 pushing to GitLab…"
git push -u origin main

echo "▶ 2/4 creating Fly app + volume…"
if ! fly status --app "$APP" >/dev/null 2>&1; then
  fly apps create "$APP"
fi
if ! fly volumes list --app "$APP" 2>/dev/null | grep -q dino_data; then
  fly volumes create dino_data --app "$APP" --region "$REGION" --size 1 --yes
fi
if [ ! -f "$HOME/.dino-forever.env" ]; then
  KEY=$(openssl rand -hex 24)
  umask 077
  printf 'DINO_SERVER=https://%s.fly.dev\nDINO_DEPLOY_KEY=%s\n' "$APP" "$KEY" > "$HOME/.dino-forever.env"
fi
KEY=$(grep DINO_DEPLOY_KEY "$HOME/.dino-forever.env" | cut -d= -f2)
fly secrets set --app "$APP" --stage DEPLOY_KEY="$KEY" >/dev/null

echo "▶ 3/4 deploying…"
fly deploy --app "$APP" --remote-only

echo "▶ 4/4 checking…"
curl -fsS "https://$APP.fly.dev/api/health" && echo
node trainer/sync.ts --once

echo
echo "Live server: https://$APP.fly.dev   (serves the full site too)"
echo "Pages:       https://kumarganduri14.gitlab.io/chrome-dino   (after making the project public + CI runs)"
