#!/bin/bash
# kimi-remote: start tmux(kimi) + ttyd + proxy, print the phone URL.
cd "$(dirname "$0")" || exit 1
mkdir -p logs

# --- token (generate once, persist) ---
if [ ! -f .env ]; then touch .env; chmod 600 .env; fi
if ! grep -q '^KIMI_REMOTE_TOKEN=' .env; then
  echo "KIMI_REMOTE_TOKEN=$(openssl rand -hex 16)" >> .env
fi
TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
if [ -n "$TS_IP" ] && ! grep -q '^TAILSCALE_IP=' .env; then
  echo "TAILSCALE_IP=$TS_IP" >> .env
fi
TS_DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null)
set -a; . ./.env; set +a
PORT=${KIMI_REMOTE_PORT:-7682}

# --- 1) tmux session with kimi (persistent; attach from anywhere) ---
# (v3: без auto-scratch сесия — създавай сесии през PWA ＋ или nux; scratch
# сесиите ставаха магнит за случайни /sessions resume-и = dual-writer риск)

# --- 2) proxy + PWA server (spawns per-session ttyd lazily) ---
pkill -f "ttyd .*7681" 2>/dev/null  # v1 leftover: fixed ttyd no longer used
if ! pgrep -f "kimi-remote/server.js" >/dev/null; then
  nohup node "$PWD/server.js" >> logs/server.log 2>&1 < /dev/null & disown
  sleep 1
  echo "• kimi-remote proxy started on port $PORT"
else
  echo "• kimi-remote proxy already running"
fi

echo
echo "┌──────────────────────────────────────────────────────────────"
echo "│ 📱 Open this URL on the phone (Tailscale must be on):"
echo "│"
if [ -n "$TS_DNS" ]; then
  echo "│   https://$TS_DNS:${KIMI_REMOTE_HTTPS_PORT:-7683}/?token=$KIMI_REMOTE_TOKEN   ← use THIS one (mic needs https)"
  echo "│   http://$TS_DNS:$PORT/?token=$KIMI_REMOTE_TOKEN"
else
  echo "│   http://$TS_IP:$PORT/?token=$KIMI_REMOTE_TOKEN"
fi
echo "│"
echo "│ Local test:  http://127.0.0.1:$PORT/?token=$KIMI_REMOTE_TOKEN"
echo "│ Then: Share → Add to Home Screen → 'Kimi Remote' app icon"
echo "└──────────────────────────────────────────────────────────────"
