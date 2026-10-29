'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { step, restore, viewFor, initialState, DOMAINS, domainOf } = require('../game');

const config = {
  questionsPerMatch: 3, buzzWindowSec: 15, answerSec: 10, stealSec: 5, revealSec: 4,
  points: { correct: 10, wrong: -5, stealCorrect: 5, stealWrong: 0 },
  allowSteal: true, lockoutOnWrong: true, suddenDeathQuestions: 1,
  teamNames: { A: 'Team A', B: 'Team B' },
};
const bank = {};
for (let i = 1; i <= 6; i++) bank[`q${i}`] = { id: `q${i}`, category: 'Test', text: `Question ${i}`, options: ['a', 'b', 'c', 'd'], correct: 1 };
const queue = Object.keys(bank);
const T0 = 1_000_000;

// Run a list of events, asserting none produce errors. Returns the final state.
function run(events, { cfg = config, state = initialState(cfg), now = T0 } = {}) {
  const ctx = { config: cfg, bank };
  for (const e of events) {
    const ev = typeof e === 'string' ? { type: e } : e;
    const r = step(state, ev, ev.now ?? now, ctx);
    assert.ok(!r.effects.some((x) => x.type === 'error'), `${ev.type}: ${JSON.stringify(r.effects)}`);
    state = r.state;
  }
  return state;
}
const ev = (s, e, now = T0, cfg = config) => step(s, e, now, { config: cfg, bank });
const start = { type: 'start_match', level: 'novice', queue };
const buzz = (team) => ({ type: 'buzz', team });
const answer = (team, index) => ({ type: 'answer', team, index });
const timeout = (now) => ({ type: 'timeout', now });

test('LOBBY -> start_match -> QUESTION_SHOWN, scores reset, names applied', () => {
  const s = run([{ ...start, names: { A: 'Bits', B: 'Bytes' } }]);
  assert.equal(s.phase, 'QUESTION_SHOWN');
  assert.equal(s.current.id, 'q1');
  assert.equal(s.total, 3);
  assert.deepEqual([s.teams.A.name, s.teams.B.name, s.teams.A.score], ['Bits', 'Bytes', 0]);
  assert.equal(s.current.deadline, null);
});

test('start_match rejects bad level / empty queue / when not in LOBBY', () => {
  const s0 = initialState(config);
  assert.equal(ev(s0, { ...start, level: 'expert' }).effects[0].type, 'error');
  assert.equal(ev(s0, { ...start, queue: [] }).effects[0].type, 'error');
  assert.equal(ev(run([start]), start).effects[0].type, 'error');
});

test('QUESTION_SHOWN -> open_buzz -> BUZZ_OPEN with buzz deadline', () => {
  const s = run([start, 'open_buzz']);
  assert.equal(s.phase, 'BUZZ_OPEN');
  assert.equal(s.current.deadline, T0 + 15000);
});

test('BUZZ_OPEN -> buzz -> LOCKED; near-simultaneous buzzes: exactly one wins', () => {
  const s1 = run([start, 'open_buzz', buzz('B')]);
  assert.equal(s1.phase, 'LOCKED');
  assert.equal(s1.current.buzzedBy, 'B');
  assert.equal(s1.current.deadline, T0 + 10000);
  const r = ev(s1, buzz('A'));
  assert.equal(r.state, s1);
  assert.deepEqual(r.effects, [{ type: 'buzz_rejected' }]);
});

test('buzz after the buzzers closed is ignored without penalty (early buzzes are false starts)', () => {
  const s = run([start, 'open_buzz', buzz('B')]);
  const r = ev(s, buzz('A'));
  assert.equal(r.state, s);
  assert.equal(r.effects[0].type, 'buzz_rejected');
  assert.equal(r.effects[0].reason, undefined);
});

test('BUZZ_OPEN timeout -> REVEAL, no points', () => {
  const s = run([start, 'open_buzz', timeout(T0 + 15000)]);
  assert.equal(s.phase, 'REVEAL');
  assert.deepEqual([s.teams.A.score, s.teams.B.score], [0, 0]);
  assert.equal(s.current.deadline, T0 + 15000 + 4000);
});

