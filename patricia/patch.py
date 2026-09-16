#!/usr/bin/env python3
"""Patch a Patricia checkout for the club's WebAssembly build.

    python3 patricia/patch.py <path to Patricia/engine>

Two edits, both idempotent:

1. src/uci.h — the stdin loop becomes uci_line(), one UCI line per call, so
   JavaScript can feed the engine; run_thread() under PATRICIA_NO_THREADS
   calls the search directly (no pthreads in this build); and `position fen`
   reads the game ply off the fen, because the human mode keys its mistake
   budget on the ply and the page never sends a move list.
2. src/nnue.h — the three nets go in through the compiler's #embed instead
   of incbin's inline assembly, which wasm does not support.
"""
import os
import sys

engine = sys.argv[1] if len(sys.argv) > 1 else '.'


def rewrite(rel, fn):
    p = os.path.join(engine, rel)
    with open(p, newline='') as f:
        s = f.read()
    crlf = '\r\n' in s
    s = s.replace('\r\n', '\n')
    out = fn(s)
    if crlf:
        out = out.replace('\n', '\r\n')
    with open(p, 'w', newline='') as f:
        f.write(out)
    print('patched', rel)


def uci(s):
    if 'uci_line(' in s:
        return s
    old = '''void run_thread(Position &position, ThreadInfo &thread_info, std::thread &s) {

  // This wrapper function allows the user to call the "stop" command to stop
  // the search immediately.
  if (thread_info.is_human) {'''
    new = '''void run_thread(Position &position, ThreadInfo &thread_info, std::thread &s) {

  // This wrapper function allows the user to call the "stop" command to stop
  // the search immediately.
#ifdef PATRICIA_NO_THREADS
  // wasm build: no pthreads, the search runs to its limit on this thread
  if (thread_info.is_human) search_human(position, thread_info);
  else search_position(position, thread_info, TT);
  return;
#endif
  if (thread_info.is_human) {'''
    assert old in s, 'run_thread not found'
    s = s.replace(old, new)

    start = s.index('void uci(ThreadInfo &thread_info, Position &position) {')
    loop = s.index('  while (getline(std::cin, input)) {', start)
    loop_end = s.index('\n', loop) + 1
    head = '''static std::thread s;

// One UCI line. The wasm build feeds lines in from JavaScript one at a time;
// the native binary loops over stdin below.
void uci_line(ThreadInfo &thread_info, Position &position,
              const std::string &input) {
  {
'''
    s = s[:start] + head + s[loop_end:]
    old = '        continue;\n      }\n\n      else if (name == "SyzygyPath")'
    new = '        return;\n      }\n\n      else if (name == "SyzygyPath")'
    assert old in s, 'setoption continue not found'
    s = s.replace(old, new)
    assert s.rstrip().endswith('}\n  }\n}'), s[-40:]
    s = s.rstrip()[:-1].rstrip() + '\n}\n'

    old = '''        set_board(position, thread_info, fen);
      } else {'''
    new = '''        set_board(position, thread_info, fen);
#ifdef PATRICIA_NO_THREADS
        // The wasm build is handed a fen per move and never a move list, so
        // the ply — which the human mode keys its mistake budget on, and
        // which stays at the startpos value otherwise — is read off the fen.
        {
          std::istringstream fr(fen);
          std::string fb, fc, fcast, fep;
          int fhalf = 0, ffull = 1;
          fr >> fb >> fc >> fcast >> fep >> fhalf >> ffull;
          int plies = std::max(0, (ffull - 1) * 2 + (fc == "b" ? 1 : 0));
          thread_info.game_ply = std::min(6 + plies, GameSize - 300);
        }
#endif
      } else {'''
    assert old in s, 'position fen not found'
    s = s.replace(old, new)

    s += '''
void uci(ThreadInfo &thread_info, Position &position) {
  setvbuf(stdin, NULL, _IONBF, 0);
  setvbuf(stdout, NULL, _IONBF, 0);

  printf("Patricia Chess Engine, written by Adam Kulju\\n\\n\\n");

  new_game(thread_info, TT);
  set_board(position, thread_info,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");

  std::string input;
  while (getline(std::cin, input)) uci_line(thread_info, position, input);
}
'''
    return s


def nnue(s):
    if '#embed' in s:
        return s
    old = '''INCBIN(nnue, "nets/fingolfin.nnue");
INCBIN(nnue2, "nets/finarfin.nnue");
INCBIN(nnue3, "nets/feanor.nnue");'''
    new = '''#ifdef __EMSCRIPTEN__
// wasm has no .incbin, so the compiler embeds the nets itself (#embed).
alignas(64) static const unsigned char g_nnueData[] = {
#embed "../nets/fingolfin.nnue"
};
alignas(64) static const unsigned char g_nnue2Data[] = {
#embed "../nets/finarfin.nnue"
};
alignas(64) static const unsigned char g_nnue3Data[] = {
#embed "../nets/feanor.nnue"
};
#else
INCBIN(nnue, "nets/fingolfin.nnue");
INCBIN(nnue2, "nets/finarfin.nnue");
INCBIN(nnue3, "nets/feanor.nnue");
#endif'''
    assert old in s, 'INCBIN lines not found'
    return s.replace(old, new)


rewrite('src/uci.h', uci)
rewrite('src/nnue.h', nnue)
