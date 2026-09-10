# Anand Chess Club

Website for the Anand Chess Club, hosted on GitHub Pages.

Edit, commit, and push to `main` — GitHub Pages redeploys automatically.
Bump `BUILD` in `index.html` whenever you ship; the page checks it against the
served copy and reloads itself once when it finds it is running a stale build.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app: board, ladder, coach, review. All UI and state. |
| `bot.js` | How an opponent picks a move — sampling knobs, the screens, the roster with its ratings, styles and lines. Shared with the calibrator. |
| `engines.js` | The three engine workers: Stockfish plus the two ONNX policy nets. |
| `calibrate.html` | Measures what a bot is actually worth, by playing it against Stockfish at known `UCI_Elo`. Not linked from the app. |
| `*.worker.js` | Worker entry points (Stockfish, Maia, Anand). |

## How the opponents play

Every opponent is a policy net asked for one move — no search. The ladder is
Maia 3 conditioned on the level's rating; Anand is a separate net. A move is
chosen in three steps, all of them in `bot.js`:

1. **The tail is cut.** Sampling a policy at T=1 plays its 1.5%-probability
   moves 1.5% of the time, and that tail is where hung pieces live. The ladder
   runs at T=0.7 with top-p 0.92.
2. **The member's taste tilts what's left.** Each rung has an `aggression`
   between 0 and 1, applied as `exp(k · aggression · score)` over the nucleus,
   where the score rewards captures, checks, promotions, landing next to the
   enemy king, and going forward. It re-ranks the net's own moves; it never
   invents one. A mate inside the nucleus is always taken.
3. **Stockfish holds a veto.** How tight the veto is *is* the ladder —
   `elo_self` alone spans only ~340 Elo between the 700 and 1900 cards, because
   Maia 3 conditions on rating by interpolating two embedding vectors across a
   0–5000 clip. So the leash shortens as you climb: nothing below 1000, then
   depth 6 at 250cp, depth 8 at 120cp, depth 10 at 50cp. The net still picks;
   the engine only refuses. When it does refuse, the move that replaces the
   vetoed one is the sharpest the engine approved, not the most human — rank
   those by policy alone and a member's taste vanishes exactly where the leash
   is tightest, which is the top of the ladder.

That combination is why one aggression knob gives two different opponents. At
700 nothing is screened and the sacrifices are real gifts — a 900 hangs pieces,
that is what 900 means. At 1900 the same taste survives a 50cp leash, so only
the sound attacks get through.

Anand is the exception to all three steps, because for him the order is
reversed. His net is 1.7MB and searches nothing, so asked for a move on its own
it plays club chess with a 2700 on the card, and no amount of screening fixes
that — a veto removes blunders, it does not find plans. So **Stockfish
proposes and his net picks**: the engine returns six moves at `UCI_Elo 2700`,
everything within 60cp of its best goes to his net, and he plays the one *he*
ranks highest. The engine sets the standard, the net keeps the style.

Read the card carefully. His *candidates* are 2700; the pick among them is his
own, so his real strength sits a little under the number. That is what the
60cp margin costs, and why it is tight. If the engine cannot answer he falls
back to his net alone, screened as before — nothing may stop him moving.

`decideMove` in `bot.js` is the only way either page chooses a move. Keep it
that way: the app and the calibrator drifted apart once already, when a rename
left both calling a function that no longer existed.

## Personalities

The ten rungs are club members, not difficulty settings: a name, an
`aggression`, and `lines` they say on their own moves — a greeting, a capture,
a check, a gloat when their own win estimate passes 72%, a mutter when it drops
under 28%, and a parting line on the game card. One line every seven seconds at
most; a line every move is a chat bot you want to mute. All of it lives in
`LEVELS` in `bot.js`, so a new voice is a data edit.

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
