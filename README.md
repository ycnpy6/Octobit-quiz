# Octobit Quiz

The Octobit club's CS quiz buzzer, hosted by Octo the pixel octopus. A quiz buzzer that runs over the local network: two teams, a host console and a projector board. No internet, database or build step. The full spec is in `PLAN.md`.

## Start in 5 minutes

1. Install **Node.js 18+**.
2. In this folder, run `npm install` once. This needs internet. For an offline machine, copy the whole folder including `node_modules/`.
3. Run `npm start`. The console prints the host link and one secret link per device:
   ```
   Host (this computer only): http://localhost:3000/host
   Board:  http://192.168.1.20:3000/board?k=…
   Team A: http://192.168.1.20:3000/team/A?k=…
   Team B: http://192.168.1.20:3000/team/B?k=…
   ```
4. Open the host console on the server computer. Open each device link once on its own device; the host console has the same links with copy buttons. The key is saved in that browser and removed from the address bar. On the projector, click **Fullscreen** (or press F11).
5. On the host, check that the three presence dots are green. Then pick a level, set team names, tick the domains to play and click **Start match**.

## Running a match

| Host action | Button / key |
|---|---|
| Open buzzers after reading the question | **Open buzz** / `Space` |
| Next question (also happens automatically after `revealSec`) | **Next** / `N` |
| Rule the current answer correct / wrong | **Correct** `C` / **Wrong** `W` |
| Pause / resume (timers freeze) | `P` |
| Skip the question (no points) | **Skip** |
| Undo the last scoring event | **Undo last** / `U` |
| Manual score fix | ±1 / ±5 next to each score |
| Back to the lobby | **Reset…** (asks to confirm) |

Teams buzz with the big button, `Space` or `Enter`, and answer by tapping an option or pressing `1`–`4`. The first buzz to reach the server wins. A wrong answer gives the other team a steal. A tie after the last question goes to sudden death.

## Configuration (`config.json`)

| Key | Meaning |
|---|---|
| `port` | HTTP/WebSocket port (default 3000; the `PORT` env var overrides it) |
| `questionsPerMatch` | Regular questions per match |
| `buzzWindowSec`, `answerSec`, `stealSec`, `revealSec` | Timers (fractions allowed) |
| `points` | `correct`, `wrong`, `stealCorrect`, `stealWrong` |
| `allowSteal`, `lockoutOnWrong` | Steal rules |
| `suddenDeathQuestions` | Questions per sudden-death round (0 = a tie stands) |
| `falseStartSec` | How long a team is held back after buzzing before the buzzers opened |
| `hostFromLan` | `false` keeps the host console on the server computer; `true` allows it elsewhere with the host key |
| `tls` | Optional `{ "cert": "cert.pem", "key": "key.pem" }` to serve HTTPS |
| `teamNames` | Default names |

Restart the server after editing the config. Question files are re-read at every **Start match**.

## Questions

Four levels, easiest first: **Novice** (167 questions), **Apprentice** (167), **Wizard** (167) and **Kraken**, the boss level (170). That is enough for 11 matches per level before any question repeats. Each is a file in `questions/` (`novice.json`, `apprentice.json`, `wizard.json`, `kraken.json`):

```json
{ "id": "beg-001", "category": "Algorithms", "text": "…", "options": ["…", "…", "…", "…"], "correct": 0 }
```

Each level has 21 code questions, in three categories: **What does it do?** (read the code and predict the output), **Spot the error** and **Fix the bug**. A code question adds a `code` field with the snippet, using `
` for line breaks. The board, team and host screens show it in a monospace block that shrinks to fit:

```json
{ "id": "beg-059", "category": "Fix the bug", "text": "This should print 1 to 5. What should range(5) become?", "code": "for i in range(5):
    print(i)", "options": ["range(1, 6)", "…", "…", "…"], "correct": 0 }
```

`npm run validate` checks every file. It fails on a wrong option count, `correct` out of range, duplicate ids or texts, empty fields, or a correct-index skew above 40%. It warns about text over 140 characters, code over 12 lines or 60 characters per line, and files with fewer than 30 questions. **The host should read through all questions once before the event.**

**Domains.** Every question's `category` belongs to one of 14 IT domains, listed in `DOMAINS` in `game.js`: algorithms & data structures, programming languages, code reading & debugging, systems programming & OS, computer architecture, networking, databases, web development, cybersecurity, AI & machine learning, software engineering, theory of computation, distributed systems and history of computing. Under **Match setup**, the host ticks the domains for the next match. Each one shows how many questions it has at the chosen level, and the host browser remembers the ticks. When fewer questions are ticked than `questionsPerMatch`, the match is shorter. A new category must first be added to a domain in `DOMAINS`, or `npm run validate` fails.

