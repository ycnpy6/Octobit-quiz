'use strict';
// Attacks a private server the way a player on the LAN could, and checks each attempt is refused.
// Connects through this machine's LAN address so the server treats it as a remote device.
// Usage: node scripts/security-check.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
if (!lan) { console.log('No LAN address on this machine; nothing to test remotely.'); process.exit(0); }
const results = [];
const check = (ok, name) => { results.push(ok); console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`); };

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-sec-'));
  const config = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')), hostFromLan: false, tls: undefined };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const port = 3990 + Math.floor(Math.random() * 9);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), CONFIG: path.join(dir, 'config.json'), STATE_FILE: path.join(dir, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => { child.stdout.on('data', (d) => { if (String(d).includes('running')) res(); }); child.on('exit', rej); });
  const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
  return { port, keys, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Open a socket, send hello, and resolve with what happened: { state, refused, closedCode, ws }.
function hello(url, role, key, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const out = { ws, msgs: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, key })));
    ws.on('message', (m) => { const d = JSON.parse(m); out.msgs.push(d); if (d.type === 'state') out.state = d.snapshot; if (d.type === 'auth_failed') out.refused = d.message; });
    ws.on('close', (code) => { out.closedCode = code; resolve(out); });
    ws.on('error', () => {});
    setTimeout(() => resolve(out), 700);
  });
}
const get = (port, p, method = 'GET') => new Promise((r) => {
  const req = http.request({ host: lan.address, port, path: p, method }, (res) => { res.resume(); res.on('end', () => r(res)); });
  req.end();
});

(async () => {
  const srv = await startServer();
  const remote = `ws://${lan.address}:${srv.port}`, local = `ws://localhost:${srv.port}`;
  console.log(`Attacking a private server through ${lan.address}:${srv.port}`);

  let r = await hello(remote, 'host');
  check(!!r.refused && !r.state, 'a LAN device cannot open the host console');
  r = await hello(remote, 'team:B');
  check(!!r.refused && !r.state, 'a team screen without its key is refused');
  r = await hello(remote, 'team:B', srv.keys['team:A']);
  check(!!r.refused, "team A's key does not unlock team B");
  r = await hello(remote, 'board', 'guess');
  check(!!r.refused, 'a guessed board key is refused');
  r = await hello(remote, 'team:B', srv.keys['team:B'], { Origin: 'http://evil.example' });
  check(r.closedCode === 4003 && !r.state, 'a socket from another origin is closed');

  const teamA = await hello(remote, 'team:A', srv.keys['team:A']);
  check(!!teamA.state, 'team A with its own key gets in');
  check(!JSON.stringify(teamA.msgs).includes(srv.keys.board), 'team snapshots never carry device keys');

  // A host on the server computer starts a match; team A tries to read the answer and false-start.
  const host = await hello(local, 'host');
  check(!!host.state && host.state.keys && host.state.keys.board === srv.keys.board, 'the local host console sees the device keys');
  host.ws.send(JSON.stringify({ type: 'start_match', level: 'novice' }));
  await sleep(300);
  const q = teamA.state.current;
  check(!!q && !('correct' in q), 'team A sees the question without the correct answer');
  teamA.ws.send(JSON.stringify({ type: 'buzz' }));
  await sleep(200);
  check(teamA.msgs.some((m) => m.type === 'buzz_rejected' && m.reason === 'false_start'), 'buzzing before the buzzers open is a false start');
  teamA.ws.send(JSON.stringify({ type: 'open_buzz' }));
  teamA.ws.send(JSON.stringify({ type: 'adjust_score', team: 'A', delta: 100 }));
  await sleep(200);
  check(teamA.state.phase === 'QUESTION_SHOWN' && teamA.state.teams.A.score === 0, 'a team cannot send host commands');

  // Flooding: hundreds of buzzes in a burst get dropped and the socket is cut off.
  const flood = await hello(remote, 'team:B', srv.keys['team:B']);
  for (let i = 0; i < 400; i++) flood.ws.send(JSON.stringify({ type: 'buzz' }));
  await sleep(400);
  check(flood.ws.readyState !== WebSocket.OPEN, 'a buzz flood gets the socket cut off');


  // A socket that never says hello is dropped.
  const idle = new WebSocket(remote);
  idle.on('error', () => {});
  await sleep(5600);
  check(idle.readyState !== WebSocket.OPEN, 'a socket that never identifies itself is dropped');

  // HTTP: only public files, GET only, security headers on.
  check((await get(srv.port, '/questions/novice.json')).statusCode === 404, 'question files are not served');
  check([403, 404].includes((await get(srv.port, '/../state.json')).statusCode), 'path traversal is blocked');
  check((await get(srv.port, '/keys.json')).statusCode === 404, 'the keys file is not served');
  check((await get(srv.port, '/board', 'POST')).statusCode === 405, 'only GET and HEAD are allowed');
  const page = await get(srv.port, '/board');
  check(/frame-ancestors 'none'/.test(page.headers['content-security-policy'] || '') && page.headers['referrer-policy'] === 'no-referrer', 'pages send CSP and no-referrer');

  // Renewing links disconnects screens on the old link.
  const victim = await hello(remote, 'team:A', srv.keys['team:A']);
  host.ws.send(JSON.stringify({ type: 'new_keys' }));
  await sleep(300);
  check(victim.msgs.some((m) => m.type === 'auth_failed' && /renewed/.test(m.message)), 'new device links disconnect the old ones');

  // Brute force: five wrong keys lock the address out, even for the right key, for a minute.
  for (let i = 0; i < 5; i++) await hello(remote, 'board', `wrong-${i}`);
  r = await hello(remote, 'board', srv.keys.board);
  check(!!r.refused && /Too many/.test(r.refused), 'repeated wrong keys lock the device out');

  for (const s of [teamA, host, victim]) s.ws.close();
  srv.stop();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `\n${failed} check(s) failed.` : `\nAll ${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
