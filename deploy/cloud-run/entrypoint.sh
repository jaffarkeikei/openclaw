#!/bin/sh
# Cloud Run entrypoint for OpenClaw gateway
# Copies the baked-in config to the state dir and starts the gateway.

set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
CONFIG_FILE="$STATE_DIR/openclaw.json"

mkdir -p "$STATE_DIR"

# Only copy the default config if one doesn't already exist
if [ ! -f "$CONFIG_FILE" ]; then
  cp /app/deploy/cloud-run/openclaw.json "$CONFIG_FILE"
  echo "[cloud-run] Wrote default config to $CONFIG_FILE"
else
  echo "[cloud-run] Using existing config at $CONFIG_FILE"
fi

# Inject bot tokens from environment variables into config
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  sed -i "s|__TELEGRAM_BOT_TOKEN__|$TELEGRAM_BOT_TOKEN|g" "$CONFIG_FILE"
  echo "[cloud-run] Injected TELEGRAM_BOT_TOKEN"
fi
if [ -n "$DISCORD_BOT_TOKEN" ]; then
  sed -i "s|__DISCORD_BOT_TOKEN__|$DISCORD_BOT_TOKEN|g" "$CONFIG_FILE"
  echo "[cloud-run] Injected DISCORD_BOT_TOKEN"
fi

PORT="${PORT:-8080}"

exec node openclaw.mjs gateway \
  --allow-unconfigured \
  --port "$PORT" \
  --bind lan