Every match is shuffled: the question order, and the order of the four options. A new match draws questions that earlier matches at that level haven't used yet. Once a level runs out, it starts over. The server remembers what was played in `history.json`; delete that file to forget.

## Testing

- `npm test` runs the state-machine unit tests (`node:test`).
- `npm run simulate` starts a private server with fast timers and plays a full match with two bot teams. It checks that only one buzz wins, the answer never leaks before REVEAL, scores agree across screens, and the winner is right. Options: `--level wizard`, `--domains code,theory`, `--matches 3`. You can also run it against a live server with `--url ws://<ip>:3000`; it takes over the host and team roles, so close the real tabs first.
- Manual 4-device checklist (PLAN.md §11):
  - Refresh each page mid-question.
  - Kill and restart the server mid-match.
  - Unplug a team PC's Wi-Fi.
  - Open `/team/A` in two tabs.
  - Check the board at 720p and 1080p.
  - Play one full match with volunteers.

## Security and fair play

The server decides everything; screens only show what it sends. On top of that:

- **Host on the server computer only.** `/host` works only from the machine running `npm start`. A player who types the host address on their own computer is refused. (Set `"hostFromLan": true` to allow a host laptop; it then needs the host link with its key, printed in the console.)
- **One secret key per screen.** Board, Team A and Team B each have a random key in their link. Without the right key, a device cannot open that screen. A team cannot take over the other team's buzzer or the projector, and Team A's key does not open Team B. After 5 wrong keys a device is locked out for a minute. The keys are kept in `keys.json` (not in git) so links survive a restart; **New device links** on the host makes fresh ones and disconnects the old links.
- **Answers stay on the host.** Team and board screens never receive the correct answer before the reveal, the question files are not served over HTTP, and the host's own traffic never crosses the network because it runs on localhost. If players can see the host's display, tick **Hide the answer on this screen until the reveal**.
- **False starts.** A buzz sent before the buzzers open (an auto-clicker or a script) holds that team back for `falseStartSec` (1.5 s) once they open. The team page never sends early buzzes, so honest players are not affected.
- **Flood limits.** More than 30 messages a second from one socket are dropped, and a socket that keeps flooding is cut off. Messages are capped at 4 KB, one device can hold 6 sockets at most, and sockets that never say who they are are closed after 5 seconds.
- **Locked-down pages.** Every response sends a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`. Only GET and HEAD are accepted, and sockets from another origin are closed.
- `npm run security-check` starts a private server and attacks it the way a player could (wrong keys, host from the LAN, floods, false starts, file access). All 20 checks should pass.

### Network checklist for the event

1. **Use a router just for the quiz** with a strong WPA2/WPA3 password, and connect only the four event computers. Do not let players join it with their phones or laptops. If the router allows it, add a MAC allow-list or give the four computers fixed DHCP reservations. Turn off WPS and change the router's admin password.
2. **Wire the team computers with Ethernet** if you can. Wi-Fi delay is the main unfairness left, because the buzz that reaches the server first wins.
3. **Only allow the quiz port from the local subnet.** On Windows, as admin:
   ```
   netsh advfirewall firewall add rule name="Octobit Quiz" dir=in action=allow protocol=TCP localport=3000 remoteip=localsubnet profile=private
   ```
   Set the router's network to **Private** in Windows, and leave client or AP isolation off.
4. **Use the event computers, not players' own machines,** for the team screens, and keep the host computer and its console out of players' reach.
5. **Optional: HTTPS.** Without it, someone on the same Wi-Fi could read a team's link key off the network. Make a certificate once (Git Bash has openssl):
   ```
   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=octobit-quiz"
   ```
   Then add `"tls": { "cert": "cert.pem", "key": "key.pem" }` to `config.json` and restart. The links become `https://`. Each browser warns once about the self-signed certificate; accept it on each event computer before the event.

## Troubleshooting

