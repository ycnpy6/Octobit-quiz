'use strict';
// Shared client helpers: reconnecting WebSocket, countdowns, sounds.
window.Quiz = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // connect(role, onMessage) -> { send(msg), offset, durations }. Reconnects with 500 ms -> 3 s backoff.
  // Join form: asks for this screen's 6-digit code (from the host console); the browser keeps it afterwards.
  function joinForm(onCode) {
    const form = document.createElement('form');
    form.className = 'join hidden';
    form.innerHTML = `<div class="join-card"><div class="join-octo"></div><h1 class="display">Join</h1>
      <p class="join-msg"></p>
      <label class="join-label" for="join-code">Code for this screen</label>
      <input id="join-code" class="join-input" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required>
      <button class="btn primary join-btn">Join</button></div>`;
    form.querySelector('.join-octo').innerHTML = octo({ still: true });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = form.querySelector('input').value.replace(/\D/g, '');
      if (code.length === 6) onCode(code);
    });
    document.body.appendChild(form);
    return {
      show(message) {
        form.querySelector('.join-msg').textContent = message;
        form.classList.remove('hidden');
        const input = form.querySelector('input');
        input.value = '';
        input.focus();
      },
      hide() { form.classList.add('hidden'); },
    };
  }

  function connect(role, onMessage) {
    let ws = null, delay = 500, takenOver = false;
    const keyName = `quiz-key:${role}`;
    let key = store.get(keyName);
    let join = null;
    const conn = { offset: 0, durations: {}, levels: [], send: (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } };
    const banner = document.createElement('div');
    banner.className = 'conn-banner';
    document.body.appendChild(banner);
    const setBanner = (text) => { if (text) banner.textContent = text; banner.classList.toggle('show', !!text); };

    function open() {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
      ws.onopen = () => { delay = 500; setBanner(''); ws.send(JSON.stringify({ type: 'hello', role, key: key || undefined })); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.serverNow) conn.offset = msg.serverNow - Date.now();
        if (msg.durations) conn.durations = msg.durations;
        if (msg.levels) conn.levels = msg.levels;
        if (msg.type === 'taken_over') { takenOver = true; setBanner('Taken over by another device. Reload to reclaim this screen.'); }
        if (msg.type === 'auth_failed') {
          takenOver = true; // the server closes this socket: wait for a code instead of retrying
          if (['need_code', 'wrong_code'].includes(msg.reason)) {
            setBanner('');
            join = join || joinForm((code) => { key = code; store.set(keyName, code); join.hide(); takenOver = false; open(); });
            join.show(msg.message);
          } else setBanner(msg.message);
        }
        onMessage(msg);
      };
      ws.onclose = () => {
        if (takenOver) return;
        setBanner('Reconnecting…');
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 3000);
      };
    }
    open();
    return conn;
  }

  // Milliseconds left until a server deadline, corrected for clock offset.
  const remaining = (deadline, offset) => (deadline ? Math.max(0, deadline - (Date.now() + offset)) : 0);

  // Update a .ring element; returns whole seconds left.
  function ring(el, ms, total) {
    const secs = Math.ceil(ms / 1000);
    el.style.setProperty('--frac', total ? Math.min(1, ms / total) : 0);
    el.classList.toggle('low', secs <= 3);
    el.querySelector('span').textContent = secs;
    return secs;
  }

  // ---- sounds ----
  let muted = store.get('quiz-muted') === '1';
  const cache = {};
  function sound(name) {
    if (muted) return;
    const a = cache[name] || (cache[name] = new Audio(`/sounds/${name}.wav`));
    a.currentTime = 0;
    a.play().catch(() => { /* blocked until the page gets a click */ });
  }
  // Mute toggle; fixed bottom-right unless a parent element is given.
  function muteButton(parent) {
    const b = document.createElement('button');
    b.className = 'btn icon-btn';
    const paint = () => { b.textContent = muted ? 'Sound off' : 'Sound on'; b.setAttribute('aria-pressed', String(!muted)); };
    b.onclick = () => { muted = !muted; store.set('quiz-muted', muted ? '1' : '0'); paint(); };
    paint();
    if (parent) b.classList.add('inline');
    (parent || document.body).appendChild(b);
    return b;
  }
  // Sounds for a state change (prev may be null on first load: stay silent).
  function transitionSounds(prev, next) {
    if (!prev || prev.phase === next.phase) return;
    const ans = next.current && next.current.answered;
    if (next.phase === 'LOCKED') sound('buzz');
    else if (next.phase === 'STEAL') sound('wrong');
    else if (next.phase === 'REVEAL' && ans && ['LOCKED', 'STEAL'].includes(prev.phase)) sound(ans.correct ? 'correct' : 'wrong');
    else if (next.phase === 'FINISHED') sound('win');
  }
  // Returns tick(secondsLeft): plays a tick once per second for the last 3 seconds.
  function ticker() {
    let last = null;
    return (secs) => { if (secs !== last && secs > 0 && secs <= 3) sound('tick'); last = secs; };
  }

  // ---- Octo, the Octobit pixel octopus ----
  // 16 x 15 grid. X body, H highlight, E eye, P pupil, M mouth; rows 13-14 are two tentacle frames.
  const OCTO = [
    '.....XXXXXX.....', '...XXXXXXXXXX...', '..XXXXXXXXXXXX..', '.XXHHXXXXXXXXXX.', '.XHXXXXXXXXXXXX.',
    '.XXXXXXXXXXXXXX.', '.XXEEXXXXXXEEXX.', '.XXEPXXXXXXEPXX.', '.XXXXXXMMXXXXXX.', '..XXXXXXXXXXXX..',
    '.XXXXXXXXXXXXXX.', '.XX..XX..XX..XX.', '.XX..XX..XX..XX.',
  ];
  const LEGS = [['XX..XX..XX..XX..', 'X...X...X...X...'], ['..XX..XX..XX..XX', '...X...X...X...X']];
  const CROWN = ['....C..CC..C....', '....CCCCCCCC....', '....CCCCCCCC....'];
  const CLS = { X: '', H: 'hi', E: 'eye', P: 'pupil', M: 'pupil', C: 'crown' };
  // Horizontal runs of one cell type become one rect each.
  const rects = (rows, y0) => rows.map((row, y) => [...row.matchAll(/X+|H+|E+|P+|M+|C+/g)].map(({ 0: run, index: x }) =>
    `<rect x="${x}" y="${y0 + y}" width="${run.length}" height="1"${CLS[run[0]] ? ` class="${CLS[run[0]]}"` : ''}/>`).join('')).join('');
  // octo({ crown, still, label }) -> SVG markup. Body colour comes from CSS 'color'.
  function octo({ crown = false, still = false, label = '' } = {}) {
    const top = crown ? 3 : 0;
    const body = rects(OCTO, top);
    const legs = LEGS.map((f, i) => `<g class="f${i + 1}">${rects(f, top + OCTO.length)}</g>`).join('');
    const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
    return `<svg class="octo${still ? '' : ' wiggle'}" viewBox="0 0 16 ${top + OCTO.length + 2}" fill="currentColor" ${a11y}>${crown ? rects(CROWN, 0) : ''}${body}${legs}</svg>`;
  }

  // Display info for a level key, from the server's list.
  const levelInfo = (levels, key) => levels.find((l) => l.key === key) || { key, name: key || '', tagline: '' };

  // Animation loop that calls fn every frame.
  function loop(fn) { const f = () => { fn(); requestAnimationFrame(f); }; requestAnimationFrame(f); }

  return { $, esc, store, connect, octo, levelInfo, remaining, ring, sound, muteButton, transitionSounds, ticker, loop, LETTERS: ['A', 'B', 'C', 'D'], TIMED: ['BUZZ_OPEN', 'LOCKED', 'STEAL', 'REVEAL'] };
})();
