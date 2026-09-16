// patricia_wasm.cpp — the Patricia engine as a WebAssembly module.
//
// No stdin, no threads: the page calls pat_cmd() with one UCI line at a time
// and the engine answers through stdout, which Emscripten hands to
// Module.print. A `go` runs to its limit before pat_cmd returns, so the
// caller must bound every search with nodes or movetime.
#include "search.h"
#include "uci.h"
#include <emscripten.h>
#include <memory>

static Position position;
static std::unique_ptr<ThreadInfo> thread_info;

extern "C" {

EMSCRIPTEN_KEEPALIVE void pat_init() {
  setvbuf(stdout, NULL, _IONBF, 0);
  init_LMR();
  init_bbs();
  thread_info = std::make_unique<ThreadInfo>();
  new_game(*thread_info, TT);
  set_board(position, *thread_info,
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

EMSCRIPTEN_KEEPALIVE void pat_cmd(const char *line) {
  uci_line(*thread_info, position, std::string(line));
}

}
