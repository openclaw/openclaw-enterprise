---
status: Proposed
implementation_status: Implemented
author: freeqaz
status_note: "Needs human review before landing. The accompanying draft implements Option A only."
---

# Proposal: Level floors for plain-text runtime log lines

- **ID:** RFC-0019
- **Owner:** OCC runtime log reads (`packages/occ/src/runtime-logs`). Review: API
  contract owners and the CLI and Console log viewers.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** this PR (draft)
- **Related:** dogfood finding D266 from live testing of #807; current contract
  in [agent logs](../../docs/guides/topics/agent-logs.md) and the
  [CLI reference](../../docs/reference/cli.md).

## Summary

A level floor (`occ agent logs --level error`, the API's `minLevel` and the
Logs tab's floor) keeps every line of `unknown` level. The level of plain-text
lines is always `unknown`. On a dedicated Codex Harness, most of what a reader
then sees at `--level error` is node-host reconnect chatter. In the lane's
30-minute read, 46 lines were returned and 8 of them were errors; the rest
were `node host gateway closed (1006)` and `connect failed ... ECONNREFUSED`.
This RFC decides how a floor should treat plain text. It recommends Option A:
classify the node host's known lines. Option B, a new request flag, should
wait until a second source shows the same problem.

## Options

### A. Classify the Harness node host's known lines (recommended; draft in this PR)

OpenClaw's node host (`src/node-host/runner.ts` upstream) prints a fixed set of
stderr lines. The sanitizer keeps them as `text` records and assigns a level
by prefix:

| Prefix                                              | Level |
| --------------------------------------------------- | ----- |
| `node host gateway permanently rejected connection` | error |
| `node host gateway connect failed:`                 | warn  |
| `node host gateway closed (`                        | warn  |
| `node host gateway reconnect paused`                | warn  |
| `node host gateway endpoint persistence failed:`    | warn  |
| `node host gateway connected:`                      | info  |
| `[node-host] `                                      | info  |

There is no contract change: `level` already allows these values for any
kind. The cost is upstream drift. A reworded line falls back to `unknown`,
which is today's behavior, so drift only makes the noise come back. The
replay golden for the Harness startup records the new levels, and a pin bump
that rewords the lines shows up as a golden diff.

### B. Let a floor drop `unknown` on request

Add `includeUnknown=false` to `runtime/logs`, `--level error --strict` (or
similar) to the CLI, and a checkbox to the tab. This is new public API
surface. It would also hide plain-text lines that matter, for example an
uncaught exception's stack printed as text. That is why the floor keeps
`unknown` today.

### C. Change the default to drop `unknown` under a floor

This is the smallest code change, but it breaks the documented contract
("lines of unknown level stay") and hides crash output. Not recommended.

## Decision requested

- Accept Option A as a sanitizer rule, and decide whether more known
  plain-text sources should be classified the same way.
- Decide whether Option B is wanted at all.

## Verification of the draft

- New conformance test
  `known node-host plain-text lines carry a level so a level floor can drop them`.
- The `agent-harness-startup` replay golden was regenerated: two lines changed
  from `unknown` to `info`.
- The runtime-logs conformance suites pass (68 tests).