test('stale or early timeouts are ignored', () => {
  const s = run([start, 'open_buzz']);
  assert.equal(ev(s, { type: 'timeout' }, T0 + 1000).state, s);
  assert.equal(ev(s, { type: 'timeout', deadline: 123 }, T0 + 20000).state, s);
});

test('LOCKED correct answer -> REVEAL, +correct', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 1)]);
  assert.equal(s.phase, 'REVEAL');
  assert.equal(s.teams.A.score, 10);
  assert.deepEqual(s.current.answered, { team: 'A', index: 1, correct: true });
});

test('only the buzzing team may answer', () => {
  const s = run([start, 'open_buzz', buzz('A')]);
  assert.equal(ev(s, answer('B', 1)).effects[0].type, 'error');
  assert.equal(ev(s, answer('A', 7)).effects[0].type, 'error');
});

test('LOCKED wrong -> STEAL, -wrong, buzzer locked out', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 0)]);
  assert.equal(s.phase, 'STEAL');
  assert.equal(s.teams.A.score, -5);
  assert.deepEqual(s.current.lockedOut, ['A']);
  assert.equal(s.current.buzzedBy, 'B');
  assert.equal(s.current.deadline, T0 + 5000);
});

test('LOCKED wrong -> REVEAL when steal disabled', () => {
  const cfg = { ...config, allowSteal: false };
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 0)], { cfg });
  assert.equal(s.phase, 'REVEAL');
});

test('LOCKED timeout is treated as a wrong answer', () => {
  const s = run([start, 'open_buzz', buzz('A'), timeout(T0 + 10000)]);
  assert.equal(s.phase, 'STEAL');
  assert.equal(s.teams.A.score, -5);
  assert.equal(s.current.answered.index, null);
});

test('STEAL correct -> REVEAL, +stealCorrect', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 0), answer('B', 1)]);
  assert.equal(s.phase, 'REVEAL');
  assert.deepEqual([s.teams.A.score, s.teams.B.score], [-5, 5]);
});

test('STEAL wrong -> REVEAL, stealWrong', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 0), answer('B', 2)]);
  assert.equal(s.phase, 'REVEAL');
  assert.deepEqual([s.teams.A.score, s.teams.B.score], [-5, 0]);
});

test('STEAL: locked-out team cannot answer', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 0)]);
  assert.equal(ev(s, answer('A', 1)).effects[0].type, 'error');
});

test('STEAL timeout -> REVEAL', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 0), timeout(T0 + 5000)]);
  assert.equal(s.phase, 'REVEAL');
  assert.deepEqual([s.teams.A.score, s.teams.B.score], [-5, 0]);
});

test('locked-out team cannot buzz again on the same question', () => {
  const cfg = { ...config, allowSteal: false };
  let s = run([start, 'open_buzz', buzz('A'), answer('A', 0)], { cfg });
  // Hand-build BUZZ_OPEN on the same question with A still locked out.
  s = { ...s, phase: 'BUZZ_OPEN', current: { ...s.current, buzzedBy: null, deadline: T0 + 99999 } };
  assert.equal(ev(s, buzz('A'), T0, cfg).effects[0].type, 'buzz_rejected');
  assert.equal(ev(s, buzz('B'), T0, cfg).state.phase, 'LOCKED');
});

test('REVEAL -> next_question or reveal timeout -> QUESTION_SHOWN', () => {
  const s1 = run([start, 'open_buzz', buzz('A'), answer('A', 1), 'next_question']);
  assert.equal(s1.phase, 'QUESTION_SHOWN');
  assert.equal(s1.current.id, 'q2');
  assert.equal(s1.current.buzzedBy, null);
  const s2 = run([start, 'skip', timeout(T0 + 4000)]);
  assert.equal(s2.phase, 'QUESTION_SHOWN');
  assert.equal(s2.index, 1);
});

test('REVEAL after last question -> FINISHED when scores differ', () => {
  const s = run([start, 'open_buzz', buzz('A'), answer('A', 1), 'next_question', 'skip', 'next_question', 'skip', 'next_question']);
  assert.equal(s.phase, 'FINISHED');
  assert.equal(s.log.at(-1).team, 'A');
});

