#!/bin/sh
set -eu

# Real upstream servers bind only inside the build step's private network.
# Exercise proxy and origin authentication, a rejected tunnel, TLS trust, and
# the upstream CVE regression against both library backends shipped at runtime.
for backend in build build-gnutls; do
  log="/out/upstream-$backend.log"
  if ! make -C "/build/curl/source/debian/$backend" test \
    TFLAGS='-a -n 80 83 206 217 300 305 2173' > "$log" 2>&1; then
    cat "$log"
    exit 1
  fi
  cat "$log"
  # The harness can exit zero when a selected case lacks a prerequisite.
  grep -Fqx 'TESTDONE: 7 tests out of 7 reported OK: 100%' "$log"
done
