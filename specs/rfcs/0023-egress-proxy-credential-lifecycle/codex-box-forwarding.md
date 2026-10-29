---
rfc: index.md
---

# Proposed Codex credential forwarding through Box

This amendment is a draft for submission, not authorization to implement or
enable the path. It extends the [Credential Proxy proposal](index.md) to the
ordinary Box Sandbox. Keep the current refusal until this amendment is submitted
and the native sender dependencies below are implemented and verified.

## Decision and existing behavior

OCE owns the account mapping, grant, expiry, credential replacement and delivery
to the trusted sender. Box forwards requests and enforces containment. It must
not gain an OAuth issuer, refresh service, login store or account-specific
configuration. The Codex Harness receives only a non-secret routing marker and
authenticated account metadata. Only the OCE-owned sender receives the real
access token. Its owner rotates or replaces that token outside the request path;
the Harness and Box receive no refresh token.

The reserved wire value is `Authorization: Bearer <accessTokenPlaceholder>`.
The trusted sender compares the single header value with the exact non-secret
placeholder from this execution's admitted `externalChatgptAuth` attachment.
The placeholder conveys no grant. Select the account and credential source
from the live binding. Reject a missing or altered marker, duplicate
authorization, or a conflicting caller-supplied account header before material
use. After the final allow, replace the marker with the selected token for
the admitted upstream; the workload's authentication fields never become
upstream credentials.

Reuse the [external ChatGPT contract](../../../docs/reference/drivers/credential-gateway.md#external-chatgpt-authentication)
and the ephemeral Codex auth file. Do not treat a ChatGPT account token as an API
key or PAT. Preserve the API-key path and its explicit direct-delivery boundary.

At OCE `23609228f3dbbc859df481ba9c66f43e9eabf5bf`, the external supplier is
the OpenShell `codex-oauth` profile. That profile uses provider-owned refresh;
it does not establish an OCE-owned, manually replaced access-only supplier.
No `codex-account` identifier is present in that Git tree. Integration must
identify the supplier's actual source revision and supported contract before
claiming access-only support. Do not copy the OpenShell refresh profile and
rename it to imply different custody.

## Literal affected rules

The old rules below describe the Box source at
`9c921957c8ff97813f8e39b3a15208f6726a8e62`. The proposed rules do not change
the public external-auth attachment fields or their ownership.

| Boundary | Old rule | Proposed rule |
| --- | --- | --- |
| Sandbox admission | `provisionHarness` rejects every nonempty `credentialAttachments` array. | Admit an external-auth attachment only when the selected OCE supplier and native sender support it and the execution's protected route is established. Reject other unsupported attachments. |
| Box resource preparation | `strandsBoxResources` accepts only `api_key` and `codex_pat`, with no credential attachments. | Also accept `chatgptAuthTokens` with a validated protected attachment. Forward the exact non-secret marker and authenticated account metadata; never project a real access token. |
| Startup release | Ordinary Box starts the supplied command without establishing a protected credential route. | Hold both Codex consumers until the native supervisor and OCE sender establish the admitted execution and route. An absent or mismatched route fails closed. |
| Supplier custody | The existing OpenShell OAuth supplier owns refresh and token injection. | The selected OCE supplier owns the access-only token and account binding; its trusted sender alone applies it at the approved destination. Box does not resolve or renew it. |

The [Compute attachment validation](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
must continue to select the exact source and reject incompatible metadata.
The [Codex entrypoint](../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
must continue to run the separate authenticated model probe before serving.
Its temporary `auth.json` contains the marker, account metadata and an empty
refresh token. Both the probe and hosted app-server use that same admitted
identity, not independently supplied logins. Auth state is not workspace data.

## Native sender dependency

The native sender owner must supply the execution-bound route, supervisor
identity verification and fail-closed forwarding before Box admission changes.
The route must cover the selected Codex account, inference and hosted requests
that the pinned runtime requires. Optional background traffic does not justify
adding destinations. OCE checks the exact grant, account, expiry and destination
before using the token. A token or metadata mismatch is a refusal, not fallback
to an ambient credential or another account.

Withdrawal, expiry and sender failure must deny new credential use on existing
connections as well as new ones. Replacement must retain the admitted account
and current authority. Bind responses to the initiating execution; do not deliver
an old response to its successor. Apply the parent RFC's selected
[protection level](index.md#two-levels-of-protection); forwarding alone does not
prove exact dispatch. An unknown provider effect remains unknown and must not
trigger an automatic resend.

## Required proof before enablement

Use the actual supported OCE supplier, attachment preparation, Box launch and
pinned native Codex entrypoints. A hand-written replacement supplier or a hosted
login RPC acceptance is insufficient.

- A synthetic local allowed case must pass the separate startup probe and then
  reach the hosted process through the same binding. Verify the controlled origin
  sees the expected account and that Box and the Harness cannot read the token.
- Missing, expired, revoked and wrong-account fixtures must fail before protected
  provider bytes are sent. Exercise both actual consumers, including withdrawal
  after startup and replacement while serving.
- Missing sender, wrong supervisor identity, wrong execution, disallowed endpoint
  and direct egress must fail closed. Check reused connections and successor
  response fencing as required by the selected protection level.
- Preserve ordinary API-key behavior. The current `strands-sandbox` QA fixture
  replaces an exclusive API-key Secret; it must not overwrite an OCE credential
  source. A protected scenario needs its own authorized source lifecycle and
  cleanup, while preserving both Agents' independent grants and storage.

Local synthetic proof does not establish provider acceptance or installed
containment. Those require separately authorized operator runs with the exact
joined source and image identity. Submission, implementation, native proof and
live qualification remain separate milestones.


For the positive installed check, require the authenticated startup probe and a
subsequent model turn through the hosted process to use that same admitted
binding. Independently observe the intended account and synthetic credential
at the controlled endpoint for each operation and verify the original Agent
receives the hosted model response. Repeat with an altered marker, duplicate
authorization and conflicting account fields; observe no credential use or
protected upstream submission.
