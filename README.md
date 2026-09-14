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
proposes and his net picks**: the engine searches six lines on a fixed budget
of `ANAND_NODES` (8000), everything within 40cp of its best goes to his net,
and he plays the one *he* ranks highest. The engine sets the standard, the net
keeps the style.

The budget is nodes, not `UCI_Elo`, and that is not a style choice. Stockfish's
Elo limit weakens only the single `bestmove` it prints at the end; the
`info ... pv` lines are the honest full-strength ranking, and those are what
the proposal reads. He shipped for four days asking for depth 12 at
`UCI_Elo 2700` and got a full-strength depth-12 list — the pv lines were
byte-identical at `UCI_Elo 1320` and `2700`, only `bestmove` moved — which is
engine chess with a 2700 on the card. A node cap weakens every line the same
way. The calibrator's anchor is unaffected: it plays `bestmove`, where the
Elo limit does apply.

Read the card carefully. The pick among the candidates is his own, so his real
strength sits a little under whatever the budget is worth; that is what the
40cp margin costs, and why it is tight. What the budget is worth is for
`calibrate.html` to say, and it has: on 2026-09-14, 16 games per anchor
against 2200/2500/2800/3100, 40000 nodes measured 2894, 20000 also 2894, and
8000 measured 2746, so 8000 it is. If the engine cannot answer he falls back
to his net alone, screened as before — nothing may stop him moving.

`decideMove` in `bot.js` is the only way either page chooses a move. Keep it
that way: the app and the calibrator drifted apart once already, when a rename
left both calling a function that no longer existed.

### The Old School Master

The second member off the ladder, below Anand and never locked. He plays the
way the club wishes it played: every line opened, every piece thrown at the
king, and a sacrifice whenever the defence would take real accuracy.
Stockfish has no style knob and cannot be made to want a sacrifice, so this
is the same machinery as Anand with the dials set the other way, plus a test
Anand does not need.

**Proposal.** The engine proposes eight lines on a budget of 4000 nodes and
everything within 150cp of the best survives. The pick among the survivors
is the ladder's aggression tilt at 1.6 (past the rungs' full scale, because
at 1.0 the net's own ranking still out-voted a sacrifice it rated 4%) plus a
bonus per pawn of material the move puts on offer (`materialOffered`, since
the aggression score alone rewards *taking*, and his first measured game was
a queen grabbing b7 and getting mated for it), over his net's ranking at T=1,
*sampled* rather than taken so the same opening does not give the same game.

**Verification.** A sacrifice must have a plan, and 4000 nodes cannot see
one. But "sound" means sound against the opponent he faces, not against a
3000-rated engine: a sacrifice a grandmaster refutes and a 2000 does not is
the old school's stock in trade, and what makes it so is that the defence
needs accuracy. So each pick goes through `verifyPick`, in two stages. The
engine looks at the opponent's four best replies on 20000 nodes and counts
how many leave him more than 100cp behind its own best from before the move.
None, and the move is simply sound. Two or more, and the defence is easy: the
move is dropped and he picks again. Exactly one, an only-move defence, and
Stockfish plays the reply at `UCI_Elo` equal to his rating three times (the
Elo limiter does apply to `bestmove`, which is what this reads); the move
stands if his equal misses the refutation more often than not. If nothing of
his survives he plays the engine's move.

The 150cp margin is how wide his imagination runs; the 100cp verify margin is
how much an accurate defence may take back; the node budget sets where the
rating lands. Measured 2026-09-14, 16 games per anchor against
1320/1600/1900/2200: 2000 before verification (16, 10.5, 13, 6.5) and 2176
with it (16, 15, 13.5, 9.5), which is what the card now shows. In four games
against The Sniper he offered material on 4% of his moves (2.5 pawns on
average) and gave check on 17%. The style is the point of him: if he ever
needs tuning, move the node budget and leave the margins and the tilt alone.

`BOSSES` in `bot.js` lists the off-ladder members in display order; the app
addresses them by negative index (-1 Anand, -2 the Master) so a saved game
or a past-games row can find its opponent again.

## Personalities

The ten rungs are club members, not difficulty settings: a name, an
`aggression` that shapes how they play, and `lines` that give them a voice.
All of it lives in `LEVELS` in `bot.js`, so a new voice is a data edit.

**Nothing is ever printed above the board.** A speech bubble there was tried
and removed: it sat in normal flow, so every line it showed and hid pushed the
board down and pulled it back, and the board must not move while you are
looking at it. Only the `won`/`lost` lines are used now, on the game card at
the end, where there is nothing to disturb. The other pools are kept for a
surface that can hold them without moving anything — an overlay pinned clear
of the board, or the opponent's name row.

## Ratings

The number on a card is a label until `calibrate.html` says otherwise. Open it,
run a gauntlet, and paste the result into `MEASURED` in `bot.js`. A measured
rating replaces what is displayed and feeds the Elo maths — never `elo_self`,
which is the knob we ask Maia to play at.

**Every ladder card is currently an unverified label.** Only the two members
off the ladder have been measured (2026-09-14). `MEASURED` is otherwise empty, and the
aggression tilt moved each member's strength when it landed, so the roster may
no longer sit in rating order — The Ringer at 0.55 is far milder than The
Sacker at 0.95 three rungs below it. That pair is the first thing to check.

### Running the gauntlet

Open `calibrate.html` on a laptop and leave the tab open; it is not linked from
the app. The defaults are 10 games against each of four Stockfish anchors
(1320/1600/1900/2200), which is 40 games per bot and 440 for the whole roster —
start with one or two members rather than "Everyone".

**Anand has his own anchors.** The ladder's stop at 2200 and he would sweep
them, so his gauntlet runs against `ANAND_ANCHORS` (2200/2500/2800/3100 —
Stockfish's `UCI_Elo` tops out at 3190). If he lands far from his card, move
`ANAND_NODES` in `bot.js` rather than the card: every doubling of the budget
is worth on the order of a class at these depths.

The Results panel emits a paste-ready `var MEASURED = {…}` block. Paste it over
the one in `bot.js`.

### Why not on the server

Do not run this on the trading host. It is a 1.9GB box that runs six live
trading services, and a full gauntlet is hours of Stockfish search plus a
forward pass of a 46MB net on every ply. Use a laptop's browser, which is what
the page is for.

A headless version is possible if this ever needs to be re-run often — the
Stockfish build loads under node with a Web Worker shim, and `onnxruntime-node`
can serve the nets — but it should be scheduled outside market hours, through
`scripts/research.sh` in the trading repo.

## Relocking the ladder

`LADDER_EPOCH` in `index.html` is the version of "how the opponents play".
Bump it whenever a change makes them play differently: on the next load the
ladder relocks, the player's rating resets to 1000, and any unfinished game is
dropped, because all three were earned against bots that no longer exist.
