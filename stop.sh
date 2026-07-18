#!/bin/bash
# Stop the web layer (tmux + kimi keep running — that is the point).
# Pass --all to also kill the tmux session (terminates the kimi process inside!).
cd "$(dirname "$0")" || exit 1
pkill -f "kimi-remote/server.js" && echo "• proxy stopped"
pkill -f "ttyd .*7681" && echo "• ttyd stopped"
if [ "$1" = "--all" ]; then
  tmux kill-session -t kimi 2>/dev/null && echo "• tmux session 'kimi' killed (kimi CLI terminated)"
fi
exit 0
