---
created: 2026-11-21
updated: "2026-11-21"
last_updated_session: "authoring-run/01a1fbf1-03d5-7d21-af95-cdba37f77298"
---

# Protected network proxy acceptance flow

Full Integration has one acceptance-only path for PR #6856 at `9ffc8947c06954644ceb08da25164adbc8a184ab`. It does not accept arbitrary source refs. See [Full Integration](../../testing/ci/full-integration.md#one-off-network-proxy-acceptance) for operator requirements.

1. `full-integration.yml` admits only a first-attempt manual `main` dispatch of `slack`, after `integration-main-approval`. The acceptance caller alone grants PR/check read permissions.
2. `full-integration-execution.yml:slack-network-proxy-acceptance` enters the existing `full-integration-slack-live` group with `queue: max` and `cancel-in-progress: false`, then uses `integration-main`. The normal Slack job is mutually exclusive and unchanged by default.
3. The trusted main action and verifier recheck the dispatcher, exact same-repository PR head, approved GitHub Actions CI run and checks. They persist and confirm a one-shot artifact before using a write-capable Slack credential. Identity checks compare nonsecret bot/team/channel IDs; a preflight Socket Mode hello must report one connection and close before any Gateway starts.
4. The candidate is checked out separately with credentials unpersisted. The exact approved candidate is fully privileged trusted same-UID code after protected approval; process environment filtering and self-hash checks are not an isolation boundary. A reviewed test-only overlay withholds the sender from zero-post cases and adds post-gate calls.
5. The trusted runner first requires both zero-post cases and canonical QA PAT/shipped-runtime qualification. It then runs topology, non-upgrade Helm, and named Kubernetes/Codex/Slack QA stages sequentially. A private Unix gate reconciles owned consumers and the external root/thread ledger immediately before explicit sends. Cumulative intended counts are 2, 4, and 7.
6. Cleanup runs without Slack credentials, verifies owned resource retirement, and emits a distinct acceptance receipt. Only successful cleanup publishes the 90-day cleanup artifact. Before fixture credentials are available, the ordinary Slack job checks the one-shot marker and requires a matching, nonexpired, digest-verified cleanup receipt from the same approved main dispatch; unknown or unresolved state fails closed. The acceptance aggregate validates the exact source, selected tests, stage counts and cleanup. It never marks the ordinary Slack lane or full suite covered.

The app subscriptions remain unknown. The user accepted the off-channel risk and observational budget: transient between-poll posts/deletions, off-channel writes and autonomous Gateway sends cannot be prevented by the ledger. There is no continuous authoritative Socket Mode sentinel or Slack-side hard cap. The marker and expiry prohibit automatic redispatch; a failed or uncertain partial send must not be retried.

## Manual Notes

## Changelog

- 2026-11-21: Document the one-off protected acceptance path. (authoring-run/01a1fbf1-03d5-7d21-af95-cdba37f77298 - c1286e15d8453b5d014dbe3c1b85867181b675b5)
