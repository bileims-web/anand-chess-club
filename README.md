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
| `engines.js` | The four engine workers: Stockfish, Patricia, plus the two ONNX policy nets. |
| `calibrate.html` | Measures what a bot is actually worth, by playing it against Stockfish at known `UCI_Elo`. Not linked from the app. |
| `*.worker.js` | Worker entry points (Stockfish, Patricia, Maia, Anand). |
| `engine/` | The engine builds: Stockfish 18 lite (GPL, `Copying.txt`) and Patricia 5.1 (MIT, `PATRICIA_LICENSE`), both WebAssembly. |
| `patricia/` | How `engine/patricia.*` was built: a patch over Patricia's source, the wasm entry point, and `build.sh`. |
| `headless/` | The same pages under node: the gauntlet that measures a member, a sparring harness that shows how one plays, and a check over the Old Man's book. |

## How the opponents play

Every opponent on the ladder is a policy net asked for one move — no search.
The ladder is Maia 3 conditioned on the level's rating; Anand is a separate
net. (Three members off the ladder are a second engine instead; see the
Patricia three below.) A move is
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

### The Old Man

The third member off the ladder, and the weakest player in the club on
purpose. He is the Master's machinery with the dials pushed past where the
Master stops, the verification thrown out, and one thing neither of the others
has: an opening book. Card 1500, measured 1560.

Weak is the point. A sacrifice you cannot refute is a lecture; the piece he
throws at your king is usually one you may keep, if you find the moves.

**Two margins.** The engine proposes ten lines on **2400 nodes**, and
anything within **150cp** of its best is his, exactly as for the Master. But a move that offers material **at the king** survives out to
**550cp**. That second margin is the whole character: the engine will never
propose Bxh7+ inside a normal margin, because it can count and it has just
counted a bishop, so a member who is meant to play it anyway needs the
candidate kept alive past the point where the engine wrote it off. It is still
a bound — beyond 550 the move is losing by an amount even he can see.
`kingwardFactor` defines "at the king": Chebyshev distance from the square the
piece lands on to the enemy king, a check counting as having landed on him,
and the material offered is discounted by it. A pawn's worth adjacent
qualifies; a rook dropped on a1 does not.

**No verification.** The Master's two-stage test asks whether a sacrifice is
sound against an equal, and every answer it gives makes him stronger and
tamer — it was worth 176 Elo when it landed. The Old Man is the other end of
that trade. Nothing he plays is checked, so a good half of it should not work,
and finding out which half is the game.

**The book.** `SAC_BOOK_LINES` is 73 lines of SAN — the King's Gambit and the
Muzio, the Danish, the Evans, the Fried Liver, the Traxler, the Morra, the
Milner-Barry, and on the black side the Latvian, the Schliemann, the Budapest,
the Benko, From's Gambit and the Albin, down to the Lasker Trap's
under-promotion and one line for the day somebody plays 1.f3 and 2.g4.
Compiled on first use into a map from **position** to move, so transpositions
are free: 1.e4 d5 2.exd5 Nf6 3.d4 Qxd5 4.Nc3 Qa5 finds the move written for
1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 4.d4 Nf6 without either line knowing about the
other. Many lines are marked `side: 'wb'` on purpose — he plays the Muzio and
he accepts the Muzio; a gambit declined is an insult from either chair. Where
several lines leave the same position he samples by weight, and the weights
are combined as a **maximum, never a sum**, or three King's Gambit lines
written out in detail would out-vote the Danish at move two. The book is his
only exemption from the engine: while a line lasts he plays it whatever
Stockfish thinks, which is the point, because Stockfish does not approve of
the Latvian either.

**Tuning him is not tuning the Master.** The Master's note says to move the
node budget and leave the margins alone. That does not transfer, and the
measurements say why: 1200 nodes measured 1395, 2400 measured 1439 — a
doubling bought 44 Elo where it should have bought a class — while narrowing
the ordinary margin from 250 to 150 was worth 121 (1439 to 1560, and the only
run where all four anchors gave an estimate rather than a sweep). A player who
deliberately plays a move 250cp below best is not limited by how far the engine
saw. So **`margin` is his strength knob and `kingMargin` is his style**, and
widening the first is not a shortcut to the second: at 250 he threw material on
15% of his moves instead of 11%, but in smaller pieces, and gave check on 10%
instead of 17%. Ordinary error is not style.

**What he actually did.** Four games against Stockfish 1500 from move one
(`headless/spar.js`, which is what that tool is for): material offered on 11%
of his moves, 6% of them sacrifices aimed at the king worth 3.2 pawns each,
check on 17%, 28ms a move. The Master, for comparison, offers on 4% at 2.5
pawns. He also does not resign and does not accept a draw (`neverResigns`,
`neverDraws`): a man who has just given up a rook for an attack has no
business offering you the game two moves later, and the swindle is the last
thing to go.

### The Patricia three: the Chess Prodigy, the Grand Old Man, Mr.X

