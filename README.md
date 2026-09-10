# Anand Chess Club

Website for the Anand Chess Club, hosted on GitHub Pages.

Edit, commit, and push to `main` — GitHub Pages redeploys automatically.
Bump `BUILD` in `index.html` whenever you ship; the page checks it against the
served copy and reloads itself once when it finds it is running a stale build.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app: board, ladder, coach, review. All UI and state. |
| `bot.js` | How an opponent picks a move — sampling knobs, Anand's blunder filter, the roster and its ratings. Shared with the calibrator. |
| `engines.js` | The three engine workers: Stockfish plus the two ONNX policy nets. |
| `calibrate.html` | Measures what a bot is actually worth, by playing it against Stockfish at known `UCI_Elo`. Not linked from the app. |
| `*.worker.js` | Worker entry points (Stockfish, Maia, Anand). |

## How the opponents play

Every opponent is a policy net asked for one move — no search. The ladder is
Maia 3 conditioned on the level's rating; Anand is a separate net. Two things
keep them honest:

- **The tail is cut.** Sampling a policy at T=1 plays its 1.5%-probability
  moves 1.5% of the time, and that tail is where hung pieces live. The ladder
  runs at T=0.7 with top-p 0.92.
- **Anand is screened.** His top few policy moves are checked by Stockfish at
  depth 10, and anything that drops material is discarded. He still picks —
  the engine only holds a veto.

Ladder bots are *not* screened, on purpose. A 1200 hangs pieces; that is what
1200 means.

## Ratings

The number on a card is a label until `calibrate.html` says otherwise. Open it,
run a gauntlet, and paste the result into `MEASURED` in `bot.js`. A measured
rating replaces what is displayed and feeds the Elo maths — never `elo_self`,
which is the knob we ask Maia to play at.

## Relocking the ladder

`LADDER_EPOCH` in `index.html` is the version of "how the opponents play".
Bump it whenever a change makes them play differently: on the next load the
ladder relocks, the player's rating resets to 1000, and any unfinished game is
dropped, because all three were earned against bots that no longer exist.
