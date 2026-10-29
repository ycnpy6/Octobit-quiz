'use strict';
// Pure quiz state machine: step(state, event, now, ctx) -> { state, effects }.
// No timers, sockets or randomness. ctx = { config, bank: { [id]: question } }.

const LEVELS = ['novice', 'apprentice', 'wizard', 'kraken'];
// Display names, easiest first. Sent to clients with every state message.
const LEVEL_INFO = [
  { key: 'novice', name: 'Novice', tagline: 'First dive' },
  { key: 'apprentice', name: 'Apprentice', tagline: 'Deeper water' },
  { key: 'wizard', name: 'Wizard', tagline: 'Arcane code' },
  { key: 'kraken', name: 'Kraken', tagline: 'Boss level' },
];
// IT domains the host can pick per match. Each question's category belongs to exactly one.
const DOMAINS = [
  { key: 'algorithms', name: 'Algorithms & data structures', categories: ['Algorithms', 'Data Structures'] },
  { key: 'programming', name: 'Programming languages', categories: ['Programming'] },
  { key: 'code', name: 'Code reading & debugging', categories: ['What does it do?', 'Spot the error', 'Fix the bug'] },
  { key: 'systems', name: 'Systems programming & OS', categories: ['Operating Systems', 'Concurrency', 'Compilers'] },
  { key: 'architecture', name: 'Computer architecture', categories: ['Architecture'] },
  { key: 'networks', name: 'Networking', categories: ['Networks'] },
  { key: 'databases', name: 'Databases', categories: ['Databases'] },
  { key: 'web', name: 'Web development', categories: ['Web'] },
  { key: 'security', name: 'Cybersecurity', categories: ['Security'] },
  { key: 'ai', name: 'AI & machine learning', categories: ['AI/ML'] },
  { key: 'softeng', name: 'Software engineering', categories: ['Software Engineering'] },
  { key: 'theory', name: 'Theory of computation', categories: ['Theory'] },
  { key: 'distributed', name: 'Distributed systems', categories: ['Distributed Systems'] },
  { key: 'history', name: 'History of computing', categories: ['History'] },
];
const domainOf = (category) => (DOMAINS.find((d) => d.categories.includes(category)) || {}).key || null;
const ACTIVE = ['QUESTION_SHOWN', 'BUZZ_OPEN', 'LOCKED', 'STEAL', 'REVEAL'];
const TIMER = { BUZZ_OPEN: 'buzzWindowSec', LOCKED: 'answerSec', STEAL: 'stealSec', REVEAL: 'revealSec' };
const LOG_MAX = 50;
const UNDO_MAX = 20;
const other = (t) => (t === 'A' ? 'B' : 'A');
const isTeam = (t) => t === 'A' || t === 'B';

function initialState(config) {
  return {
    version: 1,
    phase: 'LOBBY',
    level: LEVELS[0],
    teams: { A: { name: config.teamNames.A, score: 0 }, B: { name: config.teamNames.B, score: 0 } },
    queue: [],
    index: 0,
    total: 0, // questions in the regular part of the match
    mode: 'normal',
    current: null,
    pausedPhase: null,
    pausedRemainingMs: null,
    restored: false,
    log: [],
    undo: [], // snapshots taken before each scoring event
  };
}

function addLog(s, now, type, team = null, detail = null) {
  s.log.push({ t: now, type, team, detail });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
}

function setPhase(s, phase, now, cfg) {
  s.phase = phase;
  if (s.current) s.current.deadline = TIMER[phase] ? now + cfg[TIMER[phase]] * 1000 : null;
}

function checkpoint(s, now) {
  const { undo, log, ...rest } = s;
  undo.push({ at: now, state: structuredClone(rest) });
  if (undo.length > UNDO_MAX) undo.shift();
}

function award(s, team, delta, now, reason) {
  s.teams[team].score += delta;
  addLog(s, now, 'score', team, `${delta >= 0 ? '+' : ''}${delta} (${reason})`);
}

function loadQuestion(s, now, ctx) {
  const q = ctx.bank[s.queue[s.index]];
  s.current = {
    id: q.id, category: q.category, text: q.text, options: [...q.options], correct: q.correct,
    ...(q.code ? { code: q.code } : {}), // optional snippet for code questions
    buzzedBy: null, lockedOut: [], answered: null, deadline: null,
    falseStart: [], openedAt: null, // teams that buzzed before the buzzers opened, and when they opened
  };
  setPhase(s, 'QUESTION_SHOWN', now, ctx.config);
}

function finish(s, now, why) {
  const { A, B } = s.teams;
  s.phase = 'FINISHED';
  s.current = null;
  addLog(s, now, 'finished', A.score === B.score ? null : A.score > B.score ? 'A' : 'B', why);
}

