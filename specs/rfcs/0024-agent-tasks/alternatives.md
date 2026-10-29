---
rfc: index.md
---

# Agent Tasks: alternatives considered

This companion to [RFC-0024](index.md) records the alternatives behind the proposal.

- **Keep a team's own coordination board and reach turns from inside Pods.** This works today but has no OCE identity, IAM or
  audit, and puts cluster credentials on the coordinator's machine. It is the reason for this proposal.
- **Native OpenClaw sessions, automations and session dispatch through native admin.** They are per gateway, need
  `administer`, and OCC cannot authorize or audit each command. Tasks reuse the session machinery and add OCC
  ownership.
- **Slack as the board.** Identity is a Slack user ID, history lives in Slack, and there is no state or lease.
- **An external tracker as the store.** It splits authorization between two systems and still needs the delivery and
  result path proposed here.
- **Brief and report files through workspace files.** The API allows four fixed names and has no trigger or feed.
- **Wait for RFC-0006's Agent invocation.** RFC-0006 proposes submit, status, result and cancel behind `invoke`, with
  duplicate-dispatch fences, but is deferred past 0.x behind its role catalogue and connector admission. This
  proposal delivers a narrow automation subset with the same action and the same rule: an unknown start never
  authorizes an automatic resend.
- **A general gateway RPC route in OCC.** A superseded transport plan passed `chat.send` and `chat.history` through
  OCC. Raw RPCs give callers native semantics without an OCC record, state or bounds.
- **Agents post directly to OCC.** The better long-term shape, and slice 3; it needs workload identity first.
