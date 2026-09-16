#!/bin/bash
# Build engine/patricia.js + engine/patricia.wasm from Patricia's source.
#
#   bash patricia/build.sh              # clones the pinned commit into /tmp
#   bash patricia/build.sh <checkout>   # uses an existing Patricia checkout
#
# Needs Emscripten on PATH (emsdk: `source ~/emsdk/emsdk_env.sh`), 6.x or
# later — the nets go in through clang's #embed. On the trading host run it
# under the memory cap:
#   RESEARCH_MEM=1300M bash ~/trading/scripts/research.sh bash patricia/build.sh
#
# The build is single-threaded and scalar (no SIMD): 140k nodes/s on the
# server, which at the budgets in bot.js is well under half a second a move.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
PATRICIA_REPO=https://github.com/Adam-Kulju/Patricia.git
PATRICIA_COMMIT=67d83d7056801cfab868872d27b99d192488a316   # Patricia 5.1, 2026-09-16

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(mktemp -d)/Patricia"
  git clone -q "$PATRICIA_REPO" "$SRC"
  git -C "$SRC" checkout -q "$PATRICIA_COMMIT"
fi
ENGINE="$SRC/engine"

python3 "$HERE/patch.py" "$ENGINE"
cp "$HERE/patricia_wasm.cpp" "$ENGINE/src/patricia_wasm.cpp"

cd "$ENGINE"
em++ -O2 -std=c++20 -ffast-math -DPATRICIA_NO_THREADS \
  -Wno-c23-extensions -Wno-deprecated \
  src/patricia_wasm.cpp src/fathom/src/tbprobe.c \
  -sMODULARIZE=1 -sEXPORT_NAME=Patricia -sENVIRONMENT=worker,node \
  -sEXPORTED_FUNCTIONS=_pat_init,_pat_cmd,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToUTF8,lengthBytesUTF8 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=96MB -sSTACK_SIZE=4MB \
  -o "$ROOT/engine/patricia.js"
cp "$SRC/LICENSE" "$ROOT/engine/PATRICIA_LICENSE"
ls -la "$ROOT/engine/patricia.js" "$ROOT/engine/patricia.wasm"