// REVEAL -> next question, sudden death, or FINISHED.
function advance(s, now, ctx) {
  const cfg = ctx.config;
  s.index += 1;
  const tied = s.teams.A.score === s.teams.B.score;
  if (s.index >= s.total) {
    if (s.mode === 'normal') {
      if (!tied || !cfg.suddenDeathQuestions) return finish(s, now, tied ? 'tie' : 'last question');
      s.mode = 'suddenDeath';
      addLog(s, now, 'sudden_death');
    } else if ((s.index - s.total) % cfg.suddenDeathQuestions === 0 && !tied) {
      return finish(s, now, 'sudden death');
    }
  }
  if (s.index >= s.queue.length) return finish(s, now, 'out of questions');
  if (!ctx.bank[s.queue[s.index]]) return finish(s, now, 'question missing from bank');
  loadQuestion(s, now, ctx);
}

// Resolve the answering team's attempt in LOCKED or STEAL.
function resolve(s, team, index, correct, now, cfg, reason) {
  checkpoint(s, now);
  const c = s.current;
  const p = cfg.points;
  if (s.phase === 'STEAL') {
    c.answered = { team, index, correct, steal: true };
    award(s, team, correct ? p.stealCorrect : p.stealWrong, now, reason);
    return setPhase(s, 'REVEAL', now, cfg);
  }
  c.answered = { team, index, correct };
  if (correct) {
    award(s, team, p.correct, now, reason);
    return setPhase(s, 'REVEAL', now, cfg);
  }
  award(s, team, p.wrong, now, reason);
  if (cfg.lockoutOnWrong && !c.lockedOut.includes(team)) c.lockedOut.push(team);
  if (cfg.allowSteal && !c.lockedOut.includes(other(team))) {
    c.buzzedBy = other(team);
    return setPhase(s, 'STEAL', now, cfg);
  }
  setPhase(s, 'REVEAL', now, cfg);
}

function handle(s, e, now, ctx) {
  const cfg = ctx.config;
  const c = s.current;
  switch (e.type) {
    case 'start_match': {
      if (s.phase !== 'LOBBY') return 'Match already started';
      if (!LEVELS.includes(e.level)) return 'Unknown level';
      if (!Array.isArray(e.queue) || !e.queue.length || !e.queue.every((id) => ctx.bank[id])) return 'No questions for this level';
      if (e.names) { const err = applyNames(s, e.names); if (err) return err; }
      Object.assign(s, { level: e.level, queue: [...e.queue], index: 0, mode: 'normal', undo: [], restored: false,
        total: Math.min(cfg.questionsPerMatch, e.queue.length) });
      s.teams.A.score = 0;
      s.teams.B.score = 0;
      addLog(s, now, 'start', null, e.level);
      return loadQuestion(s, now, ctx);
    }
    case 'open_buzz':
      if (s.phase !== 'QUESTION_SHOWN') return 'Buzzers can only open after a question is shown';
      addLog(s, now, 'buzz_open');
      c.openedAt = now;
      return setPhase(s, 'BUZZ_OPEN', now, cfg);
    case 'buzz': {
      // A buzz before the buzzers open is a false start: that team is held back for falseStartSec once they open.
      if (s.phase === 'QUESTION_SHOWN' && isTeam(e.team)) {
        if (c.falseStart.includes(e.team)) return { type: 'buzz_rejected', reason: 'false_start' };
        c.falseStart.push(e.team);
        addLog(s, now, 'false_start', e.team);
        return { type: 'buzz_rejected', reason: 'false_start', keep: true };
      }
      if (s.phase !== 'BUZZ_OPEN' || !isTeam(e.team) || c.lockedOut.includes(e.team)) return { type: 'buzz_rejected' };
      const held = (c.falseStart || []).includes(e.team) && now < (c.openedAt || 0) + (cfg.falseStartSec ?? 1.5) * 1000;
      if (held) return { type: 'buzz_rejected', reason: 'false_start' };
      c.buzzedBy = e.team;
      addLog(s, now, 'buzz', e.team);
      return setPhase(s, 'LOCKED', now, cfg);
    }
    case 'answer':
      if (!['LOCKED', 'STEAL'].includes(s.phase) || c.buzzedBy !== e.team) return 'Not your turn to answer';
      if (!Number.isInteger(e.index) || e.index < 0 || e.index > 3) return 'Invalid answer';
      addLog(s, now, 'answer', e.team, 'ABCD'[e.index]);
      return resolve(s, e.team, e.index, e.index === c.correct, now, cfg, s.phase === 'STEAL' ? 'steal' : 'answer');
    case 'override':
      if (!['LOCKED', 'STEAL'].includes(s.phase)) return 'Nothing to override';
      if (!['correct', 'wrong'].includes(e.result)) return 'Invalid override';
      addLog(s, now, 'override', c.buzzedBy, e.result);
      return resolve(s, c.buzzedBy, null, e.result === 'correct', now, cfg, 'override');
    case 'timeout':
      // Ignore stale timers (state changed since the timer was set).
      if (!c || !c.deadline || now < c.deadline - 50 || (e.deadline && e.deadline !== c.deadline)) return null;
      if (s.phase === 'REVEAL') return advance(s, now, ctx);
      addLog(s, now, 'timeout', c.buzzedBy, s.phase);
      if (s.phase === 'LOCKED') return resolve(s, c.buzzedBy, null, false, now, cfg, 'timeout');
      if (s.phase === 'BUZZ_OPEN' || s.phase === 'STEAL') return setPhase(s, 'REVEAL', now, cfg);
      return null;
    case 'next_question':
      if (s.phase !== 'REVEAL') return 'Next is only available after the reveal';
      return advance(s, now, ctx);
    case 'skip':
      if (!['QUESTION_SHOWN', 'BUZZ_OPEN', 'LOCKED', 'STEAL'].includes(s.phase)) return 'Nothing to skip';
      addLog(s, now, 'skip');
      return setPhase(s, 'REVEAL', now, cfg);
    case 'pause':
      if (!ACTIVE.includes(s.phase)) return 'Nothing to pause';
      s.pausedPhase = s.phase;
      s.pausedRemainingMs = c && c.deadline ? Math.max(0, c.deadline - now) : null;
      if (c) c.deadline = null;
      s.phase = 'PAUSED';
      return addLog(s, now, 'pause');
    case 'resume':
      if (s.phase !== 'PAUSED') return 'Not paused';
      s.phase = s.pausedPhase;
      if (c) c.deadline = s.pausedRemainingMs == null ? null : now + s.pausedRemainingMs;
      Object.assign(s, { pausedPhase: null, pausedRemainingMs: null, restored: false });
      return addLog(s, now, 'resume');
    case 'adjust_score': {
      if (s.phase === 'LOBBY') return 'No match in progress';
      if (!isTeam(e.team) || !Number.isInteger(e.delta) || !e.delta || Math.abs(e.delta) > 1000) return 'Invalid adjustment';
      checkpoint(s, now);
      return award(s, e.team, e.delta, now, 'manual');
    }
    case 'undo_last': {
      const entry = s.undo.pop();
      if (!entry) return 'Nothing to undo';
      const snap = entry.state;
      if (snap.current && snap.current.deadline) snap.current.deadline = now + Math.max(0, snap.current.deadline - entry.at);
      const { log, undo } = s;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, snap, { log, undo });
      return addLog(s, now, 'undo');
    }
    case 'set_names':
      return applyNames(s, e) || addLog(s, now, 'names', null, `${s.teams.A.name} / ${s.teams.B.name}`);
    case 'reset': {
      const fresh = initialState(cfg);
      fresh.teams.A.name = s.teams.A.name;
      fresh.teams.B.name = s.teams.B.name;
      fresh.level = s.level;
      fresh.log = s.log;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, fresh);
      return addLog(s, now, 'reset');
    }
    default:
      return `Unknown event: ${e.type}`;
  }
}

