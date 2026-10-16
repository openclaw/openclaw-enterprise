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
one-shot node setup credential through a revision-owned provider. The test
checks that the raw app-server token and model key are absent from Pod specs and
nonsecret provider data. It then verifies missing, incorrect, and correct bearer
requests through the exposed route. Two HTTP chat turns through the Agent Gateway
exercise the OpenClaw bridge, with successful shell commands verified from the
native Codex session records. Direct app-server probes then check filesystem,
network, and credential enforcement. Exact workload identity, approved mounts
and privileges, source withdrawal, replacement, and cleanup remain required.
Missing prerequisites fail rather than skip.

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
  request without a response (curl exit 52), and the upstream must receive the
  source's own token again once the Service is restored.
- **Model provider.** For a DNS endpoint, cluster DNS sends the model host to a
  Service with no endpoints. The turn must fail without exposing the model
  credential, and the same revision must serve the next turn once DNS is
  restored. An IP endpoint reports this check as not run.
- **OpenShell gateway.** The Namespace's gateway StatefulSet is scaled to zero.
  While it is down, the running Agent cannot serve a turn, a source read
  reports `failed`, registration returns `503 DEPENDENCY_UNAVAILABLE`, and a
  redeploy fails at least one attempt and stays queued. Once the gateway is
  back, the redeploy activates and serves a turn without operator action.

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
- the Pod specs, the Agent- and revision-owned Secrets, and the workspace PVC
  files hold no upstream credential. Files are matched outside the Pod, so no
  credential-derived value enters it;
- deployment diagnostics, runtime status and logs, and the Namespace's audit
  events hold neither a credential nor an OpenShell placeholder.

## Update and withdrawal

The Codex scenario then updates the source through the API, withdraws it from
the running Agent, waits for `revoked`, and expects the next model turn in the
same process to fail. It accepts any turn failure, so it does not yet tell a
credential rejection from a transport error or a restarted process. Full
manual integration lanes run from `main`; trusted pull requests also run the
OpenShell advisory job described in [Tests in each workflow](ci.md#tests-in-each-workflow).