- **A screen says "This screen needs its link from the host console".** It was opened without its key, or the links were renewed. Copy that device's link from the host console and open it on the device.
- **A team screen says "False start!".** That team buzzed before the buzzers opened. It is held back for 1.5 s when they open.
- **Other devices can't connect.** Allow Node through the firewall. On Windows, as admin: `netsh advfirewall firewall add rule name="Quiz" dir=in action=allow protocol=TCP localport=3000`. Also check that all devices are on the same network and that the router has no "client/AP isolation". A phone hotspot works as a fallback.
- **"Port 3000 is already in use".** The quiz is probably already running. Stop it, or use another port: `$env:PORT=3001; npm start` (PowerShell) or `PORT=3001 npm start` (macOS/Linux).
- **A page says "Taken over by another device".** Another browser opened the same role, and the newest one wins. Reload on the device you want to keep.
- **"Reconnecting…" banner.** The page retries every 0.5–3 s and keeps showing the last state. Check the network and that the server is running.
- **No sound on the board.** Browsers block audio until the page gets a click. Click the ⛶ or 🔊 button once. 🔊 also mutes.
- **Server crashed mid-match.** Run `npm start` again. The match comes back paused with the same scores, and the host shows "Match restored". Press Resume.
- **Start from a clean slate.** Press Reset on the host, or stop the server and delete `state.json` (and `history.json` to replay questions).

## Files

`server.js` serves HTTP, WebSocket, timers and persistence. The look is an arcade cabinet: `public/tokens.css` holds the colours, fonts and spacing (team A is ember, team B is acid), `common.css` holds the shared parts, and `Quiz.octo()` in `common.js` draws Octo as a pixel sprite. The fonts (Bungee, Chivo, Silkscreen; SIL Open Font License) are bundled in `public/fonts/`, so nothing loads from the internet. `game.js` is the pure state machine. `public/` holds the pages. `scripts/` holds the validator and simulator. `test/` holds the unit tests. Sounds are small generated WAV files in `public/sounds/`.

## Decisions on ambiguous points

- The app lives in this folder rather than a `quiz-app/` subfolder.
- The spec's three levels were renamed and a fourth added: novice, apprentice, wizard and kraken. Display names live in `game.LEVEL_INFO` and go to clients with every `state` message (`levels`). A saved state with an old level name restores as novice.
- Domain filtering happens in `server.js` before it builds the queue, so `game.js` is unchanged. `start_match` takes an optional `domains` list; leaving it out means every domain.
- Randomness stays in `server.js`: it shuffles each question's options when it loads the files, and builds the queue with unplayed questions first (`history.json`).
- `game.step(state, event, now, ctx)` takes `ctx = { config, bank }`. The server shuffles the queue and passes it in `start_match`, so `game.js` stays deterministic.
- State adds these fields:
  - `total`: regular questions in the match.
  - `pausedPhase`: the phase to resume into.
  - `restored`: makes the host show its banner.
  - `undo`: snapshots taken before each scoring event. Clients never receive it; the host only gets `undoCount`.
  - `category` on the current question.
- Besides the spec's fields, the `state` message includes `durations` (full length of each timed phase) so clients can draw countdown rings. The host snapshot also includes `presence` and `urls`.
- In STEAL, `current.buzzedBy` is the stealing team, and the team that answered wrong is in `lockedOut`.
- Any buzz that doesn't win gets `buzz_rejected`, with no penalty.
- `override` works in LOCKED and STEAL only. To change a result after REVEAL, use Undo (back to before the answer) and then Override, or adjust the score.
- Undo restores the snapshot taken before the last scoring event: an answer, override, answer timeout or manual adjustment. It includes the phase, and a running timer gets back the time it had left.
- `suddenDeathQuestions` is the number of questions per sudden-death round, and scores are checked after each round. If it is 0, or the bank runs out, the match ends as a tie.
- Reset keeps the team names and level. The host edits them before the next match.
- On restart, timers freeze at the moment of the last save, so time while the server was down doesn't count.
- Team pages hide the correct answer, the event log and the question queue until REVEAL. The board shows the correct letter in its banner on REVEAL.
- The server pings each socket every 5 s and drops dead ones, so presence dots go red when a device disappears.
- Anti-cheat additions beyond the spec: device keys in links (`keys.json`), host limited to the server computer (`hostFromLan`), a false-start penalty (`falseStartSec`), per-socket rate limits, security headers and optional TLS (`tls`). A false start is the one buzz outside BUZZ_OPEN that changes state: it adds the team to `current.falseStart`.
- Extra host shortcuts beyond the spec: `P` (pause/resume) and `U` (undo).
- The mute and fullscreen controls are text buttons ("Sound on", "Fullscreen"). On the board they fade out during a question and come back on hover.
- Sounds are WAV rather than mp3/ogg, so they could be generated without extra tools.
- Env overrides for testing: `PORT`, `CONFIG` (path to a config file), `STATE_FILE`.