function applyNames(s, names) {
  for (const t of ['A', 'B']) {
    if (names[t] === undefined) continue;
    const n = typeof names[t] === 'string' ? names[t].trim() : '';
    if (!n || n.length > 30) return 'Team names must be 1-30 characters';
    s.teams[t].name = n;
  }
}

// Handlers mutate a clone and return: undefined (changed), null (silently ignored),
// a string (error for the sender) or an effect object (state kept only if it has keep: true).
function step(state, event, now, ctx) {
  const s = structuredClone(state);
  const r = handle(s, event || {}, now, ctx);
  if (r === null) return { state, effects: [] };
  if (typeof r === 'string') return { state, effects: [{ type: 'error', message: r }] };
  if (r && r.type) { const { keep, ...effect } = r; return { state: keep ? s : state, effects: [effect] }; } // keep: effect plus a state change
  return { state: s, effects: [] };
}

// Boot recovery: an in-progress match comes back PAUSED, timers frozen at save time.
function restore(state, savedAt) {
  if (!LEVELS.includes(state.level)) state = { ...state, level: LEVELS[0] }; // saved before the levels were renamed
  if (state.phase === 'LOBBY' || state.phase === 'FINISHED') return state;
  const s = state.phase === 'PAUSED' ? structuredClone(state) : step(state, { type: 'pause' }, savedAt, { config: {} }).state;
  s.restored = true;
  return s;
}

// Per-role view. Only the host sees the correct answer before REVEAL, the log and the queue.
function viewFor(state, role) {
  const { undo, ...v } = structuredClone(state);
  if (role === 'host') return Object.assign(v, { undoCount: undo.length });
  delete v.log;
  delete v.queue;
  const revealed = v.phase === 'REVEAL' || (v.phase === 'PAUSED' && v.pausedPhase === 'REVEAL');
  if (v.current && !revealed) delete v.current.correct;
  return v;
}

module.exports = { step, restore, viewFor, initialState, LEVELS, LEVEL_INFO, DOMAINS, domainOf };
