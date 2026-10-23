# Set up and operate Credential Proxy

Credential Proxy lets an Agent use an approved credential through an enforcing
transport without putting provider material in the Agent's configuration. OCC
controls access to the execution; the selected Driver enforces the request and
credential delivery. For prepared GitHub access, Token Service also maintains
the short-lived credential. The setup and verification depend on the selected
delivery profile.

**There is no qualified stock OpenShell deployment for protected access in this
release.** Stock OpenShell 0.1.5 is not qualified. A successful fixture, Helm
rollout, or source registration does not establish an installed enforcing path.
Deploy refuses a `git-write` binding on the bundled OpenShell Credential Proxy
with `409 REPOSITORY_GIT_SENDER_UNQUALIFIED`.
Before enrolling real credentials, qualify the exact Driver, Compute, Sandbox,
images, charts, and TLS path for the requested profile. The
[Credential Proxy reference](../reference/drivers/credential-proxy.md) describes
the contract those components must meet.

## Choose the path before changing an installation

| Intended use               | Requirement and limit                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected static inference | Kubernetes Compute and the same installed Driver for Sandbox and Credential Proxy; explicit whole-execution authority. The bundled legacy OpenShell release cannot enforce it.                                  |
| Prepared GitHub App access | Worker Token Service prepares credentials; OCC authorizes scope and lifetime; Credential Proxy installs and fences delivery. Protected delivery requires a qualified sender.                                    |
| Native prepared Git        | A separate explicit Kubernetes/dedicated Codex path without Sandbox or Credential Proxy; it does not provide OpenShell isolation. See [native Git](../reference/repository-credentials/prepared-native-git.md). |