test('tie -> sudden death -> winner', () => {
  let s = run([start, 'skip', 'next_question', 'skip', 'next_question', 'skip', 'next_question']);
  assert.equal(s.phase, 'QUESTION_SHOWN');
  assert.equal(s.mode, 'suddenDeath');
  assert.equal(s.current.id, 'q4');
  s = run(['skip', 'next_question'], { state: s }); // still tied -> another question
  assert.equal(s.current.id, 'q5');
  s = run(['open_buzz', buzz('B'), answer('B', 1), 'next_question'], { state: s });
  assert.equal(s.phase, 'FINISHED');
  assert.equal(s.teams.B.score, 10);
});

test('tie with no questions left finishes as a tie', () => {
  let s = run([start]);
  for (let i = 0; i < 6; i++) s = run(['skip', 'next_question'], { state: s });
  assert.equal(s.phase, 'FINISHED');
  assert.equal(s.log.at(-1).team, null);
});

test('pause/resume preserves remaining time in LOCKED', () => {
  let s = run([start, 'open_buzz', buzz('A'), { type: 'pause', now: T0 + 4000 }]);
  assert.equal(s.phase, 'PAUSED');
  assert.equal(s.pausedRemainingMs, 6000);
  assert.equal(s.current.deadline, null);
  assert.equal(ev(s, timeout(T0 + 10000)).state, s);
  s = run([{ type: 'resume', now: T0 + 60000 }], { state: s });
  assert.equal(s.phase, 'LOCKED');
  assert.equal(s.current.deadline, T0 + 66000);
});

test('pause works in QUESTION_SHOWN (no timer) and is rejected in LOBBY', () => {
  const s = run([start, 'pause', 'resume']);
  assert.equal(s.phase, 'QUESTION_SHOWN');
  assert.equal(s.current.deadline, null);
  assert.equal(ev(initialState(config), { type: 'pause' }).effects[0].type, 'error');
});

test('override correct/wrong resolves the current answer', () => {
  const s1 = run([start, 'open_buzz', buzz('A'), { type: 'override', result: 'correct' }]);
  assert.equal(s1.phase, 'REVEAL');
  assert.equal(s1.teams.A.score, 10);
  const s2 = run([start, 'open_buzz', buzz('A'), { type: 'override', result: 'wrong' }, { type: 'override', result: 'correct' }]);
  assert.deepEqual([s2.teams.A.score, s2.teams.B.score], [-5, 5]);
});

test('skip jumps to REVEAL with no points', () => {
  const s = run([start, 'open_buzz', buzz('A'), 'skip']);
  assert.equal(s.phase, 'REVEAL');
  assert.equal(s.teams.A.score, 0);
});

test('adjust_score and undo restore score and phase', () => {
  let s = run([start, 'open_buzz', buzz('A'), answer('A', 0), answer('B', 1)]);
  assert.deepEqual([s.teams.A.score, s.teams.B.score, s.phase], [-5, 5, 'REVEAL']);
  s = run([{ type: 'adjust_score', team: 'A', delta: 3 }], { state: s });
  assert.equal(s.teams.A.score, -2);
  s = run(['undo_last'], { state: s });
  assert.deepEqual([s.teams.A.score, s.phase], [-5, 'REVEAL']);
  s = run([{ type: 'undo_last', now: T0 + 1000 }], { state: s });
  assert.deepEqual([s.teams.A.score, s.teams.B.score, s.phase], [-5, 0, 'STEAL']);
  assert.equal(s.current.deadline, T0 + 1000 + 5000);
  s = run(['undo_last'], { state: s });
  assert.deepEqual([s.teams.A.score, s.phase, s.current.buzzedBy, s.current.lockedOut], [0, 'LOCKED', 'A', []]);
  assert.equal(ev(s, { type: 'undo_last' }).effects[0].type, 'error');
  assert.equal(s.log.at(-1).type, 'undo');
});

