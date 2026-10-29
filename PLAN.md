# CS Quiz Buzzer: Project Plan

Local-network quiz game for a university event. Two teams of 3 compete head-to-head at the same level (beginner / intermediate / advanced). Computer science questions, 4 options, 1 correct. Teams buzz in on their own computers; a projector shows the leaderboard; the host controls the match.

**Constraints:** runs fully offline on a LAN, no database, no build step, no frameworks, must survive page refreshes and a server restart mid-match.

---

## 1. Devices and roles

| Device | URL | Role |
|---|---|---|
| Host computer (also runs the server) | `http://<LAN-IP>:3000/host` | Controls match, sees the correct answer |
| Projector computer | `/board` | Leaderboard, question, timer (read-only) |
| Team A computer | `/team/A` | Question, buzzer, 4 answers |
| Team B computer | `/team/B` | Same as A |

Only one connection per role is active. If a second client claims the same role, the newest wins and the old one is shown "Taken over by another device".

Team clients never receive the correct answer before REVEAL. Only `host` receives it.

---

## 2. Tech stack and file structure

Node.js 18+, one dependency: `ws`.

```
quiz-app/
├─ server.js              # HTTP static + WebSocket + wiring
├─ game.js                # pure state machine (no I/O), unit-testable
├─ config.json            # scoring, timers, port
├─ state.json             # auto-saved match state (gitignored)
├─ questions/
│  ├─ beginner.json
│  ├─ intermediate.json
│  └─ advanced.json
├─ public/
│  ├─ common.js           # reconnecting WS client, helpers
│  ├─ common.css          # shared tokens, buttons
│  ├─ team.html  team.js
│  ├─ board.html board.js
│  ├─ host.html  host.js
│  └─ sounds/             # buzz, correct, wrong, tick, win (small mp3/ogg)
├─ scripts/
│  ├─ validate-questions.js
│  └─ simulate.js         # fake clients for load/logic testing
├─ test/game.test.js      # node:test, state machine cases
├─ README.md
└─ PLAN.md
```

Keep `game.js` free of timers and sockets: it takes `(state, event, now)` and returns `{state, effects}`. `server.js` owns timers and broadcasts. This makes the rules testable without a network.

---

## 3. Configuration (`config.json`)

```json
{
  "port": 3000,
  "questionsPerMatch": 15,
  "buzzWindowSec": 15,
  "answerSec": 10,
  "stealSec": 5,
  "revealSec": 4,
  "points": { "correct": 10, "wrong": -5, "stealCorrect": 5, "stealWrong": 0 },
  "allowSteal": true,
  "lockoutOnWrong": true,
  "suddenDeathQuestions": 1,
  "teamNames": { "A": "Team A", "B": "Team B" }
}
```

Host can edit team names and level at the start of a match from the host console.

---

## 4. State model

```js
{
  version: 1,
  phase: "LOBBY|QUESTION_SHOWN|BUZZ_OPEN|LOCKED|STEAL|REVEAL|PAUSED|FINISHED",
  level: "beginner|intermediate|advanced",
  teams: { A: {name, score}, B: {name, score} },
  queue: [questionIds],          // shuffled at match start
  index: 0,                      // current question position
  mode: "normal|suddenDeath",
  current: {
    id, text, options: [4], correct,   // correct stripped for non-host
    buzzedBy: null|"A"|"B",
    lockedOut: ["A"],                  // teams barred for this question
    answered: null|{team, index, correct},
    deadline: epochMs|null             // for the active timer
  },
  pausedRemainingMs: null,
  log: [{t, type, team, detail}]       // last ~50 events for host
}
```

Server sends a **full snapshot** on every change. Each role gets a filtered view (`correct` removed for non-host until REVEAL). Timers are sent as an absolute `deadline` plus `serverNow` so clients render countdowns without drift.

---

## 5. State machine