Three more members off the ladder, and none of them is a net with a screen.
They are a second engine. [Patricia](https://github.com/Adam-Kulju/Patricia)
(Adam Kulju, MIT) is an engine built to attack: its evaluation is trained to
prefer the sacrifice and the open king, and at full strength it is a 3500 that
plays like nobody since Tal. It also carries its own way of being weaker,
which is the whole reason it is here. `Skill_Level` 1-20 maps to an Elo table
(4 = 1200, 10 = 1800, 17 = 2500; 21 is full strength), and below 21 the
engine runs a five-line search, then spends an accumulating centipawn budget
on deliberately worse moves — reaching for a sacrifice whenever one is within
reach of the budget (`src/human.h` in Patricia's source). So for these three
the weakened `bestmove` is exactly the move we want, which is the opposite of
the Stockfish trap Anand fell into: Patricia's limiter weakens the move it
plays, not a list somebody else reads. `patriciaMove` in `bot.js` asks for it
and plays it. No net, no candidate list, no margins, no book: the personality
is the engine and the dial is the level.

| Member | Card | `Skill_Level` | Nodes |
| --- | --- | --- | --- |
| Chess Prodigy | 1200 | 4 | 8000 |
| Grand Old Man | 1800 | 10 | 20000 |
| Mr.X | 2500 | 17 | 60000 |

**Nodes, not time**, for the reason every other budget in the club is nodes
or depth: a member has to be worth the same on a phone as on the calibrator.
The build is single-threaded and scalar (no SIMD), about 140k nodes a second
on the server, so Mr.X's 60000 is under half a second there and a second or
two on a phone. Patricia's author calibrated the levels at real time
controls, so with a node cap under them the cards are labels until the
gauntlet says otherwise; if one lands far off, move `nodes` first, then the
level.

**The mistake budget accrues across a game** and resets on `ucinewgame`,
which matters for how the page talks to the engine. `bot.js` only ever has a
fen, so `patricia.worker.js` infers a new game — the move number went
backwards, or there are more pieces on the board than last time — and sends
`ucinewgame` itself. There was a second trap of the same shape: the human
mode keys its budget on the game ply, and a bare `position fen` leaves the
ply at the start-position value, so the level never engaged at all. The wasm
build reads the ply off the fen (see `patricia/patch.py`).

**How it was built.** Patricia has no browser build, and it is not quite a
stock compile: its nets go in through `incbin`'s inline assembly, which wasm
does not support, so the patch routes them through the compiler's `#embed`
instead; the search runs on a `std::thread`, so the patch calls it directly;
and the stdin loop becomes `uci_line()`, one line per call, so JavaScript can
feed it. `patricia/build.sh` clones the pinned commit, applies `patch.py`,
adds `patricia_wasm.cpp` (the two exports, `pat_init` and `pat_cmd`) and
compiles with Emscripten; the worker fetches the `.wasm` itself and hands
the bytes over, so the same file loads on GitHub Pages and under
`headless/browser.js`. A search runs to its node limit inside `pat_cmd` and
blocks the worker until it returns, which is why every request carries a
node budget and nothing carries a time.

`BOSSES` in `bot.js` lists the off-ladder members in display order; the app
addresses them by negative index (-1 Anand, -2 the Master, -3 the Old Man,
-4 the Chess Prodigy, -5 the Grand Old Man, -6 Mr.X) so a saved game or a
past-games row can find its opponent again. Append only: those indices are
written into saved games.

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

**Every ladder card is currently an unverified label.** Only the three members
off the ladder have been measured (2026-09-14, and the Old Man 2026-09-15).
`MEASURED` is otherwise empty, and the aggression tilt moved each member's
strength when it landed, so the roster may no longer sit in rating order — The
Ringer at 0.55 is far milder than The Sacker at 0.95 three rungs below it. That
pair is the first thing to check.

### Running the gauntlet

Open `calibrate.html` on a laptop and leave the tab open; it is not linked from
the app. The defaults are 10 games against each of four Stockfish anchors
(1320/1600/1900/2200), which is 40 games per bot and 440 for the whole roster —
start with one or two members rather than "Everyone".

**Anand has his own anchors.** The ladder's stop at 2200 and he would sweep
them, so his gauntlet runs against `ANAND_ANCHORS` (2200/2500/2800/3100 —
Stockfish's `UCI_Elo` tops out at 3190). The cut is by card rating, 2500 and
up, so Mr.X runs against them too; the Master at 2000, the Old Man at 1500,
the Prodigy at 1200 and the Grand Old Man at 1800 use the ladder's. If he lands far from his card, move
`ANAND_NODES` in `bot.js` rather than the card: every doubling of the budget
is worth on the order of a class at these depths.

The Results panel emits a paste-ready `var MEASURED = {…}` block. Paste it over
the one in `bot.js`.

### Why not on the server

Do not run this on the trading host. It is a 1.9GB box that runs six live
trading services, and a full gauntlet is hours of Stockfish search plus a
forward pass of a 46MB net on every ply. Use a laptop's browser, which is what
the page is for.

That is still true of the browser page. What exists instead is `headless/`,
which loads `bot.js`, `engines.js` and the calibrator's own inline script
verbatim into node — the Stockfish build takes a Web Worker shim and
`onnxruntime-node` serves the nets — so the gauntlet can be run on the server
after all, under the trading repo's memory cap and never in market hours:

```
RESEARCH_MEM=800M bash ~/trading/scripts/research.sh \
  node headless/gauntlet.js "Old Man" --games 16 --movetime 50
```

16 games against each of four anchors is about three minutes for a cheap
member and ten for an expensive one. Two more tools sit beside it, because
the gauntlet answers one question only — how strong:

* `headless/spar.js` plays real games **from move one** and annotates every
  move with what it gave away, which is the only way to see a style or an
  opening book at all. The gauntlet starts each game from a few random plies,
  so a book barely appears in it: what it measures is the machinery, and a
  member who opens with a gambit is worth a little less than his card.
* `headless/bookcheck.js` replays every line of the Old Man's book and fails
  on the first illegal move. The book is SAN typed by hand, and a wrong token
  silently truncates its line and every position after it — one did, on the
  first run: `Nxf7` where the f-pawn had already captured on e4 and the square
  was empty.

## Relocking the ladder

`LADDER_EPOCH` in `index.html` is the version of "how the opponents play".
Bump it whenever a change makes them play differently: on the next load the
ladder relocks, the player's rating resets to 1000, and any unfinished game is
dropped, because all three were earned against bots that no longer exist.
