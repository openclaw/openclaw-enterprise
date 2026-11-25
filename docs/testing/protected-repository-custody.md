---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Qualify the installed repository response and dispatch custody

This page records behavior and verification on earlier releases of the retired
protected egress implementation. Use [Credential Design 1.0](https://github.com/openclaw/openclaw-enterprise/tree/main/specs/rfcs/20261124-credential-design-1-0) for the current design.

## Check useful Git work

From the repository root, use a Node.js version supported by [the workspace](../../package.json), Git, OpenSSL, matching installed
workspace dependencies, and an owned disposable PostgreSQL fixture. Follow the
[prepared PostgreSQL setup](./postgresql.md#revision-worker-tests). Inside its
cleanup-trapped subshell, replace the `run-tests` command with these commands.
Each case copies the migrated template and runs as the limited application role.
Clearing stale overrides ensures it uses this run's prepared database:

```sh
node scripts/ci/prepare.ts --lane postgres-application \
  --file tests/integration/postgres-external-protected-git.test.ts \
  --state "$PG_RUN_DIR/state.json" --github-env "$PG_RUN_DIR/test.env"
env -u OCC_TEST_DATABASE_URL -u OPENCLAW_ENTERPRISE_CI_STATE \
  -u OPENCLAW_ENTERPRISE_CI_PREFIX node --env-file="$PG_RUN_DIR/test.env" --test \
  tests/integration/postgres-external-protected-git.test.ts
```

Require every selected case to pass without skips. The installation journeys fetch a
previously absent object, push a new commit, create and update a PR, then push a
second distinct commit to the same branch. They read the same PR through the
authorized API route and compare its head ref with the exact commit in the real
bare origin. They also require rejection of a provider-protected ref and fresh
Git denial after withdrawal, with no issuance or workload traffic, while the same token
still works directly at the controlled provider. Git and PostgreSQL are real;
the installed external Driver, workload, placement and GitHub API are fixtures.

The `git-write` journey admits one repository grant with a single draft pull request
for online authorization. The installed sender pushes the granted ref; OCC refuses
another ref before any pack reaches the origin, refuses a wrong base, accepts one
draft and refuses a second. The sender refuses a non-draft pull request before asking
OCC. After withdrawal OCC refuses each fresh fetch, push and draft, with no origin,
provider or issuance traffic. The case reads OCC's use
rows, the spent draft allowance and the delivery record.

The default file-based GitHub policy case signs in a persisted account through Fastify,
creates and deploys an Agent without a public Repo Driver, and refuses the same
repository in an otherwise authorized foreign Namespace before issuance or Git
traffic. It restarts the Worker and custody owner, fetches a new commit through
the original revision, then proves a due renewal issues and installs new material
while approved. After withdrawal, the same due custody pass must issue nothing;
fresh fetch and push fail before issuer or workload-provider ingress. Intentional
token retirement is counted separately from workload traffic. The provider holds
retirement of the current token through the denied Git requests and a direct
validity probe, then releases it before custody and Worker checks. The two direct
probe requests are accounted for separately; issuer and workload baselines remain
continuous. This is local
protocol and persistence proof, not an installed OpenShell or live GitHub
qualification.

On the deployed build, use disposable repositories and an approved GitHub
credential source. The Agent must never receive the token. In one Agent
conversation, repeat the fetch, two commits,
PR creation and update; independently read back the PR and its Git head. Withdraw
Git while its token is still valid, require a fresh Git request to fail without
provider traffic, and continue that conversation through its retained model
access. Record build IDs, commit SHAs, PR number, withdrawal time and both turns;
exclude credentials. Reconcile an uncertain write by reading its state, never by
replaying it. The local proofs do not replace this installed qualification.

### Reuse the rehearsal with another runtime

Use [the scenario helper](../../tests/helpers/agent-grant-rehearsal.ts) from a
Node test. Run all four observations inside the `runAgentGrantRehearsal` callback.
The test fails if the callback returns before `modelAfter` succeeds.
Register cleanup as each resource is acquired with `t.after`, including
the Agent process, origin servers, and disposable repository. Keep the operator
control endpoints and origin repository outside the workload's reach.

1. Start one Agent and one conversation. Serve two distinct answers from a
   controlled model origin. Require the first answer and its origin request,
   then call `modelBefore` with the observed Agent, revision, runtime, session,
   and turn IDs.
2. Read the expected commit SHA at the bare origin. Use real Git in a
   workload-owned repository and check that it lacks that commit before fetch.
   Give `gitFetched` the observed `FETCH_HEAD` and the change in origin request
   count. Use a separate origin-side control to publish commits.
3. Remove the Git grant through its owning control plane while the Agent stays
   up. Publish a different commit at the origin. Fetch the same ref through the
   workload's original Git path. Require the adapter's specific policy refusal
   and pass Git's exit status, the before and after object lookups, and origin
   request delta to `gitRefused`.
4. Ask a second question on the original conversation. Verify the controlled
   model reply, read back the same runtime identity, and pass the new turn ID
   to `modelAfter`. Stop and join the workload before closing the origins.

For a Strands Agents SDK workload, start with the
[Strands Box SDK example](https://github.com/strands-agents/box/tree/d9346bf0d281153ea7dc6338ad1f0b7e122be687/examples/strands-box/strands-sdk-agent)
and the Git tool policy from its
[Git workload test](https://github.com/strands-agents/box/tree/d9346bf0d281153ea7dc6338ad1f0b7e122be687/test-workload/workload-git).
Replace the example's Bedrock provider with an SDK model pointed at the controlled
origin and keep the SDK Agent alive for both turns. Give its Git tool access to
one disposable checkout and one fixture HTTPS repository. Use a test CA and a
synthetic origin credential if required. Keep both origin control channels
outside the Box.

Use the hosted Box library from the
[reload integration test](https://github.com/strands-agents/box/blob/d9346bf0d281153ea7dc6338ad1f0b7e122be687/crates/box/tests/box_library.rs).
Start one `strands_box::run` and have the host call `strands_box::reload` with
the complete policy minus the Git destination permit. Keep Git tool execution
and the model destination permitted so the refusal occurs at the Git egress
boundary. Read the denial in the Box journal and measure Git origin traffic
outside the Box. Use the Box execution identity as `runtimeId`. This path needs
no OpenShell or workload identity service. To qualify an installed integration,
withdraw through that integration's actual grant owner and verify the same
observations through its selected sender.

## Qualify installed custody

Run the dedicated `egress-custody-installed` lane on a newly prepared, disposable
controller and OpenShell pair before landing whole-execution repository authority.
The [lane manifest](../../scripts/ci/test-suites/egress-custody-installed.json)
requires every named observation. An ordinary CI pass or the [static inference lane](./static-egress.md#select-the-prepared-connected-lane)
does not run this qualification. Preserve exact build, image selection, installed
configuration and independent network-enforcement evidence with the result.

Use the [version 2 connected inputs](./static-egress.md#select-the-prepared-connected-lane), with `authorityProfile` set to
`fresh-whole-execution` and no `credentialConnector`. Omit `controllerUpgrade`: this
lane qualifies one deployed release. In gateway discovery, the supplier must list
each of these capabilities exactly once in both its required and supported lists, in any order:
credential access, installation exchange, response custody, execution authority and protected
no-material support. Installed enforcement evidence must report them in the order shown.
Configure the fixture bridge and verified TLS trust for the workload client.
The test enrolls a dedicated Agent and uses a credential-free metadata Source
pointing to a controlled HTTPS origin. It checks that the workload cannot
retrieve or project the Compute signer.

The qualification operator needs the supplier's workspace User role and
`sandbox:write` access for `ExecSandbox`. The test rechecks the enrolled Sandbox
name and immutable ID, records a fresh launch request ID, then asks the authenticated
gateway to start curl on the supplier's workload launcher. The
children inherit its connection mediation and installed TLS trust. Operator credentials
stay on the gateway control channel. A Kubernetes exec in the same Pod would not
inherit the launcher's mediation. If the terminal `Exit` is missing or the supplier
reports an execution timeout, reconcile that launch ID without resubmitting the client.
The supervisor's later egress request ID identifies a separate operation.

Observe custody while the enrolled Sandbox still exists. The supervisor pushes structured
INFO events in batches. Its console output omits the request ID and transition fields.
The test reads the full supplier log with `GetSandboxLogs` (workspace User, `sandbox:read`),
checks the Sandbox ID, supervisor Pod UID, container and log continuity, then joins the
reported request ID to the dispatch receipt and the independently observed origin request.
A refusal requires an explicit `no_permit` event. If delivery is incomplete, ambiguous or
late, report custody as unobservable and preserve the other evidence without repeating the
workload request. The log supplies evidence about that request, never permission to send it.

In the qualification shell, set the four connected inputs from the lane manifest,
then select the actual lane. The state and results paths must belong to this attempt.

```sh
CI_RUNNER_DEADLINE_MS=$(node -p 'Date.now() + 95 * 60000') \
CI_RUNNER_TEST_TIMEOUT_MS=5100000 node scripts/ci/run-tests.ts run egress-custody-installed \
  --state "$attempt/state.json" --results "$attempt/results.json"
```

Reserve 90 minutes for the lane after setup, plus time for collection and disposal.
The installed test has a 74-minute execution budget. The 85-minute file timeout above
also covers owned-resource cleanup. If set, the runner's absolute `CI_RUNNER_DEADLINE_MS`
must leave at least 90 minutes when the lane starts.

Require both files in the manifest to pass. At the real TLS gRPC authority,
a synthetic enrolled peer presents a copied opening on the wrong sink and
attempts to cross two signed openings and their pending replies.

The installed test joins the no-material access decision and send permit to
the dispatch, exact request at the controlled HTTPS origin and filtered
repository identity returned to the Agent. It withdraws IAM authority while
the Agent is live, observes denial before origin traffic and waits for final
route withdrawal and Sandbox retirement.

The diagnostic names the private `.build/egress-connected/runtime-<uuid>/`
directory. Retain its `observations.json` through cleanup and `upstream.json`
with the result. Remove the disposable installation and reconcile unknown
resources from that attempt's ledger.
