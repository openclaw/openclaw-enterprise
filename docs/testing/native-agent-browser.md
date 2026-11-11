# Native Agent browser tests

Use the `gateway-routing` lane to check browser chat through OCC, Kubernetes
routing, and the real OpenClaw runtime. The `oidc-agent-chat` QA scenario adds
Keycloak sign-in and signed admission claims to that path. It uses manually
created Default users with explicitly attached identities; automatic account
creation is covered separately by the PostgreSQL enrollment integration.

## Run the combined OIDC journey

For runtime changes, finish focused checks and this browser proof before the
final two-architecture [image qualification](../../.agents/skills/local-dev/references/image-version-verification.md).
After a test-only correction, rerun the affected proof first. Dispatch image
qualification once the candidate is settled; it must still cover the final PR head.

Prepare the [Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets)
and the [Keycloak host prerequisites](kubernetes.md#run-the-keycloak-lane).
Use a disposable k3d cluster and a dedicated database. The lane requires an
existing authorized model credential, digest-pinned runtime images, Chromium,
and a free `127.0.0.1:443` for Keycloak. Keep credentials in the
[private test environment](README.md#requirements-and-credentials).

From the repository root:

```sh
state="$PWD/.ci-state/oidc-agent-chat.json"
file="tests/integration/oidc-agent-chat-k3d-real.test.ts"
node scripts/ci/run-tests.mjs check-selection gateway-routing --file "$file"
node scripts/ci/prepare.mjs --lane gateway-routing --selected-file "$file" --state "$state"
node scripts/ci/run-tests.mjs run gateway-routing --file "$file" --state "$state" \
  --results "$PWD/.ci-state/oidc-agent-chat-results.json"
node scripts/ci/cleanup.mjs --state "$state"
```

Run cleanup after a preparation or test failure too. Preserve the private state
file until cleanup completes. Do not run another Keycloak lane on the same host.

The focused wrapper runs the same `oidc-agent-chat` scenario as the QA matrix.
To reuse an already prepared local environment through the QA entrypoint, keep its
Kubernetes, database, routing, and Keycloak variables, then run:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=oidc-agent-chat \
  OCC_TEST_QA_PRESET=OpenClaw OCC_TEST_QA_INSTALLATION=kubernetes \
  node --test tests/integration/qa-matrix-real.test.mjs
```

`OPENCLAW_ENTERPRISE_CI_STATE` must identify the prepared cluster and database.
When Keycloak belongs to a separate prepared state, also set
`OCC_TEST_KEYCLOAK_STATE` to that private JSON file. Keep both states until their
owners finish using the resources. The shared-lane setup needs no separate
Keycloak state variable.

## What the test exercises

The browser signs in at the real Keycloak server, returns through the OCC
callback, verifies the original account ID, and opens an Agent with the resulting
shared session. A disposable IdP Group supplies the signed admission claim. The journey
checks owner creation/deployment and real owner/operator model responses. Native
`users.self`, `sessions.list`, and `chat.history` must show distinct profiles
with matching session creator and transcript sender identities. The owner's
attached password method must resolve the same native profile as OIDC.

The operator requests administrator scopes and sends forged reserved identity
and browser-key headers. HTTP and WebSocket administrative operations must
still fail. Reconnect and replacement of the test Agent's Gateway Pod with
retained storage must preserve both profiles and their attribution.

Related `native-admin-k3d-real.test.mjs` cases cover administrator access, Agent
boundaries, workspace persistence, and dedicated redeployment. They require
withdrawal to close the affected real stream within 30 seconds while another
person completes a model turn. Regrant as an operator must retain the profile
with reduced scopes; session expiry and sign-in must retain the other profile.
Delegated stock-UI connections must neither enroll devices nor receive reusable
device tokens. Existing static-human device behavior is a separate native test.

The dedicated case also provisions a second Agent through OCC and replays each
Agent's actual delegation credential against the other's Envoy route. It replays
the old credential after the existing stop/redeploy transition. Each target must
accept its own active credential and reject the other credential. The same
case distinguishes unauthenticated requests at Envoy from authorized machine
requests: reserved identity headers cannot bypass edge authentication, and the
machine route must remove browser delegation headers. An unlabelled Pod must
not connect directly to either Envoy or the native Gateway.

To test credential lookup failure, the case removes only the active revision's
delegation Secret. The availability API must return `503 DEPENDENCY_UNAVAILABLE`;
the Agent host must return its [generic `403 FORBIDDEN` refusal](../reference/agent-native-admin.md#authorization-and-availability),
without recreating the Secret or using machine access. The same signed-in health
request must succeed before removal and after recovery. A `finally` block restores its
original ownership metadata, immutability and credential bytes. Reconnection
must resolve the same native profile. These probes pass credentials on stdin;
their results contain no credential values. They do not modify model Secrets.

The existing topology starts production controller and worker entrypoints in
Kubernetes. Its test ingress terminates local browser TLS. The API reaches the
same Keycloak issuer through a namespace-local Service and a scoped container
network attachment. Only the API receives the provider secret, combined
Keycloak/Gateway CA bundle, and provider egress rule. The provider secret is not
mounted in workers or Agents; model credentials remain Agent-owned.

This is real in-cluster API, provider, browser, and runtime proof. It is not a
Helm-installed production deployment or a proof of automatic enrollment, Git,
or OpenShell. A selected case that skips, lacks prerequisites, or cannot finish
a model turn is not a pass. Inspect the test result and captured browser/runtime
evidence before reporting success.

Browser spoof checks prove OCC sanitization. The dedicated case adds the real
Envoy credential and network boundaries described above; its unauthenticated
Envoy requests originate from the network-admitted API Pod. Concurrent profile
creation, native role/credential changes, and profile-store failure still need
their owning native listener tests. OIDC email changes and provider-subject separation also
need authentication persistence coverage. Keep these results separate from the
browser journey and record the exact runtime image used.

Cleanup removes the test namespaces and its temporary network attachments.
It preserves attachments that existed before the test; lane cleanup owns the
prepared server and cluster resources.

## Collect CI browser evidence

On an eligible same-repository PR, the `full-qa` label selects the advisory
**native Agent browser** job. It runs the complete `gateway-routing` lane:
workspace routing, dedicated native administration, embedded sharing, and OIDC
owner/operator chat. The existing protected environment and credential gates
still apply. See [QA advisory triggers](ci/qa-advisory.md#when-it-runs).

The job uses the same Blacksmith runner and pinned Playwright Chromium setup as
the full integration Gateway Routing job. Sandbox preparation must pass on that
runner before browser tests start.

This job builds runtime images from the checked-out
`deploy/runtime/openclaw-source.json` and its patches. Before running a proposed
native change, pin that source manifest to the intended native commit. The
ordinary PR CI matrix does not run this live lane. A passing advisory job does
not replace review of the exact source and image digests.

The job sets the test-only `OPENCLAW_CI_NATIVE_BROWSER_EVIDENCE_DIR` to a
runner-temporary directory. CI installs the pinned Playwright FFmpeg encoder
when this variable is set, including when it uses host Chrome. Each browser
scenario writes into its own child
directory. Screenshots show synthetic chat or an access denial. WebM clips
start on the authenticated chat composer and show a real submitted model turn;
they stop after the turn or 60 seconds. A slow response can therefore appear
only in the final screenshot. The raw configuration screenshot and private
ingress keys remain outside this directory and are not uploaded.

Download these artifacts from the same run and attempt:

- `attempt-<attempt>-qa-advisory-oidc-agent-chat-gateway-routing`: the lane result
  JSON, including source SHA, per-file counts, and immutable runtime image digests.
- `diagnostics-qa-advisory-oidc-agent-chat-gateway-routing-attempt-<attempt>`:
  preparation and runtime failure diagnostics, when available.
- `native-browser-media-<run-id>-<attempt>`: only PNG screenshots and WebM clips.

For example, after replacing the run and attempt values:

```sh
run=123456789
attempt=1
gh run view "$run" --repo openclaw/openclaw-enterprise --json headSha,event,jobs,url
gh run download "$run" --repo openclaw/openclaw-enterprise \
  --name "native-browser-media-$run-$attempt" --dir /tmp/native-browser-review
```

Verify that the PR merge commit contains the intended head, the result has full
lane scope, and all four selected cases pass without skips. Open the images and
play the clips before attaching them to the PR. These captures are raw E2E
footage, not a paced Console walkthrough. Label the exact tested revision and
runtime images, and state any missing or truncated visual proof. An artifact
upload alone does not establish that the requested behavior passed.
