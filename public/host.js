'use strict';
const { $, esc, LETTERS } = Quiz;
let snap = null;
let toastTimer = null;
let urlsKey = '';
// Hide the correct answer on this screen until the reveal, for when players can see the host's display.
let hideAnswer = Quiz.store.get('quiz-hide-answer') === '1';
// Ticked domains, remembered on this host browser. null = every domain.
let picked = null;
try { picked = JSON.parse(Quiz.store.get('quiz-domains')); } catch { /* none saved */ }

const conn = Quiz.connect('host', (msg) => {
  if (msg.type === 'state') { snap = msg.snapshot; levels(msg.levels || []); render(); }
  else if (msg.type === 'error') toast(msg.message);
});

const send = (type, extra = {}) => conn.send({ type, ...extra });
$('#mascot').innerHTML = Quiz.octo({ still: true });
const name = (t) => esc(snap.teams[t].name);

// Fill the level picker once from the server's list.
function levels(list) {
  const sel = $('#level');
  if (sel.options.length || !list.length) return;
  sel.innerHTML = list.map((l) => `<option value="${l.key}">${esc(l.name)} (${esc(l.tagline)})</option>`).join('');
}

// Build the domain checklist once, then keep counts and ticks current.
function domains(s) {
  const list = s.domains || [];
  const box = $('#domainList');
  if (!box.childElementCount && list.length) {
    box.innerHTML = list.map((d) => `<label class="check"><input type="checkbox" value="${d.key}"><span class="dn">${esc(d.name)}</span><span class="n"></span></label>`).join('');
  }
  const lobby = s.phase === 'LOBBY';
  const counts = (s.counts || {})[$('#level').value || s.level] || {};
  let total = 0;
  box.querySelectorAll('input').forEach((input) => {
    const n = counts[input.value] || 0;
    input.checked = !picked || picked.includes(input.value);
    input.disabled = !lobby;
    input.parentElement.classList.toggle('empty', !n);
    input.parentElement.querySelector('.n').textContent = n;
    if (input.checked) total += n;
  });
  const per = s.perMatch || 15;
  const sum = $('#domainSum');
  sum.textContent = !total ? 'Nothing ticked at this level.' : total < per ? `${total} questions ticked, so the match will be ${total} questions.` : `${total} questions ticked. A match uses ${per}.`;
  sum.classList.toggle('warn', total < per);
  $('#start').disabled = !lobby || !total;
}
const tickedDomains = () => [...document.querySelectorAll('#domainList input:checked')].map((i) => i.value);
function setPicked(keys) {
  picked = keys;
  Quiz.store.set('quiz-domains', JSON.stringify(keys));
  if (snap) domains(snap);
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function questionStatus() {
  const c = snap.current, a = c.answered;
  switch (snap.phase === 'PAUSED' ? snap.pausedPhase : snap.phase) {
    case 'QUESTION_SHOWN': return 'Read the question aloud, then open the buzzers.';
    case 'BUZZ_OPEN': return 'Buzzers open…';
    case 'LOCKED': return `${name(c.buzzedBy)} is answering.`;
    case 'STEAL': return `${name(c.buzzedBy === 'A' ? 'B' : 'A')} missed. ${name(c.buzzedBy)} may steal.`;
    case 'REVEAL':
      if (!a) return 'No answer.';
      return `${name(a.team)} ${a.correct ? 'answered correctly' : 'was wrong'}${a.index == null ? '' : ` (${LETTERS[a.index]})`}${a.steal ? ' on the steal' : ''}.`;
  }
  return '';
}

function render() {
  const s = snap, c = s.current, p = s.presence || {};
  $('#presence').innerHTML = [['A', name('A')], ['B', name('B')], ['board', 'Board']]
    .map(([k, label]) => `<span title="${p[k] ? 'Connected' : 'Not connected'}"><span class="dot ${p[k] ? 'on' : ''}"></span> ${label}</span>`).join('');
  $('#phase').textContent = s.phase === 'PAUSED' ? `PAUSED (${s.pausedPhase})` : s.phase;
  $('#phase').className = `phase ${s.phase}`;
  $('#restored').classList.toggle('hidden', !s.restored);

  // Setup: editable in the lobby; names can be saved any time. Don't clobber fields being typed in.
  const lobby = s.phase === 'LOBBY';
  $('#level').disabled = !lobby;
  if (document.activeElement !== $('#level')) $('#level').value = s.level;
  for (const t of ['A', 'B']) if (document.activeElement !== $(`#name${t}`)) $(`#name${t}`).value = s.teams[t].name;
  domains(s);

  if (c) {
    const num = s.mode === 'suddenDeath' ? `Sudden death (#${s.index + 1})` : `Question ${s.index + 1} / ${s.total}`;
    $('#qmeta').textContent = `${num}, ${c.category}, ${Quiz.levelInfo(conn.levels, s.level).name} (${c.id})`;
    $('#qtext').textContent = c.text;
    $('#code').textContent = c.code || '';
    $('#code').classList.toggle('hidden', !c.code);
    const wrongIdx = c.answered && !c.answered.correct ? c.answered.index : null;
    const showAnswer = !hideAnswer || ['REVEAL'].includes(s.phase === 'PAUSED' ? s.pausedPhase : s.phase);
    $('#options').innerHTML = c.options.map((o, i) =>
      `<div class="option ${showAnswer && i === c.correct ? 'correct' : i === wrongIdx ? 'wrong' : ''}" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></div>`).join('');
    $('#qstatus').innerHTML = questionStatus();
  } else {
    $('#qmeta').textContent = '';
    $('#code').classList.add('hidden');
    $('#qtext').textContent = s.phase === 'FINISHED' ? finalText() : 'No question yet. Pick a level and start the match.';
    $('#options').innerHTML = '';
    $('#qstatus').textContent = '';
  }

  // Controls enabled by phase (the server validates anyway).
  const ph = s.phase;
  const enable = {
    open_buzz: ph === 'QUESTION_SHOWN', next_question: ph === 'REVEAL',
    override: ph === 'LOCKED' || ph === 'STEAL', skip: ['QUESTION_SHOWN', 'BUZZ_OPEN', 'LOCKED', 'STEAL'].includes(ph),
    undo_last: s.undoCount > 0,
  };
  document.querySelectorAll('[data-cmd]').forEach((b) => { b.disabled = !enable[b.dataset.cmd]; });
  const pause = $('#pause');
  pause.disabled = ['LOBBY', 'FINISHED'].includes(ph);
  pause.innerHTML = `${ph === 'PAUSED' ? 'Resume' : 'Pause'}<kbd>P</kbd>`;
  pause.classList.toggle('primary', ph === 'PAUSED');

  $('#scores').innerHTML = ['A', 'B'].map((t) => `<div class="score-row ${t}"><span class="n">${name(t)}</span>
    ${[-5, -1, 1, 5].map((d) => `<button class="btn" data-team="${t}" data-delta="${d}" ${lobby ? 'disabled' : ''}>${d > 0 ? '+' : ''}${d}</button>`).join('')}
    <span class="s">${s.teams[t].score}</span></div>`).join('');

  // Device links carry each screen's key; only this console ever sees the keys.
  const urls = s.urls || [], k = s.keys || {};
  const linksKey = urls.join() + JSON.stringify(k);
  if (linksKey !== urlsKey) {
    urlsKey = linksKey;
    $('#urls').innerHTML = urls.map((base) => [['Board', '/board', 'board'], ['Team A', '/team/A', 'team:A'], ['Team B', '/team/B', 'team:B']]
      .map(([label, path, role]) => `<div class="url"><span>${label}</span><input readonly value="${esc(`${base}${path}?k=${k[role] || ''}`)}"><button class="btn copy">Copy</button></div>`).join('')).join('<hr>');
  }

  $('#log').innerHTML = (s.log || []).slice(-20).reverse().map((e) => {
    const time = new Date(e.t).toLocaleTimeString([], { hour12: false });
    return `<div><span class="t">${time}</span>${esc(e.type)}${e.team ? `, ${name(e.team)}` : ''}${e.detail != null ? `: ${esc(e.detail)}` : ''}</div>`;
  }).join('');
}

function finalText() {
  const { A, B } = snap.teams;
  if (A.score === B.score) return `Finished: tie ${A.score} : ${B.score}`;
  return `Finished: ${A.score > B.score ? A.name : B.name} wins ${A.score} : ${B.score}`;
}

function togglePause() {
  if (!snap) return;
  if (snap.phase === 'PAUSED') send('resume');
  else if (!['LOBBY', 'FINISHED'].includes(snap.phase)) send('pause');
}

function copy(input) {
  const text = input.value;
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast('Copied'), () => {});
  else { input.select(); document.execCommand('copy'); toast('Copied'); }
}

