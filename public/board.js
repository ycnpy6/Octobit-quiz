'use strict';
const { $, esc, LETTERS } = Quiz;
let snap = null;
const tick = Quiz.ticker();
let lastSecs = null; // countdown second last drawn, for the low-time thump

const conn = Quiz.connect('board', (msg) => {
  if (msg.type !== 'state') return;
  const prev = snap;
  snap = msg.snapshot;
  Quiz.transitionSounds(prev, snap);
  showDeltas(prev, snap);
  render();
  moment(prev, snap);
});
Quiz.muteButton();
$('#splash .splash-octo').innerHTML = Quiz.octo({ still: true });
for (const t of ['A', 'B']) $(`#team${t} .mascot`).innerHTML = Quiz.octo();

const name = (t) => esc(snap.teams[t].name);

function banner() {
  const c = snap.current;
  switch (snap.phase) {
    case 'QUESTION_SHOWN': return ['Get ready…', ''];
    case 'BUZZ_OPEN': return ['Buzzers open!', 'go'];
    case 'LOCKED': return [`${name(c.buzzedBy)} buzzed: answering…`, c.buzzedBy];
    case 'STEAL': return [`${name(c.buzzedBy === 'A' ? 'B' : 'A')} missed. ${name(c.buzzedBy)} can steal!`, c.buzzedBy];
    case 'REVEAL': {
      const a = c.answered, ans = `Answer: ${LETTERS[c.correct]}`;
      if (!a) return [`No answer. ${ans}`, ''];
      return a.correct ? [`${name(a.team)}: correct!`, 'go'] : [`${name(a.team)}: wrong. ${ans}`, 'alert'];
    }
  }
  return ['', ''];
}

function render() {
  const s = snap, c = s.current;
  const { A, B } = s.teams;
  for (const t of ['A', 'B']) {
    const el = $(`#team${t}`);
    el.querySelector('.tname').textContent = s.teams[t].name;
    el.querySelector('.score').textContent = s.teams[t].score;
    el.classList.toggle('ahead', s.phase !== 'LOBBY' && s.teams[t].score > s.teams[t === 'A' ? 'B' : 'A'].score);
    el.classList.toggle('active', !!c && ['LOCKED', 'STEAL'].includes(s.phase) && c.buzzedBy === t);
    el.classList.toggle('waiting', !!c && ['LOCKED', 'STEAL'].includes(s.phase) && c.buzzedBy !== t);
  }
  const lv = Quiz.levelInfo(conn.levels, s.level);
  $('#level').innerHTML = `<b>${esc(lv.name)}</b><small>${esc(lv.tagline)}</small>`;
  $('#qnum').textContent = c ? (s.mode === 'suddenDeath' ? 'Sudden death!' : `${s.index + 1} / ${s.total}`) : '';

  const playing = !!c;
  document.body.classList.toggle('playing', playing);
  if (!playing) document.body.classList.remove('has-code');
  for (const id of ['#question', '#banner', '#options']) $(id).classList.toggle('hidden', !playing);
  $('#screen').classList.toggle('hidden', playing);
  $('#paused').classList.toggle('hidden', s.phase !== 'PAUSED');
  $('#confetti').classList.toggle('hidden', s.phase !== 'FINISHED');

  if (playing) {
    $('#cat').textContent = c.category || '';
    $('#qtext').textContent = c.text;
    $('#code').textContent = c.code || '';
    $('#code').classList.toggle('hidden', !c.code);
    $('#question').classList.toggle('has-code', !!c.code);
    document.body.classList.toggle('has-code', !!c.code);
    $('#code').style.setProperty('--lines', c.code ? c.code.split('\n').length : 1);
    const [text, tone] = banner();
    $('#banner').innerHTML = text;
    $('#banner').className = `banner ${tone}`;
    const reveal = 'correct' in c;
    const wrongIdx = c.answered && !c.answered.correct ? c.answered.index : null;
    $('#options').innerHTML = c.options.map((o, i) => {
      const cls = reveal && i === c.correct ? 'correct' : i === wrongIdx ? 'wrong' : reveal ? 'dim' : '';
      return `<div class="option ${cls}" data-i="${i}" style="--i:${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></div>`;
    }).join('');
  } else if (s.phase === 'FINISHED') {
    const tie = A.score === B.score, w = A.score > B.score ? 'A' : 'B';
    $('#screen').className = 'center finished';
    $('#screen').innerHTML = `<div><div class="mascot" style="color:var(--team-${tie ? 'A' : w})">${Quiz.octo({ crown: !tie })}</div>
      <h1 class="display">${tie ? "It's a tie!" : `${name(w)} wins!`}</h1>
      <div class="final"><span>${name('A')}</span><span class="figure" style="color:var(--team-A)">${A.score}</span><span class="muted">to</span><span class="figure" style="color:var(--team-B)">${B.score}</span><span>${name('B')}</span></div></div>`;
    confetti();
  } else {
    $('#screen').className = 'center lobby';
    $('#screen').innerHTML = `<div><div class="mascot bob">${Quiz.octo({ label: 'Octo, the Octobit octopus' })}</div><h1 class="display">Octobit Quiz</h1>
      <div class="vs"><span class="A">${name('A')}</span> <span class="muted">vs</span> <span class="B">${name('B')}</span></div>
      <p class="muted">Waiting for the host to start</p></div>`;
  }
}

