'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const config = JSON.parse(fs.readFileSync(process.env.CONFIG || path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT) || config.port;
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');
const HISTORY_FILE = path.join(path.dirname(STATE_FILE), 'history.json');
const CLAIMS_FILE = path.join(path.dirname(STATE_FILE), 'claims.json');

// ---------- state, questions, timers ----------
let state = game.initialState(config);
const ctx = { config, bank: {} };
let timer = null;

// Questions per level and domain, for the host's checklist: { level: { domain: n } }.
let counts = {};

// (Re)load all question files; returns { level: [ids] }. Ids must be unique across levels.
// Options are shuffled on every load, so the right answer moves between matches.
function loadQuestions() {
  const byLevel = {};
  ctx.bank = {};
  for (const level of game.LEVELS) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions', `${level}.json`), 'utf8')); }
    catch (e) { console.warn(`Could not load questions/${level}.json: ${e.message}`); }
    byLevel[level] = list.map((q) => q.id);
    counts[level] = {};
    for (const q of list) { const d = game.domainOf(q.category); counts[level][d] = (counts[level][d] || 0) + 1; }
    for (const q of list) {
      const order = shuffle([0, 1, 2, 3]);
      ctx.bank[q.id] = { ...q, options: order.map((i) => q.options[i]), correct: order.indexOf(q.correct) };
    }
  }
  return byLevel;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Ids played in earlier matches, per level. New matches draw unplayed questions first;
// once a level is used up, its cycle starts again.
let history = {};
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }

// ids is the level's questions in the chosen domains; history for other domains is kept.
function pickQueue(level, ids) {
  const played = new Set((history[level] || []).filter((id) => ctx.bank[id]));
  const queue = [...shuffle(ids.filter((id) => !played.has(id))), ...shuffle(ids.filter((id) => played.has(id)))];
  const used = queue.slice(0, config.questionsPerMatch);
  for (const id of used) played.add(id);
  if (ids.every((id) => played.has(id))) for (const id of ids) if (!used.includes(id)) played.delete(id); // cycle done
  return { queue, history: [...played] };
}

// Keep only questions in the chosen domains; no list means every domain.
function inDomains(ids, domains) {
  if (!Array.isArray(domains)) return ids;
  return ids.filter((id) => domains.includes(game.domainOf(ctx.bank[id].category)));
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) { console.error('Could not save history:', e.message); }
}

function dispatch(event, ws) {
  const r = game.step(state, event, Date.now(), ctx);
  for (const e of r.effects) send(ws, e);
  if (r.state === state) return;
  state = r.state;
  save();
  broadcast();
  schedule();
}

// Atomic write: temp file then rename, so a crash never leaves a half-written state.json.
function save() {
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), state }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('Could not save state:', e.message); }
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved.state && saved.state.version === 1) {
      state = game.restore(saved.state, saved.savedAt);
      if (state.restored) console.log(`Match restored from ${path.basename(STATE_FILE)} (paused). Press Resume on the host.`);
    }
  } catch (e) { if (e.code !== 'ENOENT') console.warn('Ignoring unreadable state file:', e.message); }
}

// One timer, always aimed at the current deadline; the game ignores stale firings.
function schedule() {
  clearTimeout(timer);
  const d = state.current && state.current.deadline;
  if (d) timer = setTimeout(() => dispatch({ type: 'timeout', deadline: d }), Math.max(0, d - Date.now()));
}

// ---------- HTTP static ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
const PAGES = { '/': 'host.html', '/host': 'host.html', '/board': 'board.html', '/team/A': 'team.html', '/team/B': 'team.html' };

// Optional TLS: set config.tls = { cert, key } (PEM file paths) to serve HTTPS and WSS. See README.
const TLS = config.tls && config.tls.cert && config.tls.key
  ? { cert: fs.readFileSync(path.resolve(ROOT, config.tls.cert)), key: fs.readFileSync(path.resolve(ROOT, config.tls.key)) }
  : null;
const SCHEME = TLS ? 'https' : 'http';
// Locked down: same-origin scripts and sockets only, no framing, no referrer.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  ...(TLS ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

function onRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS }).end(); return; }
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const rel = PAGES[url] || url.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, SECURITY_HEADERS).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
const server = TLS ? https.createServer(TLS, onRequest) : http.createServer(onRequest);
server.headersTimeout = 10000;
server.requestTimeout = 15000;

