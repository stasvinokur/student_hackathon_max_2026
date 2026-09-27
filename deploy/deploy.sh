#!/usr/bin/env bash
# Deploys the committed HEAD to the stand and restarts it.
#   deploy/deploy.sh root@<host>
# The server keeps its own /opt/otkryvay/.env (never overwritten by this script).
set -euo pipefail

TARGET="${1:?usage: deploy/deploy.sh user@host}"
APP_DIR="${APP_DIR:-/opt/otkryvay}"
REV="$(git rev-parse --short HEAD)"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "warning: uncommitted changes are NOT deployed (deploying $REV)" >&2
fi

echo "==> uploading $REV to $TARGET:$APP_DIR"
# The submission video and presentation stay out of the stand (not export-ignore: GitHub's ZIP keeps them).
git archive --format=tar HEAD -- . ':(exclude)*.mp4' ':(exclude)*.pdf' | ssh "$TARGET" "
  set -e
  mkdir -p '$APP_DIR' && cd '$APP_DIR'
  find . -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
  tar -xf -
  echo '$REV' > REVISION
  test -f .env || { echo 'missing $APP_DIR/.env — create it from .env.example' >&2; exit 1; }
"

echo "==> building and starting"
ssh "$TARGET" "cd '$APP_DIR' && docker compose -f compose.yaml -f compose.stand.yaml up -d --build --wait --remove-orphans"
ssh "$TARGET" "cd '$APP_DIR' && docker compose -f compose.yaml -f compose.stand.yaml ps --format '{{.Service}}\t{{.State}}\t{{.Health}}'"
