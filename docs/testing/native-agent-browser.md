# Native Agent browser tests

Use the `gateway-routing` lane to check browser chat through OCC, Kubernetes
routing, and the real OpenClaw runtime. The `oidc-agent-chat` QA scenario adds
Keycloak sign-in and signed admission claims to that path. It creates Default users through first-login enrollment and verifies that
returning login reuses the account. The real Keycloak tests own the admission and
email-policy matrix. PostgreSQL enrollment tests cover policy changes, returning
identities, initial grants, concurrency, and transaction rollback.

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
node scripts/ci/run-tests.ts check-selection gateway-routing --file "$file"
node scripts/ci/prepare.mjs --lane gateway-routing --selected-file "$file" --state "$state"
node scripts/ci/run-tests.ts run gateway-routing --file "$file" --state "$state" \
  --results "$PWD/.ci-state/oidc-agent-chat-results.json"
node scripts/ci/cleanup.ts --state "$state"
```

Run cleanup after a preparation or test failure too. Preserve the private state
file until cleanup completes. Do not run another Keycloak lane on the same host.

The focused wrapper runs the fresh-install OIDC journey. The QA matrix runs that
journey and the previous-source upgrade journey described below.
Lane preparation attaches PostgreSQL to the disposable cluster before it
discovers and publishes the host port. Test files preserve that attachment;
lane cleanup removes PostgreSQL before the cluster network. Set
`OCC_TEST_BROWSER_EXECUTABLE` to use an installed Chromium browser; the lane passes
this optional selection to its browser tests. CI also installs Playwright's
FFmpeg binary for video recording when using an installed browser.
Its preparation omits the dedicated Codex sandbox probe because this journey
deploys only embedded OpenClaw Agents with `RuntimeDefault` seccomp. Preparing
the full `gateway-routing` lane still requires the Codex probe for its dedicated
execution cases. The hosted OIDC job retains a browser recording and screenshot
of the real model exchange; recording starts after sign-in.
To run both journeys through the QA entrypoint, prepare the full `gateway-routing`
lane without `--selected-file`. Keep its Kubernetes, database, routing, Keycloak,
fixed baseline image, and source receipt variables, then run:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=oidc-agent-chat \
  OCC_TEST_QA_PRESET=OpenClaw OCC_TEST_QA_INSTALLATION=kubernetes \
  node --test tests/integration/qa-matrix-real.test.mjs
```

`OPENCLAW_ENTERPRISE_CI_STATE` must identify that full Gateway Routing state.
The upgrade stage rejects a state focused on the fresh-install file. Both its
standalone wrapper and the direct QA stage allocate a separate database; neither
can reuse an Installation initialized by the fresh-install journey.
When Keycloak belongs to a separate prepared state, also set
`OCC_TEST_KEYCLOAK_STATE` to that private JSON file. Keep both states until their
owners finish using the resources. The shared-lane setup needs no separate
Keycloak state variable.

## Previous-source installation upgrade

The permanent upgrade case runs in the same hosted native-browser job and
full Gateway Routing lane. To focus it, use the commands above with
`tests/integration/native-profile-upgrade-k3d-real.test.ts` as `file` and a new state path.
A selected run must pass without skips. Missing baseline inputs fail preparation.

Preparation builds the previous controller and runtime from the detached source
`535e08cae41dfd5bda0c072fcb37039e699203eb`, the exact pre-feature main parent,
using the checkout's object store. This is not a previous published release.
The full runtime tree fixes its nine bridges and native source
`b58996d69286d55d1bbbd9b5c03b4ad837baac45`. Image labels, imported manifest
references, and running Pod image IDs bind the observation to the selected pair.
Old images are not obtained from mutable tags or expiring CI artifacts. The
candidate receipt records its actual tested checkout, recipes, native pin, and
bridge inventory independently; it is not forced to the old nine-bridge set.

The case owns a new database with only administrator-provisioned roles and
empty schemas. The old image migrates with `--expect-empty`, checks its complete
catalog, and runs its production bootstrap entrypoint. No current schema
template or current bootstrap initializes that Installation. After both old
writers stop, the candidate runs its actual migrations and checks its own
current catalog; it need not equal the baseline. Only initialization receives
the migrator credential. The API and Worker use the limited application role.

Two real OIDC users create history under the old shared native identity. After
completed model turns, the fixture removes both old controller writers, runs the
candidate migration and incumbent-bootstrap verification, and starts the new API
and Worker. The retained old Agent revision must refuse browser access without
a delegation credential. Normal API deploy then upgrades that same Agent; the
test does not patch its saved authentication or invent new human ownership.

Assertions retain Installation, account, Principal, Agent service-Principal, and
Gateway PVC identities. Historical shared creator/sender records remain unchanged.
Fresh owner/operator model turns require distinct profiles and exact scopes.
Reconnect, Pod replacement, selective withdrawal/regrant, and replay of the old
shared credential exercise the upgraded authorization boundary. The retained
`native-profile-upgrade-receipt.json` contains only fixed source metadata, image
references, Pod/PVC identifiers, and completed check predicates. Screenshots and
recordings begin after sign-in; credentials and raw transcripts are not receipts.

This proves the real in-cluster production-entrypoint installation transition,
not a Helm installation/upgrade, release publication, or a different native pin.
Source checks and command fixtures alone do not prove it. Require the selected
hosted case's terminal result and cleanup receipt for real upgrade qualification.

## What the test exercises

The browser signs in at the real Keycloak server, returns through the OCC
callback, creates the account, verifies that a returning login reuses its ID, and opens an Agent with the resulting
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
delegation Secret. The availability API and Agent host must return the canonical
`503 DEPENDENCY_UNAVAILABLE` response, with no Secret or credential details,
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
Helm-installed production deployment or a proof of Git or OpenShell. A selected case that skips, lacks prerequisites, or cannot finish
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
five cases: workspace routing, dedicated native administration, embedded sharing,
OIDC owner/operator chat, and the previous-source installation upgrade. The existing protected environment and credential gates
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
