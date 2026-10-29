'use strict';
const { $, esc, LETTERS } = Quiz;
const ME = location.pathname.split('/')[2] === 'B' ? 'B' : 'A';
const OTHER = ME === 'A' ? 'B' : 'A';
document.body.style.setProperty('--me', `var(--team-${ME})`);
$('#mascot').innerHTML = Quiz.octo();
$('#slot').textContent = `Team ${ME}`;

let snap = null;          // last snapshot
let buzzedLocal = false;  // pressed buzz, waiting for the server
let picked = null;        // answer index we sent
let toastTimer = null;
const tick = Quiz.ticker();

const conn = Quiz.connect(`team:${ME}`, (msg) => {
  if (msg.type === 'state') {
    const prev = snap;
    snap = msg.snapshot;
    Quiz.transitionSounds(prev, snap);
    const qChanged = !prev || !prev.current || !snap.current || prev.current.id !== snap.current.id;
    if (snap.phase !== 'BUZZ_OPEN') buzzedLocal = false;
    if (qChanged || !['LOCKED', 'STEAL'].includes(snap.phase)) picked = null;
    render();
  } else if (msg.type === 'buzz_rejected') {
    if (msg.reason === 'false_start') toast('False start! Wait for the buzzers to open.');
    else if (buzzedLocal) toast('Too late, the other team was faster');
    buzzedLocal = false;
    render();
  } else if (msg.type === 'error') {
    toast(msg.message);
  }
});
Quiz.muteButton($('header'));

const myTurn = () => snap && ['LOCKED', 'STEAL'].includes(snap.phase) && snap.current.buzzedBy === ME;
const canBuzz = () => snap && snap.phase === 'BUZZ_OPEN' && !snap.current.lockedOut.includes(ME) && !buzzedLocal;

function buzz() {
  if (!canBuzz()) return;
  buzzedLocal = true;
  conn.send({ type: 'buzz' });
  render();
}

function answer(i) {
  if (!myTurn() || picked !== null) return;
  picked = i;
  conn.send({ type: 'answer', index: i });
  render();
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// [message, tone] for the status bar.
function status() {
  const s = snap, c = s.current, them = esc(s.teams[OTHER].name);
  switch (s.phase) {
    case 'LOBBY': return ['Waiting for the host to start the match', 'wait'];
    case 'QUESTION_SHOWN': return ['Listen to the question…', 'wait'];
    case 'BUZZ_OPEN':
      if (c.lockedOut.includes(ME)) return ['Locked out for this question', 'alert'];
      return buzzedLocal ? ['Buzzed!', 'go'] : ['BUZZ NOW!', 'go'];
    case 'LOCKED': return myTurn() ? ['You buzzed first: answer now!', 'go'] : [`${them} is answering`, 'wait'];
    case 'STEAL': return myTurn() ? ['Steal chance: answer now!', 'go'] : [`${them} is trying to steal`, 'wait'];
    case 'REVEAL': {
      const a = c.answered;
      if (!a) return ["Time's up: no answer", 'wait'];
      const who = a.team === ME ? 'You' : esc(s.teams[a.team].name);
      return a.correct ? [`${who}: correct!`, a.team === ME ? 'go' : 'wait'] : [`${who}: wrong`, a.team === ME ? 'alert' : 'wait'];
    }
    case 'PAUSED': return ['Paused', 'wait'];
    case 'FINISHED': {
      const [m, o] = [s.teams[ME].score, s.teams[OTHER].score];
      return m === o ? ["It's a tie!", 'wait'] : m > o ? ['You win!', 'go'] : [`${them} wins`, 'alert'];
    }
  }
  return ['', 'wait'];
}

function render() {
  if (!snap) return;
  const s = snap, c = s.current;
  document.title = `${s.teams[ME].name}: Octobit Quiz`;
  $('#name').textContent = s.teams[ME].name;
  $('#myScore').textContent = s.teams[ME].score;
  $('#theirScore').textContent = `${s.teams[OTHER].name} ${s.teams[OTHER].score}`;
  const [msg, tone] = status();
  $('#msg').innerHTML = msg;
  $('#status').className = `status ${tone}`;

  $('#qbox').classList.toggle('hidden', !c);
  document.body.classList.toggle('has-code', !!(c && c.code));
  $('#options').classList.toggle('hidden', !c);
  if (c) {
    const num = s.mode === 'suddenDeath' ? 'Sudden death' : `Question ${s.index + 1} / ${s.total}`;
    $('#meta').textContent = c.category ? `${num}, ${c.category}` : num;
    $('#question').textContent = c.text;
    $('#code').textContent = c.code || '';
    $('#code').classList.toggle('hidden', !c.code);
    $('#code').style.setProperty('--lines', c.code ? c.code.split('\n').length : 1);
    const reveal = 'correct' in c;
    const wrongIdx = c.answered && !c.answered.correct ? c.answered.index : null;
    const turn = myTurn() && picked === null;
    $('#options').classList.toggle('live', turn);
    $('#options').innerHTML = c.options.map((o, i) => {
      const cls = ['option'];
      if (reveal && i === c.correct) cls.push('correct');
      else if (i === wrongIdx) cls.push('wrong');
      else if (reveal) cls.push('dim');
      if (i === picked) cls.push('picked');
      return `<button class="${cls.join(' ')}" data-i="${i}" ${turn && i !== wrongIdx ? '' : 'disabled'}><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></button>`;
    }).join('');
  }

  const b = $('#buzz');
  b.disabled = !canBuzz();
  b.classList.toggle('live', canBuzz());
  b.textContent = buzzedLocal ? 'BUZZED' : s.phase === 'BUZZ_OPEN' && c.lockedOut.includes(ME) ? 'LOCKED' : 'BUZZ';
}

// Countdown ring + last-3-seconds tick (only when it matters to this team).
Quiz.loop(() => {
  const r = $('#ring');
  const timed = snap && snap.current && snap.current.deadline && ['BUZZ_OPEN', 'LOCKED', 'STEAL'].includes(snap.phase);
  r.classList.toggle('hidden', !timed);
  if (!timed) return tick(null);
  const secs = Quiz.ring(r, Quiz.remaining(snap.current.deadline, conn.offset), conn.durations[snap.phase]);
  tick(canBuzz() || myTurn() ? secs : null);
});

$('#buzz').addEventListener('click', buzz);
$('#options').addEventListener('click', (e) => {
  const btn = e.target.closest('.option');
  if (btn) answer(Number(btn.dataset.i));
});
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); buzz(); }
  else if (/^[1-4]$/.test(e.key)) answer(Number(e.key) - 1);
});