// ---------- WebSocket ----------
const ROLES = ['team:A', 'team:B', 'board', 'host'];
const TEAM_EVENTS = ['buzz', 'answer'];
const HOST_EVENTS = ['start_match', 'open_buzz', 'next_question', 'override', 'skip', 'pause', 'resume',
  'adjust_score', 'undo_last', 'reset', 'set_names'];
const clients = new Map(); // role -> ws (newest wins)
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const RATE_LIMIT = 30; // messages per second per socket; far above any human, far below a buzz-flooding script
const MAX_SOCKETS = 40, MAX_PER_IP = 6; // a quiz needs 4 screens; this stops one machine from exhausting the server
const HELLO_TIMEOUT_MS = 5000; // sockets that never identify themselves are dropped

// ---------- screen claims ----------
// No codes: each screen (board, team A, team B) locks to the first device that opens it. Every browser keeps a
// random device id, so the same device gets back in after a refresh, a Wi-Fi drop or a server restart, while any
// other device is refused. The host console shows who holds each screen and can release it.
// Scripts on the server computer that send no device id (simulator, checks) are let through without claiming.
let claims = {};
try { claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')) || {}; } catch { /* first run */ }
function saveClaims() { try { fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims)); } catch (e) { console.error('Could not save claims:', e.message); } }
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
const validDevice = (d) => typeof d === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(d);

// Returns null when allowed, else { reason, message } for the device.
function refuse(ws, role, device) {
  if (role === 'host' && !ws.local && !config.hostFromLan) return { reason: 'host_only', message: 'The host console only opens on the server computer.' };
  if (ws.local && !validDevice(device)) return null;
  if (!validDevice(device)) return { reason: 'no_device', message: 'This browser blocks storage. Use a normal (not private) window.' };
  const c = claims[role];
  if (!c || c.device === device || ws.local) return null; // free, the same device, or the server computer taking it back
  return { reason: 'in_use', message: 'This screen is already open on another device. Ask the host to release it.' };
}
function claim(ws, role, device) {
  if (!validDevice(device) || (role === 'host' && ws.local)) return; // the host on the server computer needs no claim
  const c = claims[role];
  if (c && c.device === device && c.ip === cleanIp(ws.ip)) return;
  claims[role] = { device, ip: cleanIp(ws.ip) };
  saveClaims();
}
// Who holds each screen, by address only (device ids never leave the server).
const claimView = () => Object.fromEntries(ROLES.map((r) => [r, claims[r] ? claims[r].ip : null]));

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function presence() { return { A: clients.has('team:A'), B: clients.has('team:B'), board: clients.has('board') }; }

function viewFor(role) {
  const snap = game.viewFor(state, role);
  if (role === 'host') Object.assign(snap, { presence: presence(), urls: lanAddresses().map((ip) => `${SCHEME}://${ip}:${PORT}`), claims: claimView(),
    domains: game.DOMAINS.map(({ key, name }) => ({ key, name })), counts, perMatch: config.questionsPerMatch });
  return snap;
}

// Full phase durations (ms) let clients draw countdown rings.
const durations = { BUZZ_OPEN: config.buzzWindowSec * 1000, LOCKED: config.answerSec * 1000, STEAL: config.stealSec * 1000, REVEAL: config.revealSec * 1000 };
function sendState(role) { send(clients.get(role), { type: 'state', snapshot: viewFor(role), serverNow: Date.now(), you: role, durations, levels: game.LEVEL_INFO }); }
function broadcast() { for (const role of clients.keys()) sendState(role); }
function broadcastPresence() {
  const p = presence();
  for (const ws of clients.values()) send(ws, { type: 'presence', ...p });
  sendState('host');
}

