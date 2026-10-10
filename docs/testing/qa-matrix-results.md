# Read QA matrix results and recover failures

Use this page with the [QA matrix guide](qa-matrix.md) after a credentialed
`qa-matrix` run starts or finishes. It explains how to read scenario evidence and
how to handle intermittent Git connection failures without weakening the matrix
assertions.

## Read scenario outcomes

The test runner prints named subtests. `matrix.json` records completed stage
callbacks with `cell`, `stage`, `outcome`, `startedAt`, and `durationMs`.
Worker stages also include `scenario`; failures include a redacted `reason`:

- `passed`: the stage completed its assertions.
- `failed`: execution or an assertion failed.
- `blocked`: the stage reported a prerequisite failure, such as unavailable
  installation setup or Agent deployment.

Installation setup uses `compose` or `kubernetes` as its cell; preset stages use
names such as `compose/Codex`. Completed stages enter the report in completion
order. Writes are serialized and published atomically, so simultaneous workers
do not overwrite outcomes or expose partial JSON. Earlier outcomes remain
available when a later stage fails. The workflow retains these files in
its `qa-matrix-<run-id>-<attempt>` artifact (manual) or
`qa-advisory-<installation>-<run-id>-<attempt>` artifact (PR) for seven days.

A grouped stage has one outcome: clone, commit, push, and PR creation are not
separate result rows. Cell evidence adds Agent/revision/Pod identities, nonce
results, remote SHAs, credential disposal, and Slack timestamps. The summary
has per-stage wall-clock durations, excluding queue time and report writes, but
the `selection` inventory separately lists selected, unselected, and
not-applicable scenarios per cell. Parallel durations overlap; adding
them does not give the overall run duration.
Filtered, unentered, or interrupted stages can be absent; absence is not a pass.
Inspect runner failures and cleanup results alongside the JSON.

`scope: full` means all installations, presets, and scenarios were selected, not
that they passed. `partial:selected` identifies an explicit subset;
`partial:filtered` identifies additional Node test-name filtering. Exclusions
remain explicit. A successful static check or parent setup does not establish
that every live scenario passed.

Ordinary cleanup stops agents and calls `scripts/dev-down` with each owned state
directory. If repository disposal is uncertain, the fixture retains its
installation and reports the recovery path. Keep that broker alive until its
sessions are `DISPOSED`, with zero active uses, active/pending/uncertain cleanup,
and no auxiliary cleanup pending. Do not delete another run's resources.

## Intermittent Git connection failures

If native Git reports `GnuTLS recv error` or an unexpectedly closed TLS
connection, check the broker's upstream connectivity before changing certificate
trust or command deadlines. An upstream connection failure can cause the broker
to close the Agent connection without returning an HTTP error.

Verify the addresses resolved for both `github.com` and `api.github.com` from
the broker Pod against the private `upstream-cidrs.json` fixture and installed
NetworkPolicy. DNS answers can rotate: an allowed address may succeed while a
different address is refused on the next clone or fetch. A successful API call
does not prove Git egress, and a single successful DNS lookup is insufficient.
Use the [local repository input procedure](../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs)
to refresh the approved endpoints. After confirming session disposal, recreate
only the run-owned installation and rerun the affected scenarios. Keep the Git,
sandbox, and disposal assertions intact; retries do not correct a missing
egress destination.

## Related guide

- [Run the shipped installation QA matrix](qa-matrix.md)
