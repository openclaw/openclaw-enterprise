#!/bin/sh
set -eu
ulimit -c 0

binary=$1
source_root=$2
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
export NODE_TEST_DIR="$test_root"
export PYTHONDONTWRITEBYTECODE=1
cd "$source_root"
timeout --kill-after=10s 180 python3 -B tools/test.py --shell="$binary" --mode=release --timeout=120 -j2 \
  es-module/test-require-module-worker-termination \
  es-module/test-require-module-twice \
  es-module/test-require-module-defined-esmodule \
  es-module/test-require-module-transpiled \
  es-module/test-require-module-errors \
  es-module/test-require-module-error-catching \
  es-module/test-require-module-tla-instantiation-error