// Floating "+10" / "-5" over a team panel whenever its score changes mid-match.
// Restart a one-shot animation class and drop it once it has played.
function replay(el, cls, ms = 1400) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the same class plays again
  el.classList.add(cls);
  clearTimeout(el[`fx_${cls}`]);
  el[`fx_${cls}`] = setTimeout(() => el.classList.remove(cls), ms);
}

function splash(team, words) {
  const el = $('#splash');
  el.classList.remove('A', 'B');
  el.classList.add(team);
  el.querySelector('.splash-text').textContent = `${snap.teams[team].name} ${words}`;
  replay(el, 'show', 1300);
}

// Big moments, played once per state change (prev is null on first load: stay still).
function moment(prev, s) {
  const c = s.current;
  if (!prev || !c) return;
  if (!prev.current || prev.current.id !== c.id) { replay($('#question'), 'enter', 900); replay($('#options'), 'deal', 900); }
  if (prev.phase === s.phase) return;
  const opts = $('#options').children;
  if (s.phase === 'BUZZ_OPEN') replay($('#banner'), 'pop', 500);
  if (s.phase === 'LOCKED') { splash(c.buzzedBy, 'buzzed!'); replay($(`#team${c.buzzedBy}`), 'slam', 600); }
  if (s.phase === 'STEAL') {
    const missed = c.answered;
    if (missed && missed.index != null) replay(opts[missed.index], 'shake', 500);
    if (missed) replay($(`#team${missed.team}`), 'shake', 500);
    splash(c.buzzedBy, 'can steal!');
  }
  if (s.phase === 'REVEAL' && ['LOCKED', 'STEAL'].includes(prev.phase) && c.answered) {
    const a = c.answered;
    replay(opts[c.correct], 'flash', 900);
    if (!a.correct && a.index != null) replay(opts[a.index], 'shake', 500);
    replay($(`#team${a.team}`), a.correct ? 'cheer' : 'shake', 1300);
  }
}

function showDeltas(prev, next) {
  if (!prev || prev.phase === 'LOBBY' || next.phase === 'LOBBY') return;
  for (const t of ['A', 'B']) {
    const d = next.teams[t].score - prev.teams[t].score;
    if (!d) continue;
    const el = document.createElement('div');
    el.className = `delta ${d > 0 ? 'pos' : 'neg'}`;
    el.textContent = d > 0 ? `+${d}` : d;
    $(`#team${t}`).appendChild(el);
    setTimeout(() => el.remove(), 2000);
    replay($(`#team${t} .score`), 'pop', 500);
  }
}

function confetti() {
  const box = $('#confetti');
  if (box.childElementCount) return;
  box.innerHTML = Array.from({ length: 120 }, (_, i) =>
    `<i class="c${i % 4}" style="left:${Math.random() * 100}vw;animation-duration:${3 + Math.random() * 4}s;animation-delay:${-Math.random() * 6}s"></i>`).join('');
}

Quiz.loop(() => {
  const r = $('#ring');
  const timed = snap && snap.current && snap.current.deadline && ['BUZZ_OPEN', 'LOCKED', 'STEAL'].includes(snap.phase);
  r.classList.toggle('hidden', !timed);
  if (!timed) return tick(null);
  const secs = Quiz.ring(r, Quiz.remaining(snap.current.deadline, conn.offset), conn.durations[snap.phase]);
  if (secs !== lastSecs && secs > 0 && secs <= 3) replay(r, 'tick', 450);
  lastSecs = secs;
  tick(secs);
});

$('#fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
