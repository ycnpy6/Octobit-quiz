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
  return { port, dir, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Each fake device has its own browser id, like a real browser keeps in storage.
const DEV = { teamA: 'device-team-a-0001', teamB: 'device-team-b-0001', cheat: 'device-cheater-0001' };

// Open a socket, send hello, and resolve with what happened: { state, refused, reason, closedCode, ws }.
function hello(url, role, device, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const out = { ws, msgs: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role, device })));
    ws.on('message', (m) => {
      const d = JSON.parse(m);
      out.msgs.push(d);
      if (d.type === 'state') out.state = d.snapshot;
      if (d.type === 'auth_failed') { out.refused = d.message; out.reason = d.reason; }
    });
    ws.on('close', (code) => { out.closedCode = code; resolve(out); });
    ws.on('error', () => {});
    setTimeout(() => resolve(out), 700);
  });
}
const get = (port, p, method = 'GET') => new Promise((r) => {
  const req = http.request({ host: lan.address, port, path: p, method }, (res) => { res.resume(); res.on('end', () => r(res)); });
  req.end();
});
const claimsOnDisk = (srv) => JSON.parse(fs.readFileSync(path.join(srv.dir, 'claims.json'), 'utf8'));

(async () => {
  const srv = await startServer();
  const remote = `ws://${lan.address}:${srv.port}`, local = `ws://localhost:${srv.port}`;
  console.log(`Attacking a private server through ${lan.address}:${srv.port}`);

  let r = await hello(remote, 'host', DEV.cheat);
  check(!!r.refused && !r.state, 'a LAN device cannot open the host console');
  r = await hello(remote, 'team:B', DEV.teamB, { Origin: 'http://evil.example' });
  check(r.closedCode === 4003 && !r.state, 'a socket from another origin is closed');

  // Each screen locks to the first device that opens it.
  const teamA = await hello(remote, 'team:A', DEV.teamA);
  check(!!teamA.state, 'the first device to open team A gets it');
  const teamB = await hello(remote, 'team:B', DEV.teamB);
  check(!!teamB.state, 'the first device to open team B gets it');
  r = await hello(remote, 'team:B', DEV.teamA);
  check(r.reason === 'in_use' && !r.state, "team A's device cannot open team B's screen");
  r = await hello(remote, 'team:A', DEV.cheat);
  check(r.reason === 'in_use' && !r.state, 'another device cannot take over team A');
  check(teamA.ws.readyState === WebSocket.OPEN, 'team A stays connected while others are refused');
  r = await hello(remote, 'board');
  check(!!r.refused && !r.state, 'a device without a browser id is refused');
  check(!JSON.stringify(teamA.msgs).includes(DEV.teamB) && !teamA.state.claims, 'team snapshots never carry device ids or claims');

  // A host on the server computer starts a match; team A tries to read the answer and false-start.
  const host = await hello(local, 'host');
  check(!!host.state && host.state.claims && !!host.state.claims['team:A'] && !JSON.stringify(host.state).includes(DEV.teamA),
    'the host sees which address holds each screen, never the device ids');
  host.ws.send(JSON.stringify({ type: 'start_match', level: 'novice' }));
  await sleep(300);
  const q = teamA.state.current;
  check(!!q && !('correct' in q), 'team A sees the question without the correct answer');
  teamA.ws.send(JSON.stringify({ type: 'buzz' }));
  await sleep(200);
  check(teamA.msgs.some((m) => m.type === 'buzz_rejected' && m.reason === 'false_start'), 'buzzing before the buzzers open is a false start');
  teamA.ws.send(JSON.stringify({ type: 'open_buzz' }));
  teamA.ws.send(JSON.stringify({ type: 'adjust_score', team: 'A', delta: 100 }));
  teamA.ws.send(JSON.stringify({ type: 'release', role: 'team:B' }));
  await sleep(200);
  check(teamA.state.phase === 'QUESTION_SHOWN' && teamA.state.teams.A.score === 0, 'a team cannot send host commands');
  check(!!claimsOnDisk(srv)['team:B'], 'a team cannot release screens');

  // The same device gets its screen back after dropping off; a buzz flood then gets it cut off.
  teamB.ws.close();
  await sleep(150);
  const flood = await hello(remote, 'team:B', DEV.teamB);
  check(!!flood.state, 'the same device gets its screen back after a reconnect');
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
  check((await get(srv.port, '/claims.json')).statusCode === 404, 'the claims file is not served');
  check((await get(srv.port, '/board', 'POST')).statusCode === 405, 'only GET and HEAD are allowed');
  const page = await get(srv.port, '/board');
  check(/frame-ancestors 'none'/.test(page.headers['content-security-policy'] || '') && page.headers['referrer-policy'] === 'no-referrer', 'pages send CSP and no-referrer');

  // Claims are saved, and the host can release a screen to a new device.
  check(claimsOnDisk(srv)['team:A'].device === DEV.teamA, 'claims are saved, so a restart keeps them');
  host.ws.send(JSON.stringify({ type: 'release', role: 'team:A' }));
  await sleep(300);
  check(teamA.msgs.some((m) => m.type === 'auth_failed' && m.reason === 'released'), 'releasing a screen disconnects the device holding it');
  const moved = await hello(remote, 'team:A', DEV.cheat);
  check(!!moved.state, 'after a release, the next device to open the screen gets it');

  for (const s of [teamA, host, moved]) s.ws.close();
  srv.stop();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `\n${failed} check(s) failed.` : `\nAll ${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
