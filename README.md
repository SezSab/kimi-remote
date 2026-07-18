# Kimi Remote

Control your live **Kimi CLI** sessions from your phone (or any browser) — a
self-hosted PWA over tmux, with a native-feeling chat view, real-time swarm
progress, push notifications and voice input. Zero npm dependencies.

Think *Claude Remote / Codex Remote*, but for [Kimi CLI](https://kimi.com) —
and it runs entirely on your own machine.

## Highlights

- **Live chat view** backed by the session's `wire.jsonl` — real events
  (messages, thinking, tool calls with `−/+` diffs), not screen scraping.
  Pushed over SSE the instant they happen; no polling.
- **Agent Swarm dashboard** — per-agent progress bars (ported from Kimi's own
  progress estimator), live actions (`Grep · src/api.py`), done/running counts —
  in the session and on the session list cards.
- **Web Push notifications** — approval needed (with the exact command),
  question asked, long turn finished, swarm complete. Implemented from scratch
  (RFC 8291 / 8292) with Node's `crypto` — no dependencies.
- **Optimistic sends with delivery states** — pale bubble instantly, confirmed
  when the model picks it up, red + *Resend* on network failure. Messages typed
  while the model works queue locally with a *Steer* button to inject them into
  the running turn instead.
- **Voice input** — realtime speech-to-text via [Soniox](https://soniox.com)
  (bring your own API key): live partials while you speak, editable text, send.
- **Subscription quota card** — weekly / 5-hour windows with progress bars and
  reset countdowns, parallel slots in use — straight from the same endpoint the
  CLI's `/usage` uses.
- **Session history** — browse past Kimi sessions, resume any of them into a
  fresh tmux session with one tap.
- **Terminal view too** — full ttyd terminal with gesture scrolling when you
  need the real thing.
- **iOS-grade PWA** — installable, keyboard-aware layout, auto-updates itself
  on open when the server has a newer build.

## How it works

```
📱 PWA (Add to Home Screen)  /  💻 any browser
        │  https (LAN / VPN / tailnet)
        ▼
server.js — zero-dependency Node
  ├─ static PWA shell + token-cookie auth
  ├─ REST + SSE API (sessions, chat stream, swarm, quota, push, files)
  └─ /term/<name>/ → per-session ttyd (lazy, idle-reaped)
        └─ tmux attach → 🟢 the live kimi process
```

- **tmux owns the kimi processes** — they survive every disconnect; desktop
  and phone attach to the *same* live session.
- The chat view reads the linked session's `wire.jsonl` with a byte-offset
  incremental parser; new bytes are parsed once and broadcast to subscribers.
- Pane ↔ session mapping is locked persistently (scrollback banner detection
  with a heuristic + self-healing fallback for silent `/sessions` resumes).

## Setup

Requirements: macOS or Linux, `tmux`, `ttyd`, Node 18+, and the Kimi CLI
logged in.

```bash
git clone https://github.com/SezSab/kimi-remote
cd kimi-remote
cp .env.example .env         # set KIMI_REMOTE_TOKEN (any random string)
./start.sh                   # prints the URL with the auth token
```

Open the printed URL on your phone once (the `?token=` sets a year-long
cookie), then *Share → Add to Home Screen*.

### HTTPS (needed for mic + push on iOS)

iOS only allows microphone access and Web Push for secure origins. Put real
certificates in `certs/key.pem` + `certs/fullchain.pem` (e.g. via acme.sh with
a DNS-01 challenge for an internal hostname) and the server automatically
serves HTTPS on port 7683 next to HTTP on 7682.

### Voice input (optional)

Add `SONIOX_API_KEY=...` to `.env`. The composer's mic button streams audio to
Soniox realtime STT and types the transcript into the input as you speak.

### Desktop session picker (optional)

`bin/nux` is a small interactive tmux/kimi session picker for the terminal
(arrow keys, create/kill/rename, attach). Drop it somewhere on your `$PATH`.

## Configuration (.env)

| Key | Default | Purpose |
|---|---|---|
| `KIMI_REMOTE_TOKEN` | — (required) | shared auth token → cookie |
| `KIMI_REMOTE_PORT` | `7682` | HTTP port |
| `KIMI_REMOTE_HTTPS_PORT` | `7683` | HTTPS port (when certs exist) |
| `TAILSCALE_IP` | auto | extra bind address (tailnet) |
| `KIMI_REMOTE_BIND` | — | override bind, e.g. `0.0.0.0` for plain LAN |
| `SONIOX_API_KEY` | — | enables voice input |

## API

Everything lives behind the token cookie: `/api/sessions` (list/create/kill),
`/api/sessions/:name/{events,chat,send,keys,scroll,upload}`, `/api/history`
(+ `/resume`), `/api/quota`, `/api/push/{vapid,subscribe,test}`, `/api/file`,
`/api/commands`, `/api/projects`. SSE stream: `events?cursor=N` → `init`,
`batch`, `patch`, `status`, `reset`.

## Security notes

- Single shared token, HttpOnly cookie; PWA assets (manifest/icons/sw) are the
  only unauthenticated routes.
- Designed for private networks (LAN / VPN / tailnet). Don't expose it to the
  open internet.
- `.env`, certificates, push subscriptions and session locks are gitignored.

## License

MIT © Sezer Sabah
