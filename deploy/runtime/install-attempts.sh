#!/bin/sh
# Usage: install-attempts.sh <command> [arguments...]
#
# Runs a package install with a time limit on each attempt but the last.
# Since pnpm 12.4 fetchTimeout cuts off only a download that stops making
# progress, so one registry connection trickling at a few KiB/s held an
# OpenClaw install for 14 min against a usual 45 s (finding 1273). A timed-out
# attempt is stopped with its child processes; the next attempt opens fresh
# connections and reuses every package already in the store. The last attempt
# has no limit, so a slow but working link still finishes the build, after
# losing at most two limited attempts. Any other failure ends at once.
set -eu

limit=300
attempts=3

# Remove only node_modules trees the install created.
existing=$(find . -name node_modules -type d -prune -print)

attempt=1
while [ "$attempt" -lt "$attempts" ]; do
  started=$(date +%s)
  status=0
  timeout -k 30 "$limit" "$@" || status=$?
  # 124: the limit stopped it; 137: it ignored TERM and was killed 30 s later.
  # A 137 before the limit (an out-of-memory kill) is a real failure.
  case "$status" in
    0) exit 0 ;;
    124 | 137) [ "$(($(date +%s) - started))" -ge "$limit" ] || exit "$status" ;;
    *) exit "$status" ;;
  esac
  echo "install-attempts: attempt $attempt stopped after ${limit} s (status $status); retrying with fresh connections" >&2
  if [ -z "$existing" ]; then
    find . -name node_modules -type d -prune -exec rm -rf {} +
  fi
  attempt=$((attempt + 1))
done
exec "$@"
