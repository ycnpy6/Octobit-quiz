'use strict';
// Two bot teams play a full match against the server while we check invariants.
// Usage: node scripts/simulate.js [--level novice] [--domains code,theory] [--url ws://host:3000] [--matches 1]
//   Without --url it starts its own server on a spare port with fast timers and a temp state file.
//   With --url it drives that server, and since bots take the host and team roles, close real tabs first.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const LEVEL = opt('level', 'novice');
const MATCHES = Number(opt('matches', 1));
const DOMAINS = opt('domains') ? opt('domains').split(',') : undefined;
const { domainOf } = require('../game');
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const failures = [];
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions', `${LEVEL}.json`), 'utf8'))
  .filter((q) => !DOMAINS || DOMAINS.includes(domainOf(q.category))).length;
const played = new Set(); // regular questions from earlier matches in this run
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-sim-'));
  const config = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')),
    buzzWindowSec: 1.5, answerSec: 1.2, stealSec: 1, revealSec: 0.4 };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), CONFIG: path.join(dir, 'config.json'), STATE_FILE: path.join(dir, 'state.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    child.stdout.on('data', (d) => { if (String(d).includes('running')) res(); });
    child.on('exit', (code) => rej(new Error(`server exited (${code})`)));
  });
  return { url: `ws://localhost:${port}`, stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function client(url, role, onState) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.rejected = 0;
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', role })); res(ws); });
    ws.on('error', rej);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'buzz_rejected') ws.rejected++;
      if (m.type === 'taken_over') fail(`${role} was taken over by another client`);
      if (m.type === 'state') { ws.last = m.snapshot; onState(m.snapshot, raw.toString()); }
    });
    ws.cmd = (type, extra = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ type, ...extra }));
  });
}

async function playMatch(url, n) {
  console.log(`Match ${n}: ${LEVEL}`);
  let host, finished;
  const done = new Promise((r) => { finished = r; });
  const seen = { questions: new Set(), regular: new Set(), winners: {}, pausedOnce: false };
  const teams = {};
  const lastKey = {};

  // Team bots: buzz on BUZZ_OPEN (85%), answer when it's their turn (70% correct, 10% let the timer run out).
  const bot = (team) => async (s, raw) => {
    const c = s.current;
    if (c && s.phase !== 'REVEAL' && !(s.phase === 'PAUSED' && s.pausedPhase === 'REVEAL') && 'correct' in c) fail(`team ${team} saw the correct answer in ${s.phase}`);
    if (raw.includes('"log"') || raw.includes('"undo"')) fail(`team ${team} received host-only data`);
    if (!c) return;
    const key = `${s.index}:${s.phase}:${c.deadline}`;
    if (lastKey[team] === key) return;
    lastKey[team] = key;
    if (s.phase === 'BUZZ_OPEN' && !c.lockedOut.includes(team) && Math.random() < 0.85) {
      await sleep(rand(0, 40)); // near-simultaneous buzzes exercise arbitration
      teams[team].cmd('buzz');
    } else if (['LOCKED', 'STEAL'].includes(s.phase) && c.buzzedBy === team && Math.random() > 0.1) {
      await sleep(rand(50, 300));
      const correct = host.last.current && host.last.current.correct;
      const wrong = [0, 1, 2, 3].filter((i) => i !== correct);
      teams[team].cmd('answer', { index: Math.random() < 0.7 ? correct : wrong[Math.floor(Math.random() * 3)] });
    }
  };

  host = await client(url, 'host', async (s) => {
    const c = s.current;
    if (!seen.armed) return; // ignore leftovers from a previous match until we start ours
    if (c) seen.questions.add(c.id);
    if (c && s.mode === 'normal') seen.regular.add(c.id);
    if (c && DOMAINS && !DOMAINS.includes(domainOf(c.category))) fail(`${c.id} (${c.category}) is outside the chosen domains`);
    if (s.phase === 'LOCKED') {
      const prev = seen.winners[s.index];
      if (prev && prev !== c.buzzedBy && c.lockedOut.length === 0) fail(`question ${s.index} had two buzz winners`);
      seen.winners[s.index] = c.buzzedBy;
      if (!seen.pausedOnce && s.index === 1) { // exercise pause/resume while an answer timer runs
        seen.pausedOnce = true;
        host.cmd('pause');
        await sleep(300);
        host.cmd('resume');
      }
    }
    if (s.phase === 'QUESTION_SHOWN' && host.opened !== `${s.index}`) {
      host.opened = `${s.index}`;
      await sleep(50);
      host.cmd('open_buzz');
    }
    if (s.phase === 'FINISHED') finished(s);
  });
  teams.A = await client(url, 'team:A', bot('A'));
  teams.B = await client(url, 'team:B', bot('B'));
  const board = await client(url, 'board', (s) => {
    if (s.current && 'correct' in s.current && !['REVEAL', 'PAUSED'].includes(s.phase)) fail(`board saw the correct answer in ${s.phase}`);
  });
  await sleep(200);

  host.cmd('reset');
  await sleep(100);
  const t0 = Date.now();
  seen.armed = true;
  host.cmd('start_match', { level: LEVEL, domains: DOMAINS, names: { A: 'Bot A', B: 'Bot B' } });
  const timeout = sleep(5 * 60_000).then(() => null);
  const s = await Promise.race([done, timeout]);
  if (!s) fail('match did not finish within 5 minutes');
  else {
    const { A, B } = s.teams;
    const last = s.log.filter((e) => e.type === 'finished').pop();
    console.log(`  ${seen.questions.size} questions${s.mode === 'suddenDeath' ? ' (incl. sudden death)' : ''}, ${((Date.now() - t0) / 1000).toFixed(1)}s, final ${A.score} : ${B.score}, winner ${last.team || 'tie'} (${last.detail})`);
    console.log(`  buzz_rejected: A ${teams.A.rejected}, B ${teams.B.rejected}`);
    for (const [who, ws] of [['team A', teams.A], ['team B', teams.B], ['board', board]]) {
      const v = ws.last.teams;
      if (v.A.score !== A.score || v.B.score !== B.score) fail(`${who} shows different scores`);
    }
    const repeats = [...seen.regular].filter((id) => played.has(id)).length;
    if (repeats && played.size + seen.regular.size <= BANK) fail(`${repeats} question(s) repeated while unplayed ones were left`);
    for (const id of seen.regular) played.add(id);
    if (A.score === B.score && last.detail !== 'out of questions' && last.detail !== 'tie') fail('match ended tied without reason');
    if (A.score !== B.score && last.team !== (A.score > B.score ? 'A' : 'B')) fail('wrong winner');
  }
  for (const ws of [host, teams.A, teams.B, board]) ws.close();
}

(async () => {
  const urlArg = opt('url');
  const server = urlArg ? null : await startServer();
  const url = urlArg || server.url;
  try {
    for (let i = 1; i <= MATCHES; i++) await playMatch(url, i);
  } catch (e) {
    fail(e.message);
  } finally {
    if (server) server.stop();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures.length ? 1 : 0);
})();
