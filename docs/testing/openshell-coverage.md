# What the OpenShell Sandbox suite proves

These are the checks in `tests/integration/sandbox-driver-openshell-k3d-real.test.mjs`.
Prepare and run the suite as described in [OpenShell tests](openshell.md#openshell-sandbox).
Unless a section says otherwise, the checks run in the default Codex scenario.

## Credential source and Harness

Both modes compose the `openshell` Backend with the Sandbox and Credential
Gateway Drivers. Through the production API they register a `codex-pat` source
from `CODEX_ACCESS_TOKEN` for Codex, or an `openai` source from `OPENAI_API_KEY`
for native OpenClaw and custom model endpoints. They check its live
`ready` status, and bind the Agent with `credential_source`. The Agent service
principal receives `operate` on the source only, not on the Secret.

The default Codex scenario uses the production Driver path. Compute sends only
`APP_TOKEN_SHA`; OpenShell supplies `runtime.json`, `config.toml`, and the
one-shot node setup credential through a provider for that Agent revision. The test
checks that the raw app-server token and model key are absent from Pod specs and
nonsecret provider data. It then verifies missing, incorrect, and correct bearer
requests through the exposed route. Two HTTP chat turns through the Agent Gateway
exercise the OpenClaw bridge, with successful shell commands verified from the
native Codex session records. Direct app-server probes then check filesystem,
network, and credential enforcement. Exact workload identity, approved mounts
and privileges, source withdrawal, replacement, and cleanup remain required.
Missing prerequisites fail rather than skip.

## Agent network policy

The policy scenario uses the production HTTP admission path, PostgreSQL worker,
and real OpenShell policy RPCs. Trusted Installation defaults allow its Python
control request on port 8082; the target on port 8083 requires a runtime grant.
Both listeners are separate from the echo Service's credential-injection port.
The fixture proves target reachability independently, then exercises the actual
Agent's Python denial, descriptor discovery, write-free preview, save, confirmed
application, removal, and isolation from a second Agent. The allowed default
control remains reachable after revocation. Denial logs and native
recommendations are checked separately.

It revokes each required permission after work is queued and checks failure
before `UpdateConfig`, unchanged loaded provider state, and attributable audit
evidence. A test barrier also interrupts the worker after the real native write
succeeds but before OCC records its receipt. A restarted worker must confirm
the loaded policy without issuing the write again. These cases require the
real runtime; local wire fixtures do not establish their outcomes.

The full scenario's scope check temporarily enables OIDC on the real Namespace gateway using
the disposable HTTPS Keycloak issuer. Signed identities with `sandbox:read`,
`config:read`, `config:write`, or no scope exercise policy status, recommendations,
and `UpdateConfig`. Missing authentication and insufficient scopes must fail;
rejected writes must preserve provider state. An authorized writer resubmits
the loaded policy, which OpenShell may deduplicate. This checks RPC scopes in
authentication-only role mode; it does not qualify Workspace role isolation.
It runs last because changing gateway authentication restarts the service router;
continuity of existing service routes across that configuration change is unqualified.

CI preparation supplies `OCC_TEST_OPENSHELL_POLICY_MIGRATION_DATABASE_URL` for
the same disposable database as `OCC_TEST_DATABASE_URL`. Direct file runs must
set it to that database's `occ_migrator` URL. Only fixture setup uses it to
insert and remove IAM Restrictions; the API, worker, and observer retain the
application role.

## Credential route

After the egress turn, the test writes a probe script into the shared workspace
and Codex runs it, so each request is a Sandbox process behind OpenShell's proxy.
The script prints only status codes and flags. It checks that:

- the model placeholder, read from the Harness auth file for PATs or an ancestor
  process for API keys, is refused at a tool source's host with
  `403 credential_endpoint_mismatch`. Any other failure fails the check;
- a command Codex starts can authenticate at a source endpoint: PAT identity
  validation or API-key Responses. The real model turn separately exercises the
  inference route. OpenShell matches binaries against ancestors; the test expects
  this until Agent tools run in their own Sandbox;
- skipping the proxy settings reaches neither a denied host nor a bare public
  address while an allowed host still answers, and the Harness Pod itself
  reaches no public address;
- a `bearer-token` source whose upstream presents a certificate from an
  untrusted CA fails: the Harness sees the Sandbox proxy's certificate, and the
  upstream logs a failed handshake and no request.

After the Harness is replaced, and before it has called the provider, the test
points cluster DNS for the model host at that untrusted upstream. The model
turn must fail with the upstream receiving no request, and DNS is restored
before the next phase. An endpoint selected by IP address cannot be redirected
this way, so the suite reports this check as not run.

## Outages

Next, the Codex scenario takes each dependency away and restores it before
asserting:

- **Tool upstream.** The echo Service selects no Pod. OpenShell must end the
  request without a response (curl exit 52), or hold it until curl's bounded
  timeout (exit 28). The upstream must receive the source's own token again once
  the Service is restored.
- **Model provider.** For a DNS endpoint, cluster DNS sends the model host to a
  Service with no endpoints. The turn must fail without exposing the model
  credential, and the same version must serve the next turn once DNS is
  restored. An IP endpoint reports this check as not run.
- **OpenShell gateway.** The Namespace's gateway StatefulSet is scaled to zero.
  While it is down, the running Agent cannot serve a turn, a source read
  reports `failed`, registration returns `503 DEPENDENCY_UNAVAILABLE`, and a
  redeploy waits as `SANDBOX_GATEWAY_UNAVAILABLE` without spending attempts
  and stays queued. Once the gateway is back, the redeploy activates and serves
  a turn without operator action.

After the restart, an OAuth2 source whose refresh was due may fail with
`refresh_configuration_invalid` and be retried only an hour later
([NVIDIA/OpenShell#4526](https://github.com/NVIDIA/OpenShell/issues/4526)).
The test accepts that state and requires a forced rotation to restore the
token.

## Absence checks and a second Agent

After the tool-source turns, the Codex scenario deploys a second Agent that
attaches one of the tool sources. When the first Agent withdraws that source,
the second Agent still receives its token. The scenario then checks that:

- no Pod of the Agent mounts or references the stored source Secret;
- the Pod specs, the Secrets for the Agent and its Agent revisions, and the workspace PVC
  files hold no upstream credential. Files are matched outside the Pod, so no
  credential-derived value enters it;
- deployment diagnostics, runtime status and logs, and the Namespace's audit
  events hold neither a credential nor an OpenShell placeholder.

## Update and withdrawal

The Codex scenario then updates the source through the API, withdraws it from
the running Agent, waits for `revoked`, and expects the next model turn in the
same process to fail. It accepts any turn failure, so it does not yet tell a
credential rejection from a transport error or a restarted process. The
[complete OpenShell advisory lane](ci.md#qa-matrix) runs on every push to `main` and on
trusted pull requests when a maintainer requests it with the `full-qa` label.

### QA matrix selector

The explicit `sandbox-policy` scenario runs the complete network-policy lifecycle
with this real OpenShell setup and production API/worker. It selects
`OCC_TEST_OPENSHELL_SCENARIO=network-policy`, which provisions no unrelated OAuth
refresh sources and excludes the separate filesystem, credential rotation, and
outage qualification phases. The default `full` scenario retains those phases
and the policy lifecycle. This selector is separate from the matrix's default
Sandbox-free installations. Prepare the
OpenShell lane and its Sandbox test file first, then provide that file's private
`--github-env` output as `OCC_TEST_QA_SANDBOX_ENV` and the authorized token file as
`OCC_TEST_QA_CODEX_TOKEN_FILE`:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_INSTALLATION=kubernetes \
OCC_TEST_QA_PRESET=Codex OCC_TEST_QA_SCENARIOS=sandbox-policy \
  node --test tests/integration/qa-matrix-real.test.mjs
```

The selected workflow must pass without skips. Its sanitized runtime log is
written to the matrix artifacts directory. Cleanup remains with the owner of the
prepared OpenShell lane; run the documented cleanup even on failure. The existing
OpenShell advisory job exercises this workflow with the rest of its runtime suite.