wss.on('connection', (ws, req) => {
  // Pages are only ever served from this server, so a different Origin means another site is trying to connect.
  const origin = req.headers.origin;
  try { if (origin && new URL(origin).host !== req.headers.host) { ws.close(4003, 'bad origin'); return; } } catch { ws.close(4003, 'bad origin'); return; }
  ws.ip = req.socket.remoteAddress;
  const fromIp = [...wss.clients].filter((c) => c.ip === ws.ip).length;
  if (wss.clients.size > MAX_SOCKETS || fromIp > MAX_PER_IP) { ws.close(4008, 'too many connections'); return; }
  ws.role = null;
  ws.alive = true;
  ws.local = isLocal(req);
  ws.helloTimer = setTimeout(() => { if (!ws.role) ws.terminate(); }, HELLO_TIMEOUT_MS);
  ws.rate = { since: Date.now(), n: 0 };
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - ws.rate.since >= 1000) ws.rate = { since: now, n: 0 };
    if (++ws.rate.n > RATE_LIMIT) { if (ws.rate.n > RATE_LIMIT * 5) ws.terminate(); return; } // drop floods, cut off abusers
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'hello') {
      if (!ROLES.includes(msg.role)) { send(ws, { type: 'error', message: 'Unknown role' }); return; }
      const why = refuse(ws, msg.role, msg.device);
      if (why) {
        console.warn(`Refused ${msg.role} from ${cleanIp(ws.ip)} (${why.reason})`);
        send(ws, { type: 'auth_failed', ...why });
        ws.close(4001, 'refused');
        return;
      }
      const old = clients.get(msg.role);
      if (old && old !== ws) { old.role = null; send(old, { type: 'taken_over' }); old.close(4000, 'taken over'); }
      if (ws.role && ws.role !== msg.role) clients.delete(ws.role);
      claim(ws, msg.role, msg.device);
      ws.role = msg.role;
      clearTimeout(ws.helloTimer);
      clients.set(msg.role, ws);
      sendState(msg.role);
      broadcastPresence();
      return;
    }
    if (!ws.role) { send(ws, { type: 'error', message: 'Say hello first' }); return; }
    handle(ws, msg);
  });
  ws.on('close', () => {
    if (ws.role && clients.get(ws.role) === ws) { clients.delete(ws.role); broadcastPresence(); }
  });
});

// Heartbeat: drop sockets that stop answering pings (e.g. Wi-Fi unplugged) so presence stays truthful.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 5000).unref();

// Role permissions are checked here; anything not allowed (e.g. a team sending a host event) is dropped.
function handle(ws, msg) {
  const role = ws.role;
  if (role.startsWith('team:') && TEAM_EVENTS.includes(msg.type)) {
    dispatch({ type: msg.type, index: msg.index, team: role.slice(5) }, ws);
  } else if (role === 'host' && msg.type === 'start_match') {
    if (Array.isArray(msg.domains) && !msg.domains.length) { send(ws, { type: 'error', message: 'Tick at least one domain' }); return; }
    const pick = pickQueue(msg.level, inDomains(loadQuestions()[msg.level] || [], msg.domains));
    if (!pick.queue.length) { send(ws, { type: 'error', message: 'No questions at this level in the ticked domains' }); return; }
    const before = state;
    dispatch({ type: 'start_match', level: msg.level, names: msg.names, queue: pick.queue }, ws);
    if (state !== before) { history[msg.level] = pick.history; saveHistory(); }
  } else if (role === 'host' && msg.type === 'release' && ROLES.includes(msg.role) && msg.role !== 'host') {
    // Free a screen so another device can open it; the device holding it now is disconnected.
    delete claims[msg.role];
    saveClaims();
    const w = clients.get(msg.role);
    if (w) {
      send(w, { type: 'auth_failed', reason: 'released', message: 'The host released this screen. Reload to open it here again.' });
      w.close(4001, 'released');
    }
    sendState('host');
  } else if (role === 'host' && HOST_EVENTS.includes(msg.type)) {
    dispatch(msg, ws);
  }
}

// ---------- boot ----------
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out.length ? out : ['localhost'];
}

loadQuestions();
load();
// ws re-emits the HTTP server's listen errors, so both need the handler.
function onListenError(e) {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is the quiz already running? Stop it or set PORT=3001.` : e.message);
  process.exit(1);
}
server.on('error', onListenError);
wss.on('error', onListenError);
server.listen(PORT, () => {
  console.log(`Octobit Quiz running on port ${PORT}${TLS ? ' (HTTPS)' : ''}`);
  console.log(`  Host (this computer only): ${SCHEME}://localhost:${PORT}/host\n`);
  for (const ip of lanAddresses()) {
    const base = `${SCHEME}://${ip}:${PORT}`;
    console.log(`  Board:  ${base}/board\n  Team A: ${base}/team/A\n  Team B: ${base}/team/B`);
    if (config.hostFromLan) console.log(`  Host:   ${base}/host`);
    console.log('');
  }
  console.log('  Each screen locks to the first device that opens it. Release one from the host console to move it.');
});