// ---- events ----
$('#start').addEventListener('click', () => send('start_match', { level: $('#level').value, domains: tickedDomains(), names: { A: $('#nameA').value, B: $('#nameB').value } }));
$('#domainList').addEventListener('change', () => setPicked(tickedDomains()));
$('#allDomains').addEventListener('click', () => setPicked(null));
$('#noDomains').addEventListener('click', () => setPicked([]));
$('#level').addEventListener('change', () => { if (snap) domains(snap); });
$('#saveNames').addEventListener('click', () => send('set_names', { A: $('#nameA').value, B: $('#nameB').value }));
$('#pause').addEventListener('click', togglePause);
$('#hideAnswer').checked = hideAnswer;
$('#hideAnswer').addEventListener('change', (e) => { hideAnswer = e.target.checked; Quiz.store.set('quiz-hide-answer', hideAnswer ? '1' : '0'); if (snap) render(); });
$('#newKeys').addEventListener('click', () => {
  if (confirm('Make new device links? The board and team screens on the old links are disconnected until you open the new ones.')) send('new_keys');
});
$('#reset').addEventListener('click', () => { if (confirm('Reset the match? Scores and progress will be lost.')) send('reset'); });
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () =>
  send(b.dataset.cmd, b.dataset.result ? { result: b.dataset.result } : {})));
$('#scores').addEventListener('click', (e) => {
  const b = e.target.closest('[data-delta]');
  if (b) send('adjust_score', { team: b.dataset.team, delta: Number(b.dataset.delta) });
});
$('#urls').addEventListener('click', (e) => { if (e.target.classList.contains('copy')) copy(e.target.previousElementSibling); });

document.addEventListener('keydown', (e) => {
  if (!snap || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target.matches('input, select, textarea')) return;
  const keys = {
    ' ': () => send('open_buzz'), n: () => send('next_question'), c: () => send('override', { result: 'correct' }),
    w: () => send('override', { result: 'wrong' }), p: togglePause, u: () => send('undo_last'),
  };
  const fn = keys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

Quiz.loop(() => {
  const r = $('#ring');
  const timed = snap && snap.current && snap.current.deadline && Quiz.TIMED.includes(snap.phase);
  r.classList.toggle('hidden', !timed);
  if (timed) Quiz.ring(r, Quiz.remaining(snap.current.deadline, conn.offset), conn.durations[snap.phase]);
});