| From | Event | To | Notes |
|---|---|---|---|
| LOBBY | `start_match` | QUESTION_SHOWN | build queue, reset scores |
| QUESTION_SHOWN | `open_buzz` | BUZZ_OPEN | starts `buzzWindowSec` timer; host-controlled so question can be read aloud first |
| BUZZ_OPEN | `buzz` (team) | LOCKED | first valid buzz wins; starts `answerSec` |
| BUZZ_OPEN | timer expires | REVEAL | no points, question skipped |
| LOCKED | `answer` correct | REVEAL | +correct points |
| LOCKED | `answer` wrong | STEAL (if allowed and other team not locked out) else REVEAL | -wrong points, buzzing team locked out |
| LOCKED | timer expires | treated as wrong answer | |
| STEAL | `answer` from other team | REVEAL | +stealCorrect or stealWrong |
| STEAL | timer expires | REVEAL | |
| REVEAL | `next_question` or auto after `revealSec` | QUESTION_SHOWN or FINISHED | |
| any active | `pause` / `resume` | PAUSED / previous | store remaining ms |
| any | `reset` | LOBBY | confirm on host UI |

Tie after last question → `mode: suddenDeath`, ask one more question at a time until scores differ.

### Buzz arbitration

- Server processes WebSocket messages sequentially; the first `buzz` received in `BUZZ_OPEN` wins. Later buzzes get `{type:"buzz_rejected"}`.
- A buzz outside `BUZZ_OPEN` is ignored (no penalty, no early-buzz lockout by default).
- Optional config `earlyBuzzPenaltyMs` is out of scope for v1.

### Host overrides

- `override {result: "correct"|"wrong"}` resolves the current answer manually (for disputed questions).
- `adjust_score {team, delta}` for manual corrections.
- `skip` jumps to REVEAL with no points, `undo_last` reverts the last scoring event using the `log`.

---

## 6. WebSocket protocol

Messages are JSON `{type, ...}`.

**Client → server**
- `hello {role: "team:A"|"team:B"|"board"|"host"}`
- `buzz`
- `answer {index: 0-3}`
- host only: `start_match {level, names?}`, `open_buzz`, `next_question`, `override {result}`, `skip`, `pause`, `resume`, `adjust_score {team, delta}`, `undo_last`, `reset`, `set_names {A, B}`

**Server → client**
- `state {snapshot, serverNow, you: role}` on every change and on connect
- `buzz_rejected`, `error {message}`, `taken_over`
- `presence {A: bool, B: bool, board: bool}` (also inside snapshot for the host)

Server validates role permissions on every message (a team client sending a host event is dropped).

---

## 7. Persistence and recovery

- After every state change, write `state.json` atomically (write temp file, rename).
- On boot, if `state.json` exists and phase is not LOBBY/FINISHED, restore it into `PAUSED` and show "Match restored, press Resume" on the host.
- Clients auto-reconnect with exponential backoff (500 ms → 3 s cap) and re-send `hello`. UI shows a "Reconnecting…" banner but keeps the last known state.

---

## 8. Screens

### Team (`/team/A|B`)
- Header: team name, own score vs opponent score.
- Question text (large), 4 answer buttons colored A/B/C/D with labels.
- Big BUZZ button, active only in BUZZ_OPEN. Space bar and Enter also buzz. Touch-friendly.
- After buzz: if this team won, answers unlock with a countdown ring; otherwise show "Team X is answering".
- Answer buttons disabled for the non-answering team; correct/wrong colors on REVEAL.
- Sound on buzz, correct, wrong, last 3 seconds tick (mute toggle).

### Board (`/board`)
- Two large score panels with team names, leading team highlighted.
- Question number "7 / 15", level badge, current question and 4 options.
- Center banner: who buzzed, countdown, steal status.
- REVEAL: correct option highlighted, points delta animation.
- FINISHED: winner screen, final scores, confetti (CSS only).
- 16:9 layout, readable from the back of the room (question text ≥ 48 px at 1080p), high contrast, no scrolling.

### Host (`/host`)
- Top: connection indicators for A, B, board.
- Current question with the correct option highlighted, plus category and id.
- Buttons: Start match (level select, team names), Open buzz, Next, Skip, Pause/Resume, Override correct/wrong, Undo last, Reset (with confirm).
- Score adjust (+/- per team), event log (last 20 events).
- Shows server LAN URLs for the other devices with a copy button.
- Keyboard shortcuts: Space = open buzz, N = next, C/W = override correct/wrong.

---

## 9. Question bank

Format:
```json
{ "id": "beg-001", "category": "Networks", "text": "…", "options": ["…","…","…","…"], "correct": 2 }
```

