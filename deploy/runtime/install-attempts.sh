#!/bin/sh
# Usage: install-attempts.sh <command> [arguments...]
#
# Runs a package install with a time limit on each attempt but the last.
# Since pnpm 12.4 fetchTimeout cuts off only a download that stops making
# progress, so one registry connection trickling at a few KiB/s held an
# OpenClaw install for 14 min against a usual 45 s (finding 1273). A timed-out
# attempt is stopped with its child processes; the next attempt opens fresh
# connections and reuses every package already in the store. The last attempt
# has no limit, so a slow but working link still finishes the build.
set -eu

limit=300
attempts=3

# Remove only node_modules trees the install created.
existing=$(find . -name node_modules -type d -prune -print)

attempt=1
while [ "$attempt" -lt "$attempts" ]; do
  status=0
  timeout --kill-after=30 "$limit" "$@" || status=$?
  case "$status" in
    0) exit 0 ;;
    124 | 137) ;;
    *) exit "$status" ;;
  esac
  echo "install-attempts: attempt $attempt passed ${limit} s; retrying with fresh connections" >&2
  if [ -z "$existing" ]; then
    find . -name node_modules -type d -prune -exec rm -rf {} +
  fi
  attempt=$((attempt + 1))
done
exec "$@"
