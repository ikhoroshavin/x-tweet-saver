#!/usr/bin/env bash
# Автообновление аддона на VPS: fetch → reset на origin/main → сборка подписанного CRX.
# Запускается systemd-таймером (xts-ext-update.timer) раз в 5 минут.
# Сборка идемпотентна: если версия не выросла (коммитов в файлы расширения нет) — no-op.
# nginx (wallapp.tech, location /ext/) раздаёт готовые updates.xml и x-tweet-saver.crx.
set -euo pipefail

DIR=${XTS_EXT_DIR:-/opt/x-tweet-saver-ext}
BRANCH=${XTS_EXT_BRANCH:-main}
KEY=${XTS_EXT_KEY:-/etc/xts-ext/key.pem}
OUT=${XTS_EXT_OUT:-/opt/ext-updates/x-tweet-saver}
BASE_URL=${XTS_EXT_BASE_URL:-https://wallapp.tech/ext/x-tweet-saver}

cd "$DIR"

git fetch --quiet origin "$BRANCH" || { echo "fetch failed"; exit 0; }
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "Update: $LOCAL -> $REMOTE"
    git reset --hard "origin/$BRANCH"
fi

# Сборка вне условия выше: первый запуск (нет dist/) и повтор после сбоя тоже соберут.
python3 tools/build_crx.py --key "$KEY" --out "$OUT" --base-url "$BASE_URL" --if-changed