For a packaged Driver, select its Sandbox and Credential Proxy capabilities
from the same registration. The [Driver selection guide](../reference/drivers/selection.md#select-a-protected-sender)
shows the Installation settings and profile requirements. Selection establishes
which implementation OCC loads; qualification establishes what the installed
sender actually enforces.

Use the [upgrade procedure](deploy/credential-proxy-upgrade.md) for an existing
installation, including when a Gateway source or its owner must remain.

## Prepare enforcement, trust, and custody

For a reviewed development candidate, follow
[local candidate image selection](deploy/local-openshell-images.md), including
all three immutable OpenShell images, their source commit, and matching charts.
Use its protected launch procedure only for the profile it prepares. It creates
a development installation for qualification, not a supported stock deployment.

For protected static inference, the Installation selects the same Driver ID in
`backend[].drivers.credential_proxy` and `drivers.credential_proxy`. A bundled
OpenShell authority selection has this shape:

```yaml
drivers:
  credential_proxy:
    id: openshell-egress
    configuration:
      middlewareName: oce-authority
      authorityScope: execution
      authority:
        host: 0.0.0.0
        port: 9444
        certificatePath: /etc/openclaw/egress/tls/tls.crt
        privateKeyPath: /etc/openclaw/egress/tls/tls.key
        issuerPublicKeyPath: /etc/openclaw/egress/issuer/issuer.pub
        issuer: openshell-gateway:openshell-gateway
        audience: oce-egress
        keyId: current
```

This is a fragment, not a complete Installation. Match issuer, audience, key ID,
and middleware name to the configured peers. Keep the
[OpenShell Backend and Sandbox configuration](../reference/drivers/openshell-credential-gateway.md).
A packaged Driver instead takes configuration through its Sandbox selection;
its matching Credential Proxy selection has an empty `configuration`.

The API owns the static authority listener. Development binds only to loopback.
Production needs a reachable host and a certificate covering the Service DNS
name. With Helm, use `host: 0.0.0.0` (or `::`) and the `egressAuthority.port`
value. Startup and the upgrade check refuse another host or port, a disabled
`egressAuthority`, or file paths other than the chart mounts shown above, with
`CHART_LISTENER_MISMATCH`. The Backend requires HTTPS
with bearer-file or mutual TLS authentication. Register `oce-authority` under
`[[openshell.supervisor.middleware]]` with its HTTPS `grpc_endpoint`, `audience`,
`tls_ca_cert_path`, and `max_payload_bytes = 4194304`. Both peers must support
`openshell.supervisor-middleware.http-credential-access.v1` and all five capabilities
required by [connected qualification](../testing/static-egress.md#select-the-prepared-connected-lane).
Verify the Agent's WSS server trust separately from the controller's Backend mTLS;
an administrator client Secret must never be projected into the Agent. See
[trust prerequisites](../testing/static-egress.md#protected-launch-packaging).

With Helm, enable `egressAuthority`, set its `port`, `tlsSecretName` (`tls.crt`,
`tls.key`), and `issuerSecretName` (`public.pem`). Its `clients` must select the
actual Gateway and trusted supervisor namespaces and Pod labels. Allow those
peers to reach the authority and resolve DNS. Keep upstream access constrained
to the selected endpoints. The Gateway signing private key stays with the
Gateway; the authority receives its public key. All phases of an exchange must
reach the same authority process; replicated shared exchange state is unavailable.

For prepared GitHub access, use the separate
[protected repository configuration](../reference/repository-credentials/protected-openshell-git.md#configuration-for-a-qualified-release).
Only the worker receives the App signing key and persistent custody key. Do not
copy either into Agent configuration. The request-phase worker service and its
TLS port are separate from the static API authority above. A missing key,
unqualified sender, or unavailable trust path is a stop condition, not a reason
to use an ambient token.

<a id="register-authorize-and-deploy-a-static-source"></a>
<a id="register%2C-authorize%2C-and-deploy-a-static-source"></a>

## Register, authorize, and deploy an OpenAI static inference source

These steps require qualified static enforcement. Use the built CLI from the
repository root with `jq`, a ready Namespace, `OCC_URL`, `OCC_NAMESPACE`, and a
private `OCC_SERVICE_KEY_FILE` for an authorized operator.

Obtain whole-execution consent **before creating the source**: protection covers
sibling processes in that execution, not another execution of the same Agent.
Follow only the `openai` API-key example in
[Register the key](deploy/openshell-credential-sources.md#register-the-key), then
return here. Do not use that page's `codex-pat` variant for this profile, or follow
its copied-key rotation and Agent-deleting cleanup as a live-adoption procedure.
Retain `SOURCE_ID` and the Secret reference.

With Credential Proxy selected, fresh `openai` registration is already live:

```bash
./bin/occ credential-source get "$SOURCE_ID" -o json
```

Require `ownerCapability: credential_gateway`, `egress.adoption: live` and
`egress.retention: none`. Creation reads the versioned Secret without depositing
a Gateway copy. The CLI's `GATEWAY STATUS ready` label does not prove such a copy
exists. Keep the Gateway selected: live reads do not transfer ownership. A ready
source alone does not prove installed enforcement.

For an **existing unreferenced legacy or narrower source**, obtain the same
consent, then explicitly adopt live reads instead:

```bash
cat > source-adoption.json <<'JSON'
{"adoption":"live","authorityScope":"execution"}
JSON
./bin/occ credential-source update "$SOURCE_ID" --file source-adoption.json
./bin/occ credential-source get "$SOURCE_ID" -o json
```

This update requires exact source `update` and `operate` on every referenced
Secret, advances the source generation, and retains its Gateway owner. It does
not remove an old Gateway copy: `retention: none` describes live reads, not past
custody. A bound source cannot take this first cutover.

Follow [create the Agent and grant the source](deploy/openshell-credential-sources.md#create-the-agent-and-grant-the-source)
for the dedicated Codex Configuration, Agent request, and exact IAM binding.
Use an authorized native model ID; keep `models.providers.codex.baseUrl` at
`http://127.0.0.1:9`. The Agent lists `{ "sourceId": "$SOURCE_ID" }` in
`credentialSources` and names that source in `harnessAuth`. The creating operator
and Agent service principal each need exact source `operate`; the Agent needs
no underlying Secret permission.

```bash
./bin/occ agent runtime-credentials provision "$AGENT_ID"
DEPLOYMENT_ID="$(./bin/occ agent deploy "$AGENT_ID" -o json | jq -r .id)"
./bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID" -o json
./bin/occ agent get "$AGENT_ID" -o json
./bin/occ agent runtime "$AGENT_ID" -o json
```

Require the requested revision to succeed, become selected, and have a ready
runtime. Protected Compute checks the current installation before releasing the
workload. Do not bypass pending or failed admission.

## Enroll prepared GitHub access

Choose model authentication before enrollment. For bundled OpenShell v5/v6 Git,
use an existing ready Gateway Harness source **without `egress`**, named by
`harnessAuth.method: credential_source`; the protected static source above cannot
be reused beside Git. Gateway selection rejects an ordinary Secret-backed model
substitute. A capable exact-dispatch Driver with verified policy reduction v2
can instead admit Git alongside independently authorized routes as v7; see
[selection differences](../reference/drivers/selection.md#select-a-protected-sender).
Fresh static `openai` registration while Proxy is selected produces an egress
source. For the v5/v6 combination, retain a suitable existing ordinary source
or provision it in a supported Gateway-only installation before enabling Git.
If neither is available, stop before enrollment.
Neither configuration qualifies stock OpenShell. Native prepared Git is a separate
composition without Sandbox or Credential Proxy.

For a qualified protected repository sender, follow
[GitHub App installation access](../reference/repository-credentials/protected-openshell-git.md#grant-access-to-a-github-app-installation)
to make the App installation's scope available to the Namespace and select its
`repositoryRef` and `github-installation` profile in the Agent's
`repositoryBindings`. GitHub's installation membership and permissions set the
outer limit. Access is finite by default; standing access needs a separate
approval for that scope. The worker receives the signing and custody keys and
prepares tokens; the Agent does not receive them. Qualify the selected profile
before enrolling a real credential or enabling a protected revision.

## Verify use, loss, and withdrawal

Use [model verification](operate/model-verification.md) to send a fresh nonce
through the actual Agent. Its unauthenticated request must fail and its
administrator-authenticated request must return the nonce. That denial tests
Gateway authentication; it does not prove Credential Proxy enforcement.

For static inference, verify a valid `POST` to the configured base URL plus
`/responses` or `/chat/completions` with the exact admitted model. Attempt the same
request with a different model, and a `GET` to that inference route; both must be
refused by enforcement. Use a controlled origin with independent request logs,
and record the selected revision, enforcement refusal and **no new origin
request**. A provider error or an unready Harness does not establish that denial.

Save the successful response, then
withdraw the exact source through OCC:

```bash
./bin/occ agent credential-withdrawal request "$AGENT_ID" "$SOURCE_ID"
./bin/occ agent credential-withdrawal get "$AGENT_ID" "$SOURCE_ID" -o json
```

Inspect the withdrawal state and reason:

- **In-place removal:** wait for `revoked`. Make a fresh request through the same
  Agent; record the enforcement refusal and verify that no request reached the
  controlled origin.
- **Runtime retirement required:** if the reason is
  `CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT` and `revisionId` names a
  version other than the selected one, see
  [withdrawal](../reference/credential-sources/withdrawal.md#withdraw-a-source-from-an-agent).
  For the selected version, if `withdrawalInProgress` is `true`, wait for that
  attempt first: a version that just became selected gets one more attempt.
  Otherwise follow the
  [retirement procedure](deploy/credential-proxy-upgrade.md#stop-and-settle-before-upgrading).
  Observe retirement of the exact execution, record the actual withdrawal state
  and reason, and leave pending custody with its original owner. Do not restart
  that execution to test a refusal.

An upstream request already sent can finish. Credential Proxy can still withhold
a response it has not released; withdrawal cannot recall bytes already released.
A withdrawn model source
cannot support continued model turns. Restore service with an authorized
replacement binding and a new revision; restarting cannot restore withdrawn
permission. See [withdrawal](../reference/credential-sources/withdrawal.md).

For protected repository scope, use the admitted `<owner>/<repo>.git` path.
Verify discovery (`GET /<owner>/<repo>.git/info/refs?service=git-upload-pack`),
fetch (`POST /<owner>/<repo>.git/git-upload-pack`) and a push to the approved review
ref (`POST /<owner>/<repo>.git/git-receive-pack`). Independently read the written ref. A push to another
ref and `DELETE` on the same Git route must be refused before reaching the origin.
For installation-wide access, there is **no OCE ref allowlist**: GitHub controls
membership and permissions. Use an unsupported method such as that `DELETE` for
the OCE negative check; a GitHub `404` outside membership is not an OCE denial.
Capture the selected revision and correlated enforcement and origin evidence.
The [native Git example](../reference/repository-credentials/prepared-native-git.md)
applies only to its separate composition.

### Withdraw repository access

Token expiry, finite grant/session expiry and standing-approval removal are
different checks. For standing access, fetch a commit known to be absent locally
after the original token expires, without changing the binding. This checks
renewal; it cannot extend a finite grant. Then withdraw while the replacement
token and session are still valid:

1. As an Agent administrator, read
   `GET /namespaces/:namespaceId/agents/:agentId/repository-approvals`.
2. Select the approval for the current binding. Send
   `POST /namespaces/:namespaceId/agents/:agentId/repository-approvals/:approvalId/remove`
   with `{"expectedGeneration": <that approval's generation>}`. This is the
   **approval generation**, not the Agent, source or policy generation. Require
   `204`; on a conflict, read current approval state before deciding what to do.
3. Require a fresh fetch to fail with `access_withdrawn` before the token/session
   expires, with no new origin request. An already authorized send may finish.
4. Clear the binding using the existing Configuration ID:

   ```bash
   jq -n --arg configuration "$CONFIGURATION_ID" \
     '{configurationId: $configuration, repositoryBindings: []}' > repository-withdrawal.json
   ./bin/occ agent update "$AGENT_ID" --file repository-withdrawal.json
   ```

Removing the binding before standing approval is rejected. **For finite access**,
there is no standing approval to remove: use the binding-removal step directly
and verify fresh denial.

Require a new model reply in the same conversation after Git removal. Continuity
requires verified Git-only policy reduction and healthy independent model access;
an explicit model withdrawal or IAM refusal queues retirement of that runtime.
Unavailable evidence keeps cleanup pending without repeating the reduction or stopping
a healthy Agent. Stock OpenShell cannot currently
supply qualified proof of this workflow. Static model sources do not renew tokens;
existing Gateway refresh sources use their own
[rotation procedure](../reference/credential-sources.md#rotate-a-refresh-source).

## Diagnose before retrying

| Observation                                       | Action and recovery evidence                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source `failed`, `absent`, or missing credentials | Read `credential-source get` and its `reason`; correct the owning Secret or enrollment. Require a new successful real request, not just `ready`.                             |
| Unavailable authority or lost installation        | Check peer TLS trust, selected Driver identity, network access, and current runtime. Keep access closed until the current installation is verified.                          |
| Prepared material is pending or expired           | Check worker custody and issuer access. Requests and readiness cannot trigger issuance. Wait for worker recovery and verify a new allowed request within existing authority. |
| Refresh reports `reauthorize`                     | Obtain new provider authorization through the source's supported enrollment; do not replay an old refresh token.                                                             |
| Installation or send outcome is unknown           | Preserve the original operation and custody. Fence the old worker/recipient and reconcile through its owner; do not resend or fabricate success.                             |
| Withdrawal remains `pending`                      | Inspect its reason and `withdrawalInProgress`; follow the withdrawal recovery procedure. Do not report revocation as complete.                                               |

Public deployment status is not a token-custody ledger. If the selected owner
cannot establish whether issuance, installation, or retirement completed, stop
the transition and retain its recovery state. Do not edit database rows as an
operator workaround. For Git reason codes and log correlation, see
[adapter diagnostics](../reference/repository-credentials/protected-openshell-git.md#diagnose-a-refused-request).
Detailed enforcement evidence belongs in
[qualification procedures](../testing/protected-repository-custody.md).
