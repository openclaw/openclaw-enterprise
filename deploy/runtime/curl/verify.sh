#!/bin/sh
set -eu

# Real upstream servers bind only inside the build step's private network.
# These CLI cases need the test servers, not the unrelated libtest programs.
# Cover proxy/origin auth, rejected tunnels, CA/hostname checks, and the CVE.
for backend in build build-gnutls; do
  log="/out/upstream-$backend.log"
  if ! (
    cd "/build/curl/source/debian/$backend/tests" &&
    make -C server -j2 all &&
    perl ./runtests.pl -a -n -v 80 83 206 217 310 311 2173
  ) > "$log" 2>&1; then
    cat "$log"
    exit 1
  fi
  cat "$log"
  # The harness can exit zero when a selected case lacks a prerequisite.
  grep -Fqx 'TESTDONE: 7 tests out of 7 reported OK: 100%' "$log"
done
