#!/usr/bin/env node
/* kimi-remote v2 — multi-session remote for Kimi CLI.
 * Zero-dependency Node server:
 *  - PWA shell + session list API (tmux-backed)
 *  - per-session ttyd processes, spawned lazily, reaped when idle
 *  - /term/<name>/* reverse proxy (HTTP + WebSocket)
 *  - POST /api/sessions/:name/send types a prompt into the session via tmux send-keys
 * Auth: single shared token, ?token= once -> HttpOnly cookie.
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const os = require('os');
const HOME = process.env.HOME || os.homedir();

// --- config (.env, KEY=VALUE per line) ---
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch (_) {}

const PORT = parseInt(env.KIMI_REMOTE_PORT || '7682', 10);
const TOKEN = env.KIMI_REMOTE_TOKEN || '';
const TAILSCALE_IP = env.TAILSCALE_IP || '';
const COOKIE = 'kr_auth';
const NAME_RE = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}';
const SESSION_RE = new RegExp(`^${NAME_RE}$`);

if (!TOKEN) {
  console.error('ERROR: KIMI_REMOTE_TOKEN not set (check .env). Run ./start.sh first.');
  process.exit(1);
}

// --- small helpers ---
function authed(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some(p => p.trim() === `${COOKIE}=${TOKEN}`);
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 1e5) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > limit) { req.destroy(); resolve(null); } });
    req.on('end', () => resolve(d));
    req.on('close', () => resolve(null));                  // destroy/abort: never leave the promise hanging
    req.on('error', () => resolve(null));
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/manifest+json',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const noStore = full.endsWith('.html');                  // the app shell must never be served stale
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': noStore ? 'no-store' : 'no-cache' });
  fs.createReadStream(full).pipe(res);
  return true;
}
function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// --- session model (tmux-backed) ---
const activityCache = new Map(); // name -> {hash, changedAt}

// persistent pane→kimi-session lock. Keyed by tmux #{session_id} (stable across
// renames). Written the moment a definitive scrollback banner is seen — survives
// server restarts and scrollback compaction, and stops the activity heuristic
// from ever attaching a pane to another pane's kimi session.
const MAPFILE = path.join(ROOT, 'session-map.json');
let paneMap = {};
try { paneMap = JSON.parse(fs.readFileSync(MAPFILE, 'utf8')); } catch (_) {}
// tmux преизползва $0,$1,… след рестарт на tmux сървъра → старите lock-ове биха
// сочили чужди сесии. Пазим start_time на tmux сървъра в map-а (__start) и при
// несъвпадение хвърляме всичко.
let mapFreshAt = 0;
async function ensureMapFresh() {
  if (Date.now() - mapFreshAt < 30000) return;
  mapFreshAt = Date.now();
  let start = '';
  try { start = (await tmux(['display-message', '-p', '#{start_time}'])).trim(); } catch (_) { return; }
  if (paneMap.__start !== start) {
    paneMap = { __start: start };
    try { fs.writeFileSync(MAPFILE, JSON.stringify(paneMap, null, 1)); } catch (_) {}
  }
}
function lockPane(sesId, key) {
  if (paneMap[sesId] === key) return;
  paneMap[sesId] = key;
  try { fs.writeFileSync(MAPFILE, JSON.stringify(paneMap, null, 1)); } catch (_) {}
}
function prunePaneMap(liveIds) {
  let dirty = false;
  for (const id of Object.keys(paneMap)) {
    if (id === '__start') continue;
    if (!liveIds.has(id)) { delete paneMap[id]; dirty = true; }
  }
  if (dirty) try { fs.writeFileSync(MAPFILE, JSON.stringify(paneMap, null, 1)); } catch (_) {}
}
function lockedByOthers(sesId) {
  return new Set(Object.entries(paneMap).filter(([id]) => id !== sesId && id !== '__start').map(([, k]) => k));
}
// kimi's /sessions resume prints NO banner → a lock can go silently stale.
// If the pane keeps living while the locked wire has been quiet for 5+ min
// (and no tool is running), the pane resumed another session → drop the lock.
const lockSuspects = new Map(); // sesId -> consecutive suspect count
function verifyLock(sesId, row, activityMs, states, cwd, createdMs) {
  if (!row) return true;
  const now = Date.now();
  // POSITIVE evidence only: някоя ДРУГА (незаключена другаде) сесия има съвсем
  // пресен wire, докато заключената мълчи от 5+ мин → тих resume в този pane.
  // (Голото "pane активен + wire тих" НЕ стига — TUI-то си репейнтва footer-а.)
  let evidence = false;
  if (now - row.wireUpd > 15 * 60 * 1000) {
    const cand = matchTitle(states, cwd || '', createdMs, activityMs, lockedByOthers(sesId));
    if (cand.key && cand.key !== row.key) {
      const cRow = states.find(r => r.key === cand.key);
      evidence = !!(cRow && now - cRow.wireUpd < 60000);
    }
  }
  if (evidence) {
    const c = (lockSuspects.get(sesId) || 0) + 1;
    lockSuspects.set(sesId, c);
    if (c >= 5) {
      lockSuspects.delete(sesId);
      delete paneMap[sesId];
      try { fs.writeFileSync(MAPFILE, JSON.stringify(paneMap, null, 1)); } catch (_) {}
      return false;
    }
  } else {
    lockSuspects.set(sesId, 0);
  }
  return true;
}

// Kimi session titles: ~/.kimi-code/sessions/<wd>/<session_*>/state.json
function kimiStates() {
  const base = path.join(HOME, '.kimi-code', 'sessions');
  const rows = [];
  let wds = [];
  try { wds = fs.readdirSync(base); } catch (_) { return rows; }
  for (const wd of wds) {
    let ses = [];
    try { ses = fs.readdirSync(path.join(base, wd)); } catch (_) { continue; }
    for (const s of ses) {
      try {
        const sp = path.join(base, wd, s, 'state.json');
        const d = JSON.parse(fs.readFileSync(sp, 'utf8'));
        let wireUpd = 0;
        try { wireUpd = fs.statSync(path.join(path.dirname(sp), 'agents', 'main', 'wire.jsonl')).mtimeMs; } catch (_) {}
        rows.push({
          workDir: d.workDir || '',
          created: Date.parse(d.createdAt || '') || 0,
          updated: Date.parse(d.updatedAt || '') || 0,
          wireUpd: wireUpd || (Date.parse(d.updatedAt || '') || 0),
          title: String(d.title || '').trim(),
          key: s,
          statePath: sp,
        });
      } catch (_) {}
    }
  }
  // един session id може да живее в НЯКОЛКО wd_* дира (kimi създава втори при
  // resume от друга папка) — истинският е този с най-пресен wire; старият дубъл
  // иначе засенчва живия → замръзнал working/празен swarm панел
  const byKey = new Map();
  for (const r of rows) {
    const cur = byKey.get(r.key);
    if (!cur || r.wireUpd > cur.wireUpd) byKey.set(r.key, r);
  }
  return [...byKey.values()];
}

function matchTitle(states, cwd, createdMs, activityMs, excluded) {
  if (excluded && excluded.size) states = states.filter(r => !excluded.has(r.key));
  // v3 (from kimi source): createdAt is immutable session identity (dir birthtime,
  // never rewritten, even on resume) → a ≤120s createdAt match IS the session that
  // started in this pane. updatedAt bumps per prompt → a very-close activity match
  // means the pane RESUMED some other session and is actively using it.
  let created = null, activity = null;
  for (const r of states) {
    if (r.workDir && r.workDir !== cwd) continue;
    const cd = Math.abs(r.created - createdMs);
    if (cd <= 120000 && (!created || cd < created.cd)) created = { r, cd };
    const ad = Math.abs(r.wireUpd - activityMs);
    if (ad <= 1800000 && (!activity || ad < activity.ad)) activity = { r, ad };
  }
  // v5: activity = wire.jsonl mtime (updates per event, freezes when the session dies).
  // A resumed-living session overrules the birth match only when its wire is FRESH
  // (<15 min) and newer than the birth session's wire. Dead third-party sessions
  // can never steal a pane from its birth session.
  const now = Date.now();
  const fresh = activity && now - activity.r.wireUpd < 15 * 60 * 1000;
  if (activity && activity.ad < 1800000 && fresh && (!created || activity.r.wireUpd > created.r.wireUpd)) {
    return { title: activity.r.title, key: activity.r.key, diff: activity.ad };
  }
  if (created) return { title: created.r.title, key: created.r.key, diff: created.cd };
  if (activity) return { title: activity.r.title, key: activity.r.key, diff: activity.ad };
  return { title: '', key: '', diff: 0 };
}

// definitive pane → kimi session mapping: the TUI welcome banner prints
// "Session: session_<uuid>" and it stays in the tmux scrollback.
async function paneSessionId(name) {
  try {
    const hist = await tmux(['capture-pane', '-pS', '-3000', '-t', name]);
    // strict: the real TUI banner pads with 2+ spaces ("Session:   session_…"),
    // while prose/commands about it use a single space — keeps self-references out
    const m = [...hist.matchAll(/Session:\s{2,}(session_[a-f0-9-]+)/g)];
    return m.length ? m[m.length - 1][1] : '';
  } catch (_) { return ''; }
}

async function listSessions() {
  let out;
  try {
    out = await tmux(['ls', '-F', '#{session_id}\t#{session_name}\t#{session_created}\t#{session_activity}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_in_mode}']);
  } catch (_) {
    return []; // tmux server not running
  }
  const states = kimiStates();
  const sessions = [];
  const liveIds = new Set(out.trim().split('\n').map(l => l.split('\t')[0]).filter(Boolean));
  await ensureMapFresh();
  prunePaneMap(liveIds);
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    const [sesId, name, created, activity, cwd, pcmd, pmode] = line.split('\t');
    if (!SESSION_RE.test(name)) continue;

    let tail = '';
    try {
      tail = await tmux(['capture-pane', '-p', '-t', name]);
    } catch (_) {}
    const lines = tail.split('\n').filter(l => l.trim());
    const hashInput = lines.slice(-12).join('\n');
    // preview: last meaningful line — skip the TUI status/footer noise
    const NOISE = /context:\s*\d+%|thinking:\s*\w+|^\s*[>›❯]|tab to edit|esc to interrupt|^[\s\-─━═▰▱▪▫╭╰│╮╯┃└┌┐┘_.]+$|^\s*[╭╰│]|Agent Swarm —|Working\.\.\./i;
    const preview = ([...lines].reverse().find(l => !NOISE.test(l.trim())) || '').trim().slice(0, 90);
    const approval = /Approve once|Reject with feedback/.test(lines.slice(-12).join('\n'));
    // какво точно иска да пусне: редовете над бутоните, изчистени от рамки
    let approvalText = '';
    if (approval) {
      const idx = lines.findIndex(l => /Approve once/.test(l));
      approvalText = lines.slice(Math.max(0, idx - 10), idx)
        .map(l => l.replace(/[│╭╰─╮╯┃]/g, ' ').trim())
        .filter(l => l && !/^\d\.|^\[|Reject|Approve|Esc\b/.test(l))
        .slice(-5).join('\n').slice(0, 400);
    }
    // parse the kimi TUI status line (footer spec from bundle: badges → model → cwd → git → tips → context)
    const statusLine = lines.slice(-3).join(' ');
    const model = (statusLine.match(/K\d+(?:\.\d+)?(?:\s*Code)?/) || [''])[0];
    const modes = [];
    if (/\byolo\b/i.test(statusLine)) modes.push('yolo');
    if (/\bauto\b/i.test(statusLine)) modes.push('auto');
    if (/\bswarm\b/i.test(statusLine)) modes.push('swarm');
    if (/\bplan\b/i.test(statusLine)) modes.push('plan');
    const ctxM = statusLine.match(/context:\s*(\d+)%\s*\(([^)]+)\)/);
    const tasksM = statusLine.match(/\[(\d+) task\(s\) running\]/);
    const agentsM = statusLine.match(/\[(\d+) agent\(s\) running\]/);
    const goalM = statusLine.match(/\[goal ● (\w+) · ([^\]]+)\]/);
    const gitM = statusLine.match(/([A-Za-z0-9._\/-]+)\s+\[[+\d\s\-\d↑↓±]+\]/);
    const status = {
      model, modes,
      context: ctxM ? { pct: Number(ctxM[1]), used: ctxM[2] } : null,
      tasks: tasksM ? Number(tasksM[1]) : 0,
      agents: agentsM ? Number(agentsM[1]) : 0,
      goal: goalM ? { status: goalM[1], info: goalM[2].trim() } : null,
      git: gitM ? gitM[1] : '',
    };

    const prev = activityCache.get(name);
    const hash = String(hashInput.length) + ':' + String(hashInput.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7));
    const now = Date.now();
    if (!prev || prev.hash !== hash) activityCache.set(name, { hash, changedAt: now });
    const busy = now - activityCache.get(name).changedAt < 6000;

    let m = { title: '', key: '', diff: 0 };
    let swarm = null;
    if (pcmd === 'kimi') {
      const sid = await paneSessionId(name);
      if (sid) lockPane(sesId, sid);                       // banner = definitive, persist it
      const locked = paneMap[sesId];
      let row = locked && states.find(r => r.key === locked);
      if (row && !verifyLock(sesId, row, Number(activity) * 1000, states, cwd || "", Number(created) * 1000)) row = null;
      if (row) m = { title: row.title, key: row.key, diff: 0 };
      else m = matchTitle(states, cwd || '', Number(created) * 1000, Number(activity) * 1000, lockedByOthers(sesId));
      const mrow = row || (m.key && states.find(r => r.key === m.key));
      if (mrow) {
        const sw = swarmStatus(path.dirname(mrow.statePath));
        if (sw) swarm = { done: sw.done, total: sw.total, running: sw.running };
      }
    }
    sessions.push({
      name,
      created: Number(created) * 1000,
      activity: Number(activity) * 1000,
      cwd: (cwd || '').replace(HOME, '~'),
      busy,
      preview,
      title: m.title,
      mode: Number(pmode) || 0,
      approval,
      approvalText,
      swarm,
      status,
      _key: m.key,
      _diff: m.diff,
    });
  }
  // one kimi session → at most one tmux pane (best activity-match wins);
  // losers fall back to their tmux name instead of showing a duplicate title
  const claimed = new Map();
  sessions.forEach((s, i) => {
    if (!s._key) return;
    const cur = claimed.get(s._key);
    if (!cur || s._diff < cur.diff) claimed.set(s._key, { i, diff: s._diff });
  });
  const winners = new Set([...claimed.values()].map(v => v.i));
  sessions.forEach((s, i) => {
    if (s._key && !winners.has(i)) s.title = '';
    delete s._key; delete s._diff;
  });
  sessions.sort((a, b) => b.activity - a.activity);
  return sessions;
}

async function createSession(name, cwd) {
  if (!SESSION_RE.test(name) || name === 'kimi') throw new Error('bad name (use kr-... or leave empty for auto)');
  if (cwd && cwd.startsWith('~')) cwd = HOME + cwd.slice(1);
  const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : HOME;
  await tmux(['new-session', '-d', '-s', name, '-c', dir, 'kimi', '-y']);   // yolo по подразбиране
  enableSwarmWhenReady(name);                                               // swarm няма флаг — /swarm on след boot
  return { name, cwd: dir };
}
async function enableSwarmWhenReady(name) {
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 700));
    try {
      const pane = await tmux(['capture-pane', '-p', '-t', name]);
      if (/Session:\s{2,}session_/.test(pane) || /╭─/.test(pane)) {         // TUI-то е готово
        await new Promise(r => setTimeout(r, 400));
        await tmux(['send-keys', '-t', name, '-l', '--', '/swarm on']);
        await new Promise(r => setTimeout(r, 300));
        await tmux(['send-keys', '-t', name, '-l', '\r']);
        return;
      }
    } catch (_) { return; }                                                 // сесията е умряла междувременно
  }
}

async function killSession(name) {
  if (!SESSION_RE.test(name)) throw new Error('bad name');
  await tmux(['kill-session', '-t', name]);
  const e = ttyds.get(name);
  if (e) e.proc.kill();
  activityCache.delete(name);
}

const sendLocks = new Map(); // name -> Promise (serializes sends per session)
function sendToSession(name, text, steer) {
  if (!SESSION_RE.test(name)) return Promise.reject(new Error('bad name'));
  const prev = sendLocks.get(name) || Promise.resolve();
  const job = prev.then(() => doSend(name, text, steer)).finally(() => {
    if (sendLocks.get(name) === job) sendLocks.delete(name);
  });
  sendLocks.set(name, job);
  return job;
}

function isBusy(name) {
  const e = activityCache.get(name);
  return !!(e && Date.now() - e.changedAt < 6000);
}

async function doSend(name, text, steer) {
  await tmux(['send-keys', '-t', name, '-X', 'cancel']).catch(() => {}); // leave scroll/copy mode
  // idle: Ctrl-C clears the input draft (kimi docs). Never while busy — that
  // would interrupt the turn. Авторитетът е ЛУНАТА в pane-а, не activityCache
  // (той се пълни само от /api/sessions поллинга и може да е stale/празен).
  if (!(await paneBusy(name)) && !isBusy(name)) {
    await tmux(['send-keys', '-t', name, 'C-c']).catch(() => {});
    await new Promise(r => setTimeout(r, 80));
  }
  if (steer) {
    // kimi's steer: type into the input, then Ctrl-S injects it into the running turn
    await tmux(['send-keys', '-t', name, '-l', '--', text]);
    await new Promise(r => setTimeout(r, 120));
    await tmux(['send-keys', '-t', name, 'C-s']);
    return;
  }
  for (let i = 0; i < text.length; i += 1500) {                          // chunk long prompts
    await tmux(['send-keys', '-t', name, '-l', '--', text.slice(i, i + 1500)]);
  }
  await new Promise(r => setTimeout(r, 150));                            // let the TUI settle
  // literal CR byte on its own: tmux -l drops control chars embedded in a longer
  // string, but sends a standalone \r through — that is what submits the prompt
  await tmux(['send-keys', '-t', name, '-l', '\r']);
}

async function sendKeysRaw(name, keys) {
  if (!SESSION_RE.test(name)) throw new Error('bad name');
  if (keys === 'esc') { await tmux(['send-keys', '-t', name, 'Escape']); return; }  // dismiss dialogs/questions (kimi records a clean "dismissed" result)
  if (!/^[1-9]$/.test(keys)) throw new Error('bad keys');
  await tmux(['send-keys', '-t', name, '-l', '--', keys]);
}

// one-line human summary of a tool call (shown on the collapsed card)
function toolSummary(name, a) {
  if (!a || typeof a !== 'object') return '';
  const short = p => String(p || '').replace(HOME, '~');
  let v = a.command || a.cmd || '';
  if (!v) v = a.file_path || a.path || a.filename || '';
  if (!v && a.pattern) v = a.pattern + (a.path ? '  in ' + short(a.path) : '');
  if (!v) v = a.query || a.url || a.description || a.prompt || '';
  if (!v && Array.isArray(a.todos)) v = a.todos.length + ' todos';
  if (!v && a.edits) v = short(a.file_path || '') || 'edits';
  return short(String(v)).replace(/\s+/g, ' ').trim().slice(0, 90);
}

// --- chat view: read the linked kimi session's wire.jsonl ---
// wireCache: last successful pane→wire mapping per tmux session. While kimi shells
// out to a tool, pane_current_command can report the child process instead of
// "kimi" — a hard failure there used to flip the UI to terminal mid-conversation.
const wireCache = new Map(); // name -> {wire, key}
async function resolveWire(name) {
  const out = await tmux(['ls', '-F', '#{session_id}\t#{session_name}\t#{session_created}\t#{session_activity}\t#{pane_current_path}\t#{pane_current_command}']);
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    const [sesId, n, created, activity, cwd, pcmd] = line.split('\t');
    if (n !== name) continue;
    await ensureMapFresh();
    const cached = wireCache.get(name);
    if (pcmd !== 'kimi') {
      // kimi is (probably) running a tool right now — serve the cached mapping
      if (cached) return { wire: cached.wire, activity: Number(activity) * 1000, key: cached.key };
      throw new Error('not a kimi session');
    }
    const states = kimiStates();
    const sid = await paneSessionId(name);
    if (sid) lockPane(sesId, sid);                          // banner = definitive, persist it
    const locked = paneMap[sesId];
    let row = locked && states.find(r => r.key === locked);
    if (row && !verifyLock(sesId, row, Number(activity) * 1000, states, cwd || "", Number(created) * 1000)) row = null;
    if (!row) {
      const m = matchTitle(states, cwd || '', Number(created) * 1000, Number(activity) * 1000, lockedByOthers(sesId));
      row = m.key && states.find(r => r.key === m.key);
    }
    if (!row) {
      if (cached) return { wire: cached.wire, activity: Number(activity) * 1000, key: cached.key };
      throw new Error('no linked kimi session');
    }
    const wire = path.join(path.dirname(row.statePath), 'agents', 'main', 'wire.jsonl');
    wireCache.set(name, { wire, key: row.key });
    return { wire, activity: Number(activity) * 1000, key: row.key };
  }
  wireCache.delete(name);
  throw new Error('unknown session');
}

// ═══ incremental wire engine (opencode-style): byte-offset cursor + push ═══
// One in-memory state per wire file. New bytes are parsed exactly once and the
// results are BROADCAST to SSE subscribers — clients never re-poll the file.
const wireStates = new Map(); // file -> state
function newWireState() {
  return { offset: 0, mtime: 0, messages: [], toolIdx: new Map(), pendingQ: null,
    pendingCallId: null, pendingTool: '', thought: '', lastMeaning: 0, lastRole: '', subs: new Set() };
}
function processEvent(e, st, newMsgs, patches) {
  const push = m => { st.messages.push(m); newMsgs.push(m); };
  if (e.type === 'turn.prompt') {
    const text = (e.input || []).map(p => p.text || '').join('\n').trim();
    st.thought = '';                                       // new turn — never show the previous turn's thought as "live"
    if (text) { push({ role: 'user', text, origin: (e.origin && e.origin.kind) || 'user', time: e.time }); st.lastMeaning = e.time; st.lastRole = 'user'; }
  } else if (e.type === 'turn.cancel') {
    if (st.lastMeaning && e.time - st.lastMeaning < 10000 && st.lastRole !== 'cancel') {
      push({ role: 'event', kind: 'cancel', text: 'interrupted', time: e.time });
      st.lastRole = 'cancel';
    }
  } else if (e.type === 'permission.record_approval_result') {
    const r = e.result || {};
    push({ role: 'approval', name: e.toolName, decision: r.decision, feedback: (r.feedback || '').slice(0, 200), time: e.time });
  } else if (e.type === 'permission.set_mode') {
    push({ role: 'event', kind: 'mode', text: 'permission → ' + e.mode, time: e.time });
  } else if (e.type === 'context.append_loop_event') {
    const ev = e.event || {};
    if (ev.type === 'content.part') {
      const p = ev.part || {};
      if (p.type === 'text' && p.text) { push({ role: 'assistant', text: p.text, time: e.time }); st.lastMeaning = e.time; st.lastRole = 'assistant'; }
      else if (p.type === 'think') {
        const tt = p.think || p.text || '';                // kimi stores thought in `think`, not `text`
        if (tt) { push({ role: 'think', text: tt, time: e.time }); st.thought = tt; st.lastMeaning = e.time; st.lastRole = 'think'; }
      }
    } else if (ev.type === 'tool.call') {
      st.toolIdx.set(ev.toolCallId, st.messages.length);
      st.lastMeaning = e.time; st.lastRole = 'tool';
      st.pendingCallId = ev.toolCallId; st.pendingTool = ev.name;
      if (ev.name === 'AskUserQuestion') st.pendingQ = { key: ev.toolCallId, args: ev.args };
      const a = ev.args || {};
      let diff = null;                                     // Edit/Write → real -/+ diff for the UI
      if (ev.name === 'Edit' && (a.old_string || a.new_string)) {
        diff = { old: String(a.old_string || '').slice(0, 3000), new: String(a.new_string || '').slice(0, 3000) };
      } else if (ev.name === 'Write' && a.content) {
        diff = { old: '', new: String(a.content).slice(0, 3000) };
      }
      push({ role: 'tool', name: ev.name, summary: toolSummary(ev.name, a), diff, args: diff ? '' : JSON.stringify(a).slice(0, 400), output: null, time: e.time });
    } else if (ev.type === 'tool.result') {
      const i = st.toolIdx.get(ev.toolCallId);
      if (i != null) {
        const out = String((ev.result && ev.result.output) || '').slice(0, 600);
        st.messages[i].output = out;
        // if the tool.call is in THIS batch it will arrive complete — no patch needed
        if (!newMsgs.includes(st.messages[i])) patches.push({ i, output: out });
      }
      if (st.pendingQ && ev.toolCallId === st.pendingQ.key) st.pendingQ = null;
      if (ev.toolCallId === st.pendingCallId) { st.pendingCallId = null; st.pendingTool = ''; }
    }
  }
}
function statusPayload(st, activityMs) {
  const working = Date.now() - st.mtime < 5000 || Date.now() - (activityMs || 0) < 8000 || !!st.pendingCallId;
  let question = null;
  if (st.pendingQ && st.pendingQ.args && Array.isArray(st.pendingQ.args.questions) && st.pendingQ.args.questions[0]) {
    const q = st.pendingQ.args.questions[0];
    question = { question: q.question || '', header: q.header || '', multi: !!q.multi_select, options: (q.options || []).map(o => o.label || '') };
  }
  return { working, thought: st.thought.slice(0, 300), question, pendingTool: st.pendingTool, total: st.messages.length };
}
// read only the NEW bytes since st.offset, parse complete lines, broadcast
function refreshWireState(file, activityMs) {
  let st = wireStates.get(file);
  if (!st) { st = newWireState(); wireStates.set(file, st); }
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return st; }
  if (stat.size < st.offset) {                             // truncated/rotated → rebuild
    // живите SSE клиенти имат старата история — кажи им да почнат начисто,
    // иначе пълният re-parse ще им пристигне като batch и всичко се дублира
    for (const sub of st.subs) { try { sub('reset', {}); } catch (_) {} }
    st = newWireState(); wireStates.set(file, st);         // subs НЕ се пренасят — клиентите се преabonират
  }
  if (stat.size > st.offset) {
    const buf = Buffer.alloc(stat.size - st.offset);
    let fd;
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, buf.length, st.offset); } finally { if (fd != null) fs.closeSync(fd); }
    const nl = buf.lastIndexOf(10);                        // parse complete lines only, byte-exact cursor
    if (nl !== -1) {
      const chunk = buf.slice(0, nl + 1).toString('utf8');
      st.offset += nl + 1;
      const newMsgs = [], patches = [];
      for (const line of chunk.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch (_) { continue; }
        processEvent(e, st, newMsgs, patches);
      }
      st.mtime = stat.mtimeMs;
      if ((newMsgs.length || patches.length) && st.subs.size) {
        const status = statusPayload(st, activityMs);
        for (const sub of st.subs) {
          if (newMsgs.length) sub('batch', newMsgs);
          if (patches.length) sub('patch', patches);
          sub('status', status);
        }
      }
    }
  }
  st.mtime = stat.mtimeMs;
  return st;
}

// ═══ Web Push (zero-dep: RFC 8291 aes128gcm + RFC 8292 VAPID) ═══
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64ud = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const VAPID_FILE = path.join(ROOT, 'vapid.json');
let vapid = null;
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch (_) {}
if (!vapid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  vapid = {
    publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }).slice(-65)),  // raw uncompressed point
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
}
const SUBS_FILE = path.join(ROOT, 'push-subs.json');
let pushSubs = [];
try { pushSubs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (_) {}
function saveSubs() { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubs, null, 1), { mode: 0o600 }); } catch (_) {} }
function hkdf(salt, ikm, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().slice(0, len);
}
function encryptPayload(sub, payload) {
  const uaPub = b64ud(sub.keys.p256dh);                    // 65b uncompressed point
  const auth = b64ud(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.concat([salt, Buffer.from([0, 0, 16, 0]), Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([header, ct]);
}
function vapidJWT(endpoint) {
  const { origin } = new URL(endpoint);
  const enc = o => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:sezers@gmail.com' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapid.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return unsigned + '.' + b64u(sig);
}
function sendPush(sub, payloadObj) {
  return new Promise(resolve => {
    let body;
    try { body = encryptPayload(sub, JSON.stringify(payloadObj)); } catch (e) { return resolve({ ok: false, err: e.message }); }
    const u = new URL(sub.endpoint);
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: 'POST',
      headers: {
        TTL: '120',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        Authorization: `vapid t=${vapidJWT(sub.endpoint)}, k=${vapid.publicKey}`,
        Urgency: 'high',
      },
    }, res => {
      res.resume();
      // 404/410 = мъртъв subscription → чисти го
      if (res.statusCode === 404 || res.statusCode === 410) {
        pushSubs = pushSubs.filter(s => s.endpoint !== sub.endpoint);
        saveSubs();
      }
      resolve({ ok: res.statusCode < 300, code: res.statusCode });
    });
    req.on('error', e => resolve({ ok: false, err: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.end(body);
  });
}
function broadcastPush(payload) {
  for (const sub of pushSubs) sendPush(sub, payload);
}

// ═══ push watcher: следи преходите и бута телефона само когато трябва ═══
const pushState = new Map(); // tmux name -> {approval, question, workingSince, working, swarmActive}
let watcherBusy = false;
setInterval(async () => {
  if (watcherBusy || !pushSubs.length) return;
  watcherBusy = true;
  try {
    const sessions = await listSessions();
    const liveNames = new Set();
    for (const s of sessions) {
      liveNames.add(s.name);
      const prev = pushState.get(s.name) || { approval: false, question: '', working: false, workingSince: 0, swarmActive: 0 };
      const cur = { ...prev };
      const title = s.title || s.name;
      let watched = false, question = '', swarm = null, lastText = '';
      try {
        const { wire } = await resolveWire(s.name);
        const wst = refreshWireState(wire, s.activity);
        watched = wst.subs.size > 0;                       // някой гледа на живо → не спами
        const sp = statusPayload(wst, s.activity);
        question = sp.question ? sp.question.question : '';
        swarm = swarmStatus(path.dirname(path.dirname(path.dirname(wire))));
        for (let i = wst.messages.length - 1; i >= 0 && !lastText; i--) {
          if (wst.messages[i].role === 'assistant') lastText = wst.messages[i].text.replace(/\s+/g, ' ').slice(0, 90);
        }
        cur.working = sp.working || s.busy;
      } catch (_) { cur.working = s.busy; }
      if (cur.working && !prev.working) cur.workingSince = Date.now();
      cur.approval = s.approval;
      cur.question = question;
      cur.swarmActive = swarm ? swarm.active : 0;
      if (!watched) {
        if (cur.approval && !prev.approval) {
          broadcastPush({ title: '⚠ ' + title, body: (s.approvalText || 'awaiting approval').slice(0, 140), tag: 'ap-' + s.name, url: '/#/s/' + s.name });
        }
        if (cur.question && cur.question !== prev.question) {
          broadcastPush({ title: '❓ ' + title, body: cur.question.slice(0, 140), tag: 'q-' + s.name, url: '/#/s/' + s.name });
        }
        if (!cur.working && prev.working && Date.now() - prev.workingSince > 45000) {
          broadcastPush({ title: '✅ ' + title, body: lastText || 'done', tag: 'done-' + s.name, url: '/#/s/' + s.name });
        }
        if (!cur.swarmActive && prev.swarmActive > 1) {
          broadcastPush({ title: '🐝 ' + title, body: 'swarm finished', tag: 'sw-' + s.name, url: '/#/s/' + s.name });
        }
      }
      pushState.set(s.name, cur);
    }
    for (const k of [...pushState.keys()]) if (!liveNames.has(k)) pushState.delete(k);
  } catch (_) {} finally { watcherBusy = false; }
}, 6000).unref();

// ═══ swarm live status: per-agent wires в agents/agent-N/ ═══
const swarmCache = new Map(); // sessionDir -> Map(agentId -> {mission, action, mtime})
function readChunk(file, fromEnd, size) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const len = Math.min(size, st.size);
    const pos = fromEnd ? st.size - len : 0;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, pos);
    return buf.toString('utf8');
  } catch (_) { return ''; } finally { if (fd != null) fs.closeSync(fd); }
}
function agentMission(file) {
  for (const line of readChunk(file, false, 8192).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'turn.prompt') {
        const t = (e.input || []).map(p => p.text || '').join(' ').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 110);
      }
    } catch (_) {}
  }
  return '';
}
function agentTail(file) {
  // Завършил агент: wire-ът свършва със step.end finishReason=end_turn/stop
  // (следван само от usage.record). Жив: llm.request / step.begin / tool.*.
  const lines = readChunk(file, true, 16384).split('\n');
  let done = false, decided = false, action = '', fallback = '', sawResult = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let e; try { e = JSON.parse(lines[i]); } catch (_) { continue; }   // първият ред може да е срязан
    const ev = (e.type === 'context.append_loop_event' && e.event) || {};
    const t = ev.type || e.type;
    if (t === 'usage.record') continue;
    if (!decided) {
      decided = true;
      if (t === 'step.end') {
        const fr = ev.finishReason;
        const frs = typeof fr === 'string' ? fr : (fr && fr.type) || '';
        done = /end_turn|stop/.test(frs);
      }
    }
    if (ev.type === 'tool.call') {
      // ако след този call вече е дошъл result → показваме го като свършен (✓),
      // но ВИНАГИ с името и аргументите — "✓ tool" не казва нищо
      const mark = sawResult ? '✓ ' : '🔧 ';
      action = mark + ev.name + (toolSummary(ev.name, ev.args) ? ' · ' + toolSummary(ev.name, ev.args).slice(0, 60) : '');
      break;
    }
    if (ev.type === 'tool.result') { sawResult = true; continue; }   // името е в call-а — търси назад
    if (ev.type === 'content.part') {
      const p = ev.part || {};
      if (p.type === 'text' && p.text) { action = p.text.replace(/\s+/g, ' ').trim().slice(0, 70); break; }
      if (p.type === 'think' && (p.think || p.text)) { action = '💭 ' + String(p.think || p.text).replace(/\s+/g, ' ').trim().slice(0, 65); break; }
    }
    if (e.type === 'turn.prompt') { action = '▶ started'; break; }
    if (!fallback && (e.type === 'llm.request' || ev.type === 'step.begin')) fallback = '🧠 thinking…';
  }
  return { action: action || fallback, done };
}
function swarmStatus(sessionDir) {
  const dir = path.join(sessionDir, 'agents');
  let ids;
  try { ids = fs.readdirSync(dir).filter(x => x !== 'main'); } catch (_) { return null; }
  if (!ids.length) return null;
  let cache = swarmCache.get(sessionDir);
  if (!cache) { cache = new Map(); swarmCache.set(sessionDir, cache); }
  const now = Date.now();
  const agents = [];
  for (const id of ids) {
    const wf = path.join(dir, id, 'wire.jsonl');
    let st;
    try { st = fs.statSync(wf); } catch (_) { continue; }
    if (now - st.mtimeMs > 10 * 60 * 1000) continue;       // стар swarm run — не е текущият
    let c = cache.get(id) || {};
    if (!c.mission) c.mission = agentMission(wf);
    if (c.mtime !== st.mtimeMs) {
      const t = agentTail(wf);
      c.action = t.action; c.done = t.done; c.mtime = st.mtimeMs;
      // стъпки: инкрементален count на step.end в новите байтове (за мини бара)
      if (c.readOff == null || st.size < c.readOff) { c.readOff = 0; c.steps = 0; }
      if (st.size > c.readOff) {
        let fd2 = null;
        try {
          const buf = Buffer.alloc(st.size - c.readOff);
          fd2 = fs.openSync(wf, 'r');
          fs.readSync(fd2, buf, 0, buf.length, c.readOff);
          c.ticks = (c.ticks || 0) + (buf.toString('latin1').match(/"tool\.call"/g) || []).length;
          c.readOff = st.size;
        } catch (_) {} finally { if (fd2 != null) fs.closeSync(fd2); }
      }
    }
    cache.set(id, c);
    agents.push({
      id,
      done: !!c.done,
      writing: !c.done && now - st.mtimeMs < 15000,        // пише в момента (иначе: смята дълъг LLM call)
      ticks: c.ticks || 0,
      mission: c.mission,
      action: c.action || '',
    });
  }
  if (!agents.length) return null;
  // progress по модела на kimi AgentSwarmProgressEstimator (опростен): очакваният
  // общ брой tool calls се учи от ЗАВЪРШИЛИТЕ агенти; кап 85% докато не приключи
  const doneAgents = agents.filter(a => a.done);
  const estTotal = doneAgents.length
    ? Math.max(1, doneAgents.reduce((s, a) => s + a.ticks, 0) / doneAgents.length)
    : Math.max(10, ...agents.map(a => a.ticks)) * 1.5;
  for (const a of agents) {
    a.progress = a.done ? 1 : Math.min(0.85, a.ticks / estTotal);
  }
  const rank = a => (a.done ? 1 : 0);                      // работещите отгоре, готовите отдолу
  agents.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return {
    total: agents.length,
    running: agents.filter(a => !a.done).length,           // ВСИЧКИ незавършили работят (като kimi TUI)
    active: agents.filter(a => a.writing).length,
    done: doneAgents.length,
    agents: agents.slice(0, 24),
  };
}

// the kimi TUI shows a moon spinner while a turn runs — THE authoritative busy
// signal (wire.jsonl goes quiet between finalized parts and would flicker)
async function paneBusy(name) {
  // NB: alternation, NOT a character class — moons are surrogate pairs and
  // [🌑🌒…] would match half-pairs (= every 🌍/🎯/… emoji → false busy)
  try { return /🌑|🌒|🌓|🌔|🌕|🌖|🌗|🌘/.test(await tmux(['capture-pane', '-p', '-t', name])); }
  catch (_) { return false; }
}

// ═══ SSE stream: init → history batch → live pushes (fs.watch, no polling) ═══
async function sseHandler(req, res, name, cursor) {
  let wire, activity, key;
  try { ({ wire, activity, key } = await resolveWire(name)); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }
  const st = refreshWireState(wire, activity);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = (ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };
  const initStatus = statusPayload(st, activity);
  if (await paneBusy(name)) initStatus.working = true;
  emit('init', { key, ...initStatus });
  const from = Math.max(0, Math.min(cursor, st.messages.length));
  if (st.messages.length > from) emit('batch', st.messages.slice(from));
  st.subs.add(emit);

  // working = луната в TUI-то (авторитетна в ДВЕТЕ посоки: свети → работи,
  // угасна → готово ВЕДНАГА) || недовършен tool call || съвсем пресен wire запис
  const sessionDir = path.dirname(path.dirname(path.dirname(wire)));  // <sid>/agents/main/wire.jsonl → <sid>
  // след rotate-rebuild wireStates държи НОВ обект — винаги чети текущия,
  // не capture-натия при connect (иначе status каналът замръзва завинаги)
  const curSt = () => wireStates.get(wire) || st;
  let checking = false;
  async function checkStatus() {
    if (checking) return;
    checking = true;
    try {
      refreshWireState(wire, 0);
      const s2 = curSt();
      const sp = statusPayload(s2, 0);
      sp.working = (await paneBusy(name)) || !!s2.pendingCallId || Date.now() - s2.mtime < 1500;
      sp.swarm = swarmStatus(sessionDir);
      if (sp.swarm && sp.swarm.active) sp.working = true;  // жив swarm = сесията работи
      emit('status', sp);
    } finally { checking = false; }
  }
  let watcher = null;
  try {
    watcher = fs.watch(wire, () => {
      clearTimeout(watcher._t);
      watcher._t = setTimeout(() => {
        refreshWireState(wire, Date.now());
        setTimeout(checkStatus, 400);
        setTimeout(checkStatus, 1600);                     // веднага след изтичане на mtime прозореца
      }, 80);
    });
  } catch (_) {}
  let tick = 0;
  const timer = setInterval(async () => {
    await checkStatus();
    if (++tick % 5 === 0) {                                // every ~12s: did the pane switch to another kimi session?
      try {
        const cur = await resolveWire(name);
        if (cur.key !== key) { emit('reset', {}); cleanup(); res.end(); }
      } catch (_) {}
    }
  }, 2500);
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 25000);
  function cleanup() {
    curSt().subs.delete(emit);
    st.subs.delete(emit);
    clearInterval(timer); clearInterval(heartbeat);
    if (watcher) { clearTimeout(watcher._t); watcher.close(); }
  }
  req.on('close', cleanup);
}

const UPLOAD_DIR = path.join(HOME, '.kimi-remote', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- slash commands: built-ins (from kimi docs) + user skills from disk ---
const BUILTIN_COMMANDS = [
  ['sessions', 'Browse historical sessions and resume one'],
  ['new', 'Start a fresh session, discarding the context'],
  ['fork', 'Fork the current session, keeping history'],
  ['model', 'Switch the LLM model in this session'],
  ['compact', 'Compact the context to free up tokens'],
  ['goal', 'Start or manage an autonomous goal'],
  ['swarm', 'Swarm mode on/off, or run a task with the agent swarm'],
  ['yolo', 'Toggle YOLO mode (skip approvals)'],
  ['auto', 'Toggle auto permission mode'],
  ['plan', 'Toggle Plan mode'],
  ['tasks', 'Browse the background task list'],
  ['title', 'Display or set the session title'],
  ['undo', 'Undo recent prompts from the active context'],
  ['btw', 'Side question in a forked sub-agent'],
  ['usage', 'Token usage, context and quota info'],
  ['status', 'Session runtime state (version, model, wd…)'],
  ['mcp', 'List MCP servers and connection status'],
  ['plugins', 'Open the interactive plugin manager'],
  ['reload', 'Reload session with latest config.toml settings'],
  ['init', 'Analyze the codebase and generate AGENTS.md'],
  ['export-md', 'Export the session as a Markdown file'],
  ['add-dir', 'Add an extra workspace directory'],
  ['help', 'Keyboard shortcuts and all commands'],
  ['feedback', 'Submit feedback with optional logs'],
  ['exit', 'Exit Kimi Code CLI'],
  ['login', 'Select account/platform and log in'],
  ['logout', 'Clear credentials for the current account'],
  ['provider', 'Interactive provider manager'],
  ['settings', 'Open the settings panel'],
  ['experiments', 'Open the experimental feature panel'],
  ['permission', 'Select a permission mode'],
  ['editor', 'Configure the external editor for Ctrl-G'],
  ['theme', 'Switch the terminal UI color theme'],
  ['mcp-config', 'Configure MCP servers and MCP OAuth login'],
  ['custom-theme', 'Create or edit a custom TUI color theme'],
  ['update-config', 'Inspect or edit config.toml / tui.toml'],
  ['check-kimi-code-docs', 'Answer Kimi Code questions from official docs'],
  ['import-from-cc-codex', 'Import Claude Code / Codex instructions, skills, MCP'],
  ['sub-skill', 'Discover and reorganize local skills into bundles'],
];

function listCommands() {
  const cmds = BUILTIN_COMMANDS.map(([name, desc]) => ({ name, desc, kind: 'builtin' }));
  const seen = new Set(cmds.map(c => c.name));
  const dirs = [path.join(HOME, '.kimi-code', 'skills'), path.join(HOME, '.agents', 'skills')];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e);
      let file = null;
      const nm = e.replace(/\.md$/, '');
      try {
        if (e.endsWith('.md') && fs.statSync(p).isFile()) file = p;
        else if (fs.existsSync(path.join(p, 'SKILL.md'))) file = path.join(p, 'SKILL.md');
      } catch (_) { continue; }
      if (!file || seen.has(nm)) continue;
      seen.add(nm);
      let desc = '';
      try {
        const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
        const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fm) {
          const d = fm[1].match(/^description:\s*(.+)$/m);
          if (d) desc = d[1].trim();
        }
        if (!desc) desc = (head.split('\n').find(l => l.trim() && !l.startsWith('---')) || '').trim();
      } catch (_) {}
      cmds.push({ name: nm, desc: desc.slice(0, 140), kind: 'skill' });
    }
  }
  return cmds;
}

let quotaCache = { at: 0, data: null };

// project dirs for the new-session picker: ~/Projects/* by recency, plus ~
let projectsCache = { at: 0, rows: [] };
function listProjects() {
  if (Date.now() - projectsCache.at < 60000) return projectsCache.rows;
  const rows = [];
  const base = path.join(HOME, 'Projects');
  try {
    for (const e of fs.readdirSync(base)) {
      if (e.startsWith('.')) continue;
      try {
        const st = fs.statSync(path.join(base, e));
        if (st.isDirectory()) rows.push({ name: e, path: '~/Projects/' + e, mtime: st.mtimeMs });
      } catch (_) {}
    }
  } catch (_) {}
  rows.sort((a, b) => b.mtime - a.mtime);
  const out = [{ name: '~ (home)', path: '~', mtime: 0 }, ...rows.slice(0, 30)];
  projectsCache = { at: Date.now(), rows: out };
  return out;
}

async function uploadImage(name, body) {
  if (!SESSION_RE.test(name)) throw new Error('bad name');
  const fname = String(body.filename || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  const b64 = String(body.data || '');
  if (!b64 || b64.length > 60 * 1024 * 1024) throw new Error('no data or too large');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 100) throw new Error('empty file');
  const dest = path.join(UPLOAD_DIR, `${Date.now()}-${fname}`);
  fs.writeFileSync(dest, buf);
  // insert an @-mention of the file into the session (no submit — user adds the prompt)
  await tmux(['send-keys', '-t', name, '-X', 'cancel']).catch(() => {});
  await tmux(['send-keys', '-t', name, 'C-u']).catch(() => {});
  await tmux(['send-keys', '-t', name, '-l', '--', `@${dest} `]);
  return { ok: true, path: dest, size: buf.length };
}

async function scrollSession(name, body) {
  if (!SESSION_RE.test(name)) throw new Error('bad name');
  const action = String(body.action || '');
  const inMode = (await tmux(['display-message', '-p', '-t', name, '#{pane_in_mode}'])).trim() === '1';
  const X = k => tmux(['send-keys', '-t', name, '-X', k]).catch(() => {});
  switch (action) {
    case 'toggle': inMode ? await X('cancel') : await tmux(['copy-mode', '-t', name]); break;
    case 'up':     if (!inMode) await tmux(['copy-mode', '-t', name]); await X('page-up'); break;
    case 'down':   if (!inMode) await tmux(['copy-mode', '-t', name]); await X('page-down'); break;
    case 'top':    if (!inMode) await tmux(['copy-mode', '-t', name]); await X('history-top'); break;
    case 'bottom': if (!inMode) await tmux(['copy-mode', '-t', name]); await X('history-bottom'); break;
    case 'exit':   await X('cancel'); break;
    case 'lines': {
      const n = Math.max(-50, Math.min(50, Math.round(Number(body.lines) || 0)));
      if (n === 0) break;
      const key = n > 0 ? 'scroll-up' : 'scroll-down';
      // one invocation: copy-mode then repeat-scroll (chained -X flags only fire once,
      // and separate calls race the mode transition)
      await tmux(['copy-mode', '-t', name, ';', 'send-keys', '-N', String(Math.abs(n)), '-t', name, '-X', key]).catch(() => {});
      break;
    }
    default: throw new Error('bad action');
  }
  return { ok: true };
}

// --- ttyd process manager (lazy spawn, idle reaper) ---
const ttyds = new Map(); // name -> {port, proc, lastUsed}
const usedPorts = new Set();
function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function allocPort() {
  for (let p = 7701; p < 7750; p++) if (!usedPorts.has(p) && (await portFree(p))) return p;
  throw new Error('no free ttyd ports');
}
function waitPort(port, ms) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.end(); resolve(); });
      s.once('error', () => (Date.now() - t0 > ms ? reject(new Error('ttyd port timeout')) : setTimeout(tryOnce, 120)));
    })();
  });
}
async function ensureTtyd(name) {
  const e = ttyds.get(name);
  if (e) { e.lastUsed = Date.now(); return e.port; }
  const port = await allocPort();
  usedPorts.add(port);
  const proc = spawn('ttyd', ['-W', '-i', '127.0.0.1', '-p', String(port), '-t', 'fontSize=14',
    'tmux', 'attach-session', '-t', name], { stdio: 'ignore' });
  const entry = { port, proc, lastUsed: Date.now() };
  ttyds.set(name, entry);
  proc.on('exit', () => { usedPorts.delete(port); if (ttyds.get(name) === entry) ttyds.delete(name); });
  await waitPort(port, 4000);
  return port;
}
setInterval(() => {
  for (const [, e] of ttyds) if (Date.now() - e.lastUsed > 15 * 60 * 1000) e.proc.kill();
}, 60000).unref();

// --- proxy to a session's ttyd ---
function proxyHttp(req, res, port, stripPrefix) {
  const target = req.url.slice(stripPrefix.length) || '/';
  const preq = http.request(
    { host: '127.0.0.1', port, path: target, method: req.method, headers: req.headers },
    pres => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); }
  );
  preq.on('error', () => send(res, 502, '<h1>session terminal unavailable</h1>'));
  req.pipe(preq);
}

// --- HTTP handler ---
async function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('token') === TOKEN) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
    });
    return res.end();
  }
  // PWA assets are fetched without cookies (manifest/sw/icons) — public, not sensitive
  if (/^\/(manifest\.json|sw\.js|icon-\d+\.png)$/.test(u.pathname)) {
    return void (serveStatic(res, u.pathname.slice(1)) || send(res, 404, 'not found'));
  }
  if (u.pathname === '/favicon.ico') {
    return void (serveStatic(res, 'icon-180.png') || send(res, 404, 'not found'));
  }
  if (!authed(req)) {
    return send(res, 401, '<h1>401</h1><p>Open the full URL with ?token=… once (printed by start.sh).</p>');
  }

  // session-scoped terminal proxy
  const tm = u.pathname.match(/^\/term\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})(\/|$)/);
  if (tm) {
    const name = tm[1];
    if (!SESSION_RE.test(name)) return send(res, 404, 'unknown session');
    try {
      const port = await ensureTtyd(name);
      return proxyHttp(req, res, port, `/term/${name}`);
    } catch (e) {
      return send(res, 502, `<h1>cannot attach</h1><p>${e.message}</p>`);
    }
  }

  // API
  if (u.pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { sessions: await listSessions() });
  }
  if (u.pathname === '/api/sessions' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    let name = String(body.name || '').trim();
    if (name && !name.startsWith('kr-')) name = 'kr-' + name;
    if (!name) name = 'kr-' + Date.now().toString(36);
    try {
      return sendJson(res, 201, await createSession(name, String(body.cwd || '').trim()));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  const sm = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})$/);
  if (sm && req.method === 'DELETE') {
    try { await killSession(sm[1]); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const sendM = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\/send$/);
  if (sendM && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try { await sendToSession(sendM[1], String(body.text || ''), !!body.steer); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const scrM = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\/scroll$/);
  if (scrM && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try { return sendJson(res, 200, await scrollSession(scrM[1], body)); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const keysM = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\/keys$/);
  if (keysM && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try { await sendKeysRaw(keysM[1], String(body.keys || '')); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const upM = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\/upload$/);
  if (upM && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 80 * 1024 * 1024)) || '{}');
    try { return sendJson(res, 200, await uploadImage(upM[1], body)); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const chatM = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\/chat$/);
  if (chatM && req.method === 'GET') {
    try {
      const { wire, activity, key } = await resolveWire(chatM[1]);
      const skip = Math.max(0, parseInt(u.searchParams.get('skip') || '0', 10));
      const st = refreshWireState(wire, activity);
      const payload = { key, messages: st.messages.slice(skip), ...statusPayload(st, activity) };
      payload.swarm = swarmStatus(path.dirname(path.dirname(path.dirname(wire))));
      return sendJson(res, 200, payload);
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const evM = u.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\/events$/);
  if (evM && req.method === 'GET') {
    return sseHandler(req, res, evM[1], Math.max(0, parseInt(u.searchParams.get('cursor') || '0', 10)));
  }
  // ── история на kimi сесиите + resume ──
  if (u.pathname === '/api/history' && req.method === 'GET') {
    const claimed = new Set(Object.values(paneMap));
    const rows = kimiStates()
      .filter(r => !claimed.has(r.key))
      .sort((a, b) => b.wireUpd - a.wireUpd)
      .slice(0, 60)
      .map(r => ({ key: r.key, title: r.title || '(untitled)', workDir: (r.workDir || '').replace(HOME, '~'), updated: r.wireUpd }));
    return sendJson(res, 200, { history: rows });
  }
  if (u.pathname === '/api/history/resume' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const key = String(body.key || '');
    if (!/^session_[a-f0-9-]+$/.test(key)) return sendJson(res, 400, { error: 'bad key' });
    const row = kimiStates().find(r => r.key === key);
    if (!row) return sendJson(res, 404, { error: 'unknown session' });
    const name = 'kr-r' + key.slice(8, 14);
    try {
      const dir = row.workDir && fs.existsSync(row.workDir) ? row.workDir : HOME;
      await tmux(['new-session', '-d', '-s', name, '-c', dir, 'kimi', '-S', key]);
      const out = await tmux(['ls', '-F', '#{session_id}\t#{session_name}']);
      const line = out.trim().split('\n').find(l => l.endsWith('\t' + name));
      if (line) lockPane(line.split('\t')[0], key);        // знаем сесията със сигурност — заключи веднага
      return sendJson(res, 201, { name });
    } catch (e) { return sendJson(res, 400, { error: e.message.includes('duplicate') ? 'already open (' + name + ')' : e.message }); }
  }
  // ── файлов преглед (tap на пътека в чата) ──
  if (u.pathname === '/api/file' && req.method === 'GET') {
    let p = String(u.searchParams.get('path') || '');
    if (p.startsWith('~')) p = HOME + p.slice(1);
    p = path.resolve(p);
    if (!p.startsWith(HOME + '/')) return sendJson(res, 403, { error: 'outside home' });
    let st;
    try { st = fs.statSync(p); } catch (_) { return sendJson(res, 404, { error: 'not found' }); }
    if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
    if (st.size > 512 * 1024) return sendJson(res, 400, { error: 'file too large (' + Math.round(st.size / 1024) + 'KB)' });
    const buf = fs.readFileSync(p);
    if (buf.slice(0, 8192).includes(0)) return sendJson(res, 400, { error: 'binary file' });
    return sendJson(res, 200, { path: p.replace(HOME, '~'), content: buf.toString('utf8') });
  }
  // ── web push ──
  if (u.pathname === '/api/push/vapid' && req.method === 'GET') {
    return sendJson(res, 200, { key: vapid.publicKey });
  }
  if (u.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) return sendJson(res, 400, { error: 'bad subscription' });
    pushSubs = pushSubs.filter(s => s.endpoint !== sub.endpoint);
    pushSubs.push(sub);
    saveSubs();
    return sendJson(res, 201, { ok: true, count: pushSubs.length });
  }
  if (u.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    pushSubs = pushSubs.filter(s => s.endpoint !== String(body.endpoint || ''));
    saveSubs();
    return sendJson(res, 200, { ok: true });
  }
  if (u.pathname === '/api/push/test' && req.method === 'POST') {
    broadcastPush({ title: '🔔 Kimi Remote', body: 'Push notifications are working.', tag: 'test', url: '/' });
    return sendJson(res, 200, { ok: true, count: pushSubs.length });
  }
  // authed на http → мост към https огледалото с токена (за mic permission)
  if (u.pathname === '/goto-https' && req.method === 'GET') {
    const port = parseInt(env.KIMI_REMOTE_HTTPS_PORT || '7683', 10);
    const host = (req.headers.host || '').split(':')[0];
    res.writeHead(302, { Location: `https://${host}:${port}/?token=${TOKEN}` });
    return res.end();
  }
  if (u.pathname === '/api/stt-config' && req.method === 'GET') {
    if (!env.SONIOX_API_KEY) return sendJson(res, 404, { error: 'no STT key' });
    return sendJson(res, 200, {
      url: 'wss://stt-rt.soniox.com/transcribe-websocket',
      config: {
        api_key: env.SONIOX_API_KEY,
        model: 'stt-rt-v5',
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ['bg', 'en', 'tr'],
        enable_language_identification: true,
        enable_endpoint_detection: true,
        max_endpoint_delay_ms: 3000,
        client_reference_id: 'kimi-remote',
      },
    });
  }
  // ── kimi subscription quota (чете OAuth токена, който kimi сам опреснява) ──
  if (u.pathname === '/api/quota' && req.method === 'GET') {
    if (quotaCache.data && Date.now() - quotaCache.at < 30000) return sendJson(res, 200, quotaCache.data);
    let tok;
    try { tok = JSON.parse(fs.readFileSync(path.join(HOME, '.kimi-code', 'credentials', 'kimi-code.json'), 'utf8')); }
    catch (_) { return sendJson(res, 503, { error: 'no kimi credentials' }); }
    try {
      const raw = await new Promise((resolve, reject) => {
        const rq = https.request('https://api.kimi.com/coding/v1/usages', {
          headers: { Authorization: 'Bearer ' + tok.access_token }, timeout: 8000,
        }, r => {
          let b = '';
          r.on('data', c => b += c);
          r.on('end', () => r.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error('HTTP ' + r.statusCode)));
        });
        rq.on('error', reject);
        rq.on('timeout', () => { rq.destroy(); reject(new Error('timeout')); });
        rq.end();
      });
      const N = v => parseInt(v, 10) || 0;
      const UNIT_MIN = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_SECOND: 1 / 60, TIME_UNIT_DAY: 1440 };
      const windows = (raw.limits || []).map(w => ({
        used: N(w.detail && w.detail.used),
        limit: N(w.detail && w.detail.limit),
        minutes: Math.round((w.window && w.window.duration || 0) * (UNIT_MIN[w.window && w.window.timeUnit] || 1)),
        reset: (w.detail && w.detail.resetTime) || '',
      }));
      const data = {
        weekly: { used: N(raw.usage && raw.usage.used), limit: N(raw.usage && raw.usage.limit), reset: (raw.usage && raw.usage.resetTime) || '' },
        windows,
        parallel: { used: (raw.parallel && raw.parallel.details || []).length, limit: N(raw.parallel && raw.parallel.limit) },
      };
      quotaCache = { at: Date.now(), data };
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 502, { error: 'usage fetch: ' + e.message }); }
  }
  if (u.pathname === '/api/version' && req.method === 'GET') {
    let v = 0;
    try { v = Math.round(fs.statSync(path.join(PUBLIC, 'index.html')).mtimeMs); } catch (_) {}
    return sendJson(res, 200, { v });
  }
  if (u.pathname === '/api/projects' && req.method === 'GET') {
    return sendJson(res, 200, { projects: listProjects() });
  }
  if (u.pathname === '/api/commands' && req.method === 'GET') {
    return sendJson(res, 200, { commands: listCommands() });
  }

  // static / shell
  if (u.pathname === '/' || u.pathname === '/index.html') {
    return void (serveStatic(res, 'index.html') || send(res, 500, 'missing index.html'));
  }
  const file = u.pathname.slice(1);
  if (!serveStatic(res, file)) send(res, 404, 'not found');
}

// --- WS upgrade ---
function onUpgrade(req, socket, head) {
  if (!authed(req)) return socket.destroy();
  const tm = req.url.match(/^\/term\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})\//);
  if (!tm || !SESSION_RE.test(tm[1])) return socket.destroy();
  ensureTtyd(tm[1])
    .then(port => {
      const upstream = net.connect(port, '127.0.0.1', () => {
        const target = req.url.slice(`/term/${tm[1]}`.length);
        let raw = `${req.method} ${target} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${v}\r\n`;
        raw += '\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    })
    .catch(() => socket.destroy());
}

const binds = ['127.0.0.1'];
if (TAILSCALE_IP) binds.push(TAILSCALE_IP);
// clean orphaned ttyd processes from previous server instances
// (they hold ports and would hijack other sessions' terminals)
try { spawn('pkill', ['-f', 'ttyd '], { stdio: 'ignore' }); } catch (_) {}
for (const addr of binds) {
  const srv = http.createServer((req, res) => handler(req, res).catch(e => send(res, 500, e.message)));
  srv.on('upgrade', onUpgrade);
  srv.on('error', e => console.error(`listen error on ${addr}:`, e.message));
  srv.listen(PORT, addr, () => console.log(`kimi-remote v2 listening on http://${addr}:${PORT}`));
}
// HTTPS (mic/getUserMedia изисква secure context) — LE cert през CF DNS-01
try {
  const tls = {
    key: fs.readFileSync(path.join(ROOT, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(ROOT, 'certs', 'fullchain.pem')),
  };
  const HTTPS_PORT = parseInt(env.KIMI_REMOTE_HTTPS_PORT || '7683', 10);
  for (const addr of binds) {
    const srv = https.createServer(tls, (req, res) => handler(req, res).catch(e => send(res, 500, e.message)));
    srv.on('upgrade', onUpgrade);
    srv.on('error', e => console.error(`https listen error on ${addr}:`, e.message));
    srv.listen(HTTPS_PORT, addr, () => console.log(`kimi-remote https on https://${addr}:${HTTPS_PORT}`));
  }
} catch (e) { console.error('no https (certs missing):', e.message); }
process.on('uncaughtException', e => console.error('uncaught:', e));