test('reset returns to LOBBY from any phase, keeping names', () => {
  const s = run([{ ...start, names: { A: 'X' } }, 'open_buzz', buzz('A'), 'reset']);
  assert.equal(s.phase, 'LOBBY');
  assert.equal(s.current, null);
  assert.equal(s.teams.A.name, 'X');
  assert.equal(s.teams.A.score, 0);
});

test('set_names validates input', () => {
  const s = run([{ type: 'set_names', A: 'Alpha', B: 'Beta' }]);
  assert.deepEqual([s.teams.A.name, s.teams.B.name], ['Alpha', 'Beta']);
  assert.equal(ev(s, { type: 'set_names', A: '  ' }).effects[0].type, 'error');
});

test('restore puts an active match into PAUSED, frozen at save time', () => {
  const s = run([start, 'open_buzz', buzz('A')]);
  const r = restore(s, T0 + 3000);
  assert.deepEqual([r.phase, r.pausedPhase, r.pausedRemainingMs, r.restored], ['PAUSED', 'LOCKED', 7000, true]);
  const lobby = initialState(config);
  assert.equal(restore(lobby, T0), lobby);
});

test('viewFor hides correct answer, log and queue from non-host until REVEAL', () => {
  const s = run([start, 'open_buzz']);
  for (const role of ['team:A', 'team:B', 'board']) {
    const v = viewFor(s, role);
    assert.equal('correct' in v.current, false);
    assert.equal(v.log, undefined);
    assert.equal(v.queue, undefined);
    assert.equal(JSON.stringify(v).includes('"correct":1'), false);
  }
  assert.equal(viewFor(s, 'host').current.correct, 1);
  assert.equal(viewFor(s, 'host').undo, undefined);
  assert.equal(viewFor(s, 'host').undoCount, 0);
  const r = run(['skip'], { state: s });
  assert.equal(viewFor(r, 'team:A').current.correct, 1);
});

test('step never mutates the input state', () => {
  const s = run([start, 'open_buzz']);
  const before = JSON.stringify(s);
  ev(s, buzz('A'));
  assert.equal(JSON.stringify(s), before);
});

test('code snippets reach every role; questions without code carry none', () => {
  const codeBank = { ...bank, q1: { ...bank.q1, code: 'print(1 + 1)' } };
  const s = step(initialState(config), start, T0, { config, bank: codeBank }).state;
  assert.equal(s.current.code, 'print(1 + 1)');
  assert.equal(viewFor(s, 'team:A').current.code, 'print(1 + 1)');
  assert.ok(!('code' in run([start]).current));
});

test('every category belongs to exactly one domain', () => {
  const all = DOMAINS.flatMap((d) => d.categories);
  assert.equal(new Set(all).size, all.length);
  assert.equal(domainOf('Compilers'), 'systems');
  assert.equal(domainOf('Fix the bug'), 'code');
  assert.equal(domainOf('Basket weaving'), null);
});

test('false start: buzzing before the buzzers open holds that team back for falseStartSec', () => {
  const cfg = { ...config, falseStartSec: 1.5 };
  let s = run([start], { cfg });
  let r = ev(s, buzz('A'), T0 + 100, cfg);
  assert.equal(r.effects[0].reason, 'false_start');
  s = r.state;
  assert.deepEqual(s.current.falseStart, ['A']);
  assert.equal(ev(s, buzz('A'), T0 + 200, cfg).state, s); // repeat early buzzes change nothing
  s = ev(s, { type: 'open_buzz' }, T0 + 1000, cfg).state;
  r = ev(s, buzz('A'), T0 + 1200, cfg); // inside the penalty window
  assert.equal(r.effects[0].reason, 'false_start');
  assert.equal(r.state.phase, 'BUZZ_OPEN');
  r = ev(s, buzz('A'), T0 + 2600, cfg); // window over
  assert.equal(r.state.phase, 'LOCKED');
  r = ev(s, buzz('B'), T0 + 1001, cfg); // the other team is never held back
  assert.equal(r.state.current.buzzedBy, 'B');
});

test('false start resets on the next question', () => {
  let s = run([start]);
  s = ev(s, buzz('B'), T0).state;
  s = run(['open_buzz', 'skip', 'next_question'], { state: s });
  assert.deepEqual(s.current.falseStart, []);
});
