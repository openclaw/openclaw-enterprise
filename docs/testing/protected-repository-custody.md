# Qualify the installed repository response and dispatch custody

## Check useful Git work and conversation continuity

From the repository root, use Node.js 24 or newer, Git, OpenSSL, matching installed
workspace dependencies, and a migrated disposable PostgreSQL database. Set
`OCC_TEST_DATABASE_URL` to its limited application role as described in the
[PostgreSQL setup](./postgresql.md). Run:

```sh
node --test tests/integration/postgres-external-protected-git.test.ts
```

Require all four cases to pass without skips. The installation journeys fetch a
previously absent object, push a new commit, create and update a PR, then push a
second distinct commit to the same branch. They read the same PR through the
authorized API route and compare its head ref with the exact commit in the real
bare origin. They also require rejection of a provider-protected ref and fresh
Git denial after withdrawal, with no provider traffic, while the same token
still works directly at the controlled provider. Git and PostgreSQL are real;
the installed external Driver, workload, placement and GitHub API are fixtures.

Run the separate conversation proof with `OCC_TEST_STANDING_GIT_CODEX` set to the
absolute path of the shipped Codex executable and the same database prerequisites:

```sh
pnpm test:standing-git-conversation
```

Require the same Agent conversation to answer before and after Git withdrawal.
This uses shipped Codex with controlled inference, not a live model provider.
Neither command needs live GitHub or model credentials. The generic policy
reduction check does not establish stock OpenShell support for multiple bindings.

On the deployed build, use disposable repositories and an approved GitHub
credential source. The Agent must never receive the token. In one Agent
conversation, repeat the fetch, two commits,
PR creation and update; independently read back the PR and its Git head. Withdraw
Git while its token is still valid, require a fresh Git request to fail without
provider traffic, and continue that conversation through its retained model
access. Record build IDs, commit SHAs, PR number, withdrawal time and both turns;
exclude credentials. Reconcile an uncertain write by reading its state, never by
replaying it. The local proofs do not replace this installed qualification.

## Qualify installed custody

Run the dedicated `egress-custody-installed` lane on a newly prepared, disposable
controller and OpenShell pair before landing whole-execution repository authority.
The [lane manifest](../../scripts/ci/test-suites/egress-custody-installed.json)
requires every named observation. An ordinary CI pass or the [static inference lane](./static-egress.md#select-the-prepared-connected-lane)
does not run this qualification. Preserve exact build, image selection, installed
configuration and independent network-enforcement evidence with the result.

Use the [version 2 connected inputs](./static-egress.md#select-the-prepared-connected-lane), with `authorityProfile` set to
`fresh-whole-execution` and no `credentialConnector`. In gateway discovery, the supplier must list
each of these capabilities exactly once in both its required and supported lists, in any order:
credential access, installation exchange, response custody, execution authority and protected
no-material support. Installed enforcement evidence must report them in the order shown.
Configure its fixture bridge and valid TLS trust for both
ordinary workload clients. Select the fixture HTTPS origin (without `/v1`) in
`drivers.credential_proxy.configuration.preparedGitHub.apiOrigin` in the Installation.
Supply `issuerCaPath: /etc/openclaw/prepared-github-issuer/ca.crt` and
`custodyKeyPath: /etc/openclaw/prepared-github/custody.key`. In the chart select
`preparedGitHub.custodySecretName`, `issuerCaConfigMapName`, exact `issuerCidrs`
IPv4 /32 and `issuerPort`. The API and worker need working DNS and verified
TLS to that origin. The test checks the selected private origin in both Pods
before enrollment; a credential source cannot redirect it. The test also checks
the workload's effective authorization cannot retrieve or project the Compute signer.

The test generates an App key, separately consented dedicated Agents and metadata-only
installation credentials. It contacts neither GitHub nor a model provider.

The qualification operator needs the supplier's workspace User role and
`sandbox:write` access for `ExecSandbox`. The test rechecks the enrolled Sandbox
name and immutable ID, records a fresh launch request ID, then asks the authenticated
gateway to start ordinary curl or Node on the supplier's workload launcher. The
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

Before installing the disposable API controller, start the following observer on
its owner host. Use the same limited disposable database selected for the test.
The directory must not already exist. Keep the Unix socket on this host. Route
only that API controller's database connection through the observer's loopback
data port using the disposable network's supported forwarding. This observer
needs an explicitly non-TLS local PostgreSQL wire; never turn off an existing
transport security requirement to run it. Permit the deliberate restart only
on this API Pod template with the annotation
`openclaw.dev/egress-custody-qualification-restart: permitted`. Keep the owner
forward to the API service alive across Pod replacement. Include setup, test,
fresh API readiness, evidence and cleanup in the actual slot and outer deadline.

```sh
node tests/fixtures/egress-custody-postgres-observer.mjs "$new_observer_dir" "$data_port"
```

In the qualification shell, set the four connected inputs from the lane manifest,
then select the actual lane. The state and results paths must belong to this attempt.

```sh
export OCC_TEST_EGRESS_DISPATCH_OBSERVER_SOCKET="$new_observer_dir/control.sock"
CI_RUNNER_DEADLINE_MS=$(node -p 'Date.now() + 95 * 60000') \
CI_RUNNER_TEST_TIMEOUT_MS=5100000 node scripts/ci/run-tests.mjs run egress-custody-installed \
  --state "$attempt/state.json" --results "$attempt/results.json"
```

Reserve 90 minutes for the lane after setup, plus time for collection and disposal.
The installed test has a 74-minute execution budget. The 85-minute file timeout above
also covers owned-resource cleanup. If set, the runner's absolute `CI_RUNNER_DEADLINE_MS`
must leave at least 90 minutes when the lane starts.

Require both files in the manifest to pass. At the real TLS gRPC authority, a synthetic
enrolled peer presents the copied opening first on the wrong sink, crosses two signed
openings and two live dispatch handles, and attempts to splice an actual pending reply.
The installed test cannot extract a supervisor's possession key to repeat that injection.
Instead it holds two separately authorized executions' actual replies, makes B finish
first with only the final forbidden trailer, checks B's exact refusal and A's exact approved
identity through TLS FIN (curl at A, an independent Node client at B), then checks B's own fresh authorized read. The separate trailer
control has identical chunk framing and no trailers. For replacement, B remains authorized
with its own accepted read pending while A's late valid response is released. It must receive
only its expected refusal through FIN, then its own fresh successful read. The subsequent IAM denial is a withdrawal control.

The final case selects a protected read that explicitly requires no provider credential.
It joins the no-material access and send decisions to the acknowledged dispatch, the
credential-free request at the origin and the repository identity returned to the Agent.
It then withdraws authority while the recipient is live and verifies final route retirement.

Require the ordinary curl and Node workload reads, observed direct TCP attempt, and
specific dispatch acknowledgment loss and API restart as well. The diagnostic
names the private `.build/egress-connected/runtime-<uuid>/` directory. Retain its
`observations.json` through cleanup and `upstream.json` with the result. The
post-restart read is a new positive control, never a replay of the uncertain
dispatch. Stop the owned observer and forwarding, then remove the disposable
installation. Reconcile any unknown resource from its ledger without replay.