- 30+ questions per level (15 used per match, buffer for tiebreakers and a second event).
- Categories to cover: algorithms and complexity, data structures, programming basics, OS, networks, databases/SQL, web, security, software engineering, AI/ML basics, computer architecture, history.
- Beginner: definitions and basic concepts. Intermediate: reasoning and short code output. Advanced: complexity analysis, concurrency, internals, tricky edge cases.
- Rules: exactly 4 distinct options, balanced distribution of correct index (≈25% each), no "all of the above", text under ~140 chars for projector readability.
- `validate-questions.js` fails on: wrong option count, `correct` out of range, duplicate ids/texts, empty fields, correct-index skew > 40%.
- The host should review all questions once before the event.

---

## 10. Build steps

Each step ends with a runnable, tested state. Commit after each.

1. **Skeleton:** `npm init`, install `ws`, serve `public/` statically, WebSocket server, `hello` role registration, presence tracking, `state` broadcast of a stub state. Print LAN URLs on boot.
2. **Game core:** `game.js` with state, transitions, buzz arbitration, scoring, steal, lockout. `test/game.test.js` covering every row of the transition table.
3. **Timers and wiring:** `server.js` timers (buzz window, answer, steal, reveal), pause/resume, `deadline` in state, per-role snapshot filtering.
4. **Persistence:** atomic `state.json`, restore into PAUSED on boot, sudden death.
5. **Team page:** layout, buzz, answers, countdown ring, reconnect banner, sounds.
6. **Board page:** scores, question, banners, reveal animation, winner screen.
7. **Host console:** all controls, log, overrides, undo, shortcuts, URLs panel.
8. **Question bank:** write 3 × 30+ questions, `validate-questions.js`.
9. **Simulation and LAN test:** `scripts/simulate.js` runs two bot teams through a full match; then test on 4 real devices (see checklist).
10. **Polish and docs:** sounds, animations, fullscreen button, favicon, `README.md` with start-up and troubleshooting.

---

## 11. Test checklist

**Logic (automated)**
- Both teams buzz at nearly the same time: exactly one wins.
- Wrong answer → steal → correct/wrong/timeout paths.
- Locked-out team cannot buzz again on the same question.
- Timeout in each phase.
- Pause during LOCKED preserves remaining time.
- Tie → sudden death → winner.
- Undo restores score and phase.

**Manual (4 real devices)**
- Refresh each device mid-question: state restored, timers correct.
- Kill and restart the server mid-match: resumes as PAUSED with correct scores.
- Unplug and replug a team computer's Wi-Fi: banner appears, recovers.
- Two tabs claiming `team:A`: newest wins, old shows taken-over message.
- Projector at 1080p and 720p: no overflow, readable from 8 m.
- Team computers cannot see the correct answer in page source or WS traffic before REVEAL.
- A full 15-question match with 6 volunteers, timing noted.

---

## 12. Event-day runbook

1. Connect all 4 computers to the same network (router or phone hotspot, no client isolation).
2. On the host: `cd quiz-app && npm start`, note the printed LAN IP.
3. Allow Node through the firewall (port 3000).
4. Open `/board` on the projector (F11 fullscreen), `/team/A` and `/team/B` on the team computers, `/host` on the host.
5. Check the 3 green presence dots on the host console.
6. Pick level, set team names, Start match.
7. After the match, `Reset` and repeat for the next level pair.
8. Backup: keep a phone hotspot ready and the question JSON on a USB stick.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wi-Fi isolation blocks devices | Use a router with a wired host, or a phone hotspot; test beforehand |
| Server crash | Persistent `state.json`, restore into PAUSED |
| Disputed answers | Host override and undo |
| Unfair buzz timing | Server-side arbitration, wired connection for the team computers if possible |
| Bad/ambiguous questions | Validator plus manual review; host can skip |
| Projector unreadable | Large fonts, high contrast, tested at low resolution |

---

## 14. Out of scope (v1)

Accounts/login, internet play, more than two teams, tournament brackets, question editor UI, analytics, mobile layout polish.

## 15. Definition of done

- A full match runs end to end on 4 devices over LAN without internet.
- Refreshing any page or restarting the server mid-match does not lose the game.
- Host can override, skip, undo and adjust scores.
- `npm test` passes and the question validator passes for all 3 levels.
- README lets someone else start the app in under 5 minutes.
