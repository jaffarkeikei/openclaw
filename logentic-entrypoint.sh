#!/bin/sh
# Logentic Relay — startup entrypoint for OpenClaw
# Writes openclaw.json from env vars on first boot, then starts the gateway.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
mkdir -p "$STATE_DIR"

CONFIG_FILE="$STATE_DIR/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[logentic] Writing openclaw.json to $CONFIG_FILE"

  # Use Node.js (already in the image) to safely build JSON from env vars.
  node -e "
const fs = require('fs');
const path = require('path');

const stateDir = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
const configFile = path.join(stateDir, 'openclaw.json');

const config = {
  agents: {
    defaults: {
      model: process.env.OPENCLAW_MODEL || 'anthropic:claude-haiku-4-5-20251001'
    },
    list: [
      {
        id: 'seller-agent',
        identity: { name: 'Seller Agent', emoji: '🔴' },
        system: [
          'You are a professional negotiation agent representing a Seller on Logentic — a neutral, agent-powered deal platform.',
          'Your mandate: negotiate the best possible price and terms for your seller.',
          'You receive offers from the Buyer Agent and respond with counter-offers, acceptances, or rejections.',
          'Be concise, strategic, and professional. Every message should move the negotiation forward.',
          'When a decision falls outside your mandate, respond with: ESCALATE: <one-line reason>.',
          'Sign all outbound messages as: — Seller Agent'
        ].join(' ')
      },
      {
        id: 'buyer-agent',
        identity: { name: 'Buyer Agent', emoji: '🔵' },
        system: [
          'You are a professional negotiation agent representing a Buyer on Logentic — a neutral, agent-powered deal platform.',
          'Your mandate: find the best deal — lowest price, best terms — for your buyer.',
          'You receive offers from the Seller Agent and respond with counter-offers, acceptances, or rejections.',
          'Be concise, strategic, and professional. Every message should move the negotiation forward.',
          'When a decision falls outside your mandate, respond with: ESCALATE: <one-line reason>.',
          'Sign all outbound messages as: — Buyer Agent'
        ].join(' ')
      }
    ]
  },
  bindings: [
    { match: { channel: 'telegram', accountId: 'seller' }, agentId: 'seller-agent' },
    { match: { channel: 'telegram', accountId: 'buyer' },  agentId: 'buyer-agent'  }
  ],
  channels: {
    telegram: {
      accounts: {
        seller: {
          botToken:  process.env.TELEGRAM_SELLER_BOT_TOKEN || '',
          dmPolicy:  'open',
          allowFrom: ['*']
        },
        buyer: {
          botToken:  process.env.TELEGRAM_BUYER_BOT_TOKEN || '',
          dmPolicy:  'open',
          allowFrom: ['*']
        }
      }
    }
  }
};

fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
console.log('[logentic] openclaw.json written.');
"
else
  echo "[logentic] openclaw.json already exists — skipping write."
fi

# Start the OpenClaw gateway bound to all interfaces so Render can reach it.
# PORT is set by Render (default 8080). --allow-unconfigured keeps startup
# non-fatal when optional channels (e.g. WhatsApp) are not configured.
exec node /app/openclaw.mjs gateway \
  --bind lan \
  --port "${PORT:-18789}" \
  --allow-unconfigured \
  "$@"
