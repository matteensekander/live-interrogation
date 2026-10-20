# Live Interrogation

A real-time, text-only noir deduction game for 3–8 friends. Someone did it. Interrogate the suspect, pin evidence, vote in secret. No webcam, no voice chat, just text and a lot of side-eye.

Runs in a browser (share a link) and as a desktop app (Windows `.exe` installer and Mac `.dmg`).

---

## Quick start: run it locally

Requirements: **Node.js 18 or newer** (https://nodejs.org).

```bash
npm install
npm start
```

Open http://localhost:3000 in one or more browser windows. Each window is a separate player.
Tip: set `PORT=4000 npm start` to use a different port.

To test quickly, run the game on a fast clock: `TIME_SCALE=0.1 npm start` (all timers at 10x speed).

Run the automated test (plays a full 2-round game with 4 simulated players and checks rules, timers, reconnects, and that secrets never leak):

```bash
npm test
```

---

## Deploy the server free on Render

1. Push this folder to a GitHub repo.
2. Go to https://render.com, sign in, click **New > Blueprint**, and select the repo. Render reads `render.yaml` and sets up a free Node web service.
   (Or **New > Web Service**, build command `npm install --omit=dev`, start command `node server/index.js`, plan **Free**.)
3. When it is live you get a URL like `https://live-interrogation.onrender.com`. Anyone can open it in a browser and join with a room code.

Notes on the free plan: the service sleeps after about 15 minutes without traffic. The first visit after a sleep takes ~30 seconds to wake. Rooms are kept in memory, so a redeploy or restart ends any games in progress.

---

## Build the Windows and Mac installers

The desktop app loads the game from a server. Point it at your Render URL first:

1. Edit `electron/config.json`:
   ```json
   { "serverUrl": "https://live-interrogation.onrender.com" }
   ```
   Leave it empty to have the app run its own server on your machine (solo or offline testing).
2. Build:
   ```bash
   npm install
   npm run dist:mac    # -> dist/Live Interrogation-1.0.0.dmg   (run on a Mac)
   npm run dist:win    # -> dist/Live Interrogation Setup 1.0.0.exe (Windows installer)
   ```
   `npm run dist` builds both. Apple's Gatekeeper and Windows SmartScreen will warn about unsigned apps. Friends can click **Open** (Mac: right-click > Open) or **More info > Run anyway** (Windows). Code signing needs paid developer certificates and is not set up here.

To test the desktop app without building: `npm run desktop`.

---

## Sharing with friends

- **Browser (easiest):** send the Render link. Host clicks *Host a new case*, shares the 4-letter code or the invite link, and friends open the link (or type the code) and pick a nickname.
- **Desktop app:** send the `.dmg` (Mac) or `.exe` (Windows) from the `dist/` folder. It connects to the same server, so it can play with browser players.

---

## How to play

1. **Lobby:** the host sets rounds, interrogation time (default 4:00), answer time (default 20s) and the Accomplice twist. Each player picks a character and color. 3–8 players.
2. **Case briefing:** the crime is revealed.
3. **Roles:** one player is the suspect, rotating each round. The suspect is secretly Guilty or Innocent. Detectives get private evidence cards: some real, some red herrings.
4. **Interrogation:** detectives queue questions (max 2 queued). The suspect has a timer to answer. Detectives can follow up on an answer (2 per round) and react 🤨 or ✅.
5. **Deliberation:** 45 seconds in a detectives-only chat. The suspect cannot see it.
6. **Secret vote:** each detective votes Guilty or Innocent. Majority decides, ties count as Innocent.
7. **Reveal:** drumroll, gavel, verdict, the truth, the suspect's card, votes, points, and any flagged contradictions.
8. **Scoreboard**, then the next case. After the last round, the winner screen has **Play again**.

### Scoring
- Suspect Guilty and the group votes Innocent: suspect +3
- Suspect Innocent and the group votes Innocent: suspect +2
- Each detective with a correct vote: +1
- Accomplice (if the twist is on): +3 when the majority verdict is wrong

### Power cards (one random card per player per game, single use)
- **Lawyer Up** (suspect only): skip the question. "My client has no comment."
- **Polygraph** (detective): the next question is a POLYGRAPH yes/no question.
- **Overtime** (anyone): +60 seconds on the interrogation clock.
- **Rapid Fire** (detective): the next 3 answers get 8 seconds.

### Controls
| Key | Action |
|---|---|
| Hold **SPACE** | Reveal your private cards (release to hide) |
| **ENTER** | Send a question, answer, or chat message |
| **G** / **I** | Vote Guilty / Innocent during the vote |
| **M** | Mute / unmute |

Volume slider and mute are in the top-right corner.

---

## Project layout

```
server/
  index.js        entry point (npm start)
  app.js          Express + Socket.io: rooms, routing, what each socket receives
  room.js         all game rules, timers and secrets (server-authoritative)
  constants.js    timings, power cards, avatars, colors
  cases.json      30 scenarios (alibis, cover stories, weak spots, clues)
public/
  index.html, css/style.css, js/app.js (UI), js/sound.js (synthesized audio)
  avatars/*.svg   12 generated noir portraits
scripts/gen-avatars.js   regenerates the portraits (npm run avatars)
test/simulate.js         full-game simulation and privacy audit (npm test)
electron/               desktop wrapper (main.js, config.json)
render.yaml             Render deploy config
```

### How privacy works
The server builds two payloads: a **public state** that goes to everyone in the room, and a **private state** built per player. Roles, evidence, the suspect's card, the weak spot, and the detectives-only chat are only ever put in that player's private payload. The "real clue" flag is never sent until the reveal. `npm test` checks every payload every simulated client receives.

---

## Known limits (honest notes)
- **Polygraph is an honor system.** The game forces a YES/NO answer, but cannot check whether the suspect told the truth.
- **Contradiction highlights are a heuristic.** An answer is flagged if it touches the suspect's weak-spot keywords (guilty suspects only) or states a clock time that is not on their card. It is a hint, not a judge.
- **Reconnects use nickname or a session token.** Anyone who types a disconnected player's nickname can take that seat. Fine for friends; not for strangers.
- **Rooms live in memory.** Restarting the server ends games in progress.
- **Accomplice** also receives the +1 for a correct vote, since they are a detective. Their +3 comes on top when the verdict is wrong.
