---
rfc: index.md
---

# Move an existing Codex PAT Source to TokenService

This amendment proposes moving an existing Codex personal access token (PAT) Source from Credential Gateway to the selected TokenService without changing the Source ID, Namespace, or IAM grants. An operator first stops and detaches the affected Agents, then adopts the Source and deploys new revisions. The Source becomes `static`, and TokenService holds the PAT. Dedicated Codex receives a Credential Proxy placeholder and continues to authenticate as `personalAccessToken`.

## Ownership and migration

Migration preserves the existing Agent, service principal, Configuration, IAM grants, and revision history:

1. **Stop and detach consumers.** Wait for Stop to finish, the active revision to clear, and its egress installation to retire. Update the Agent with its current Configuration ID, set `harnessAuth: null`, and remove the Source from `credentialSources` if listed. Finish any pending withdrawal or cleanup. Refuse adoption while a draft, active or pending revision, provisioning job, or unsettled authorized send can still use the Source. Stop alone does not detach the draft.
2. **Authorize adoption.** The OpenClaw Control Plane (OCC) checks Source `update` and `operate`, and Secret `operate` on the Source's recorded same-Namespace `access_token` Secret. OCC selects the TokenService instance, records the admission intent, and commits its transaction before calling TokenService.
3. **Transfer custody.** TokenService starts its ordinary Source mutation transaction and locks the Source. It rechecks the Namespace, ready state, Gateway owner, `codex-pat` type, exact Secret reference, and absence of live references or unsettled sends. Attachment admission uses the same Source lock. TokenService reads the authorized Secret through its selected Secret Driver and stores the PAT privately under the existing Source ID. It then asks the recorded Gateway owner to retire the old Provider and confirms its absence before changing ownership; the old and new Providers must not overlap.
4. **Commit the owner change.** Under the same lock, TokenService removes the Source-to-Secret reference and changes the existing Source to `ownerCapability: token_service`, `type: static`, the selected instance, the Codex PAT preset, and ready state. It commits before returning sanitized Source metadata. The original Namespace Secret remains unchanged. The operator can then rebind the same Source to the same Agent and deploy a new revision.

Inactive revisions and settled receipts remain unchanged and retain their original Gateway owner and execution details. They do not authorize another attachment or dispatch. Any send that could still dispatch this Source must settle under its original owner before adoption; a receipt with no selected material cannot authorize dispatch.

The database needs a restricted transition because ordinary Source updates cannot change owner, type, or instance identity. Private custody and Gateway retirement are outside that transaction. A failure can leave orphan custody material or remove the old Provider before the owner change commits. Report failure and reconcile the known Provider and custody reference before retrying. The unchanged Namespace Secret is the recovery input; do not claim cross-store rollback or automatic orphan discovery.

Existing PAT Secret and issued ServiceAccount broker paths are unchanged. [Codex device login](codex-device-login.md) remains a separate OAuth path.

## PAT recipient and enforcement

The trusted runtime selects the dedicated Codex executable, `CODEX_ACCESS_TOKEN`, Bearer presentation, and PAT login mode. An Agent network grant can restrict this executable's requests; it cannot select or enlarge the credential recipient. Admission checks both network access and credential injection for these HTTPS requests on port 443:

| Host              | Method | Path                                           |
| ----------------- | ------ | ---------------------------------------------- |
| `auth.openai.com` | `GET`  | `/api/accounts/v1/user-auth-credential/whoami` |
| `chatgpt.com`     | `GET`  | `/backend-api/codex/models`                    |
| `chatgpt.com`     | `POST` | `/backend-api/codex/responses`                 |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/config/bundle`              |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/accounts/check`             |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/settings/user`              |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/usage`                      |

Query parameters must not widen these paths. Do not inherit the old `/backend-api/codex/**` selector, allow WebSocket upgrades through REST rules, or include OAuth or hosted Plugin/App endpoints. The current Codex launcher can fall back to HTTP. The requests come from [OCC model discovery](../../../apps/controller/src/drivers/compute/model-discovery.ts) and Codex 0.164's [PAT login](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/personal_access_token.rs), [backend](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/backend-client/src/client.rs), [models](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/models.rs), [rate limits](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/backend-client/src/client/rate_limit_resets.rs), and [Responses](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/responses.rs) clients.

Worker resolves the Source through TokenService; Credential Proxy creates and updates its native Provider. Compute passes only the stable placeholder. The launcher writes an ephemeral PAT auth file, and Sandbox readiness checks that the serving app-server reports `personalAccessToken`. Missing authority, a mismatched preset or executable, failed login, or unready delivery prevents activation. There is no API-key fallback.

**Open qualification:** OpenShell's [transport-scheme limitation](codex-device-login.md#renewal-and-delivery) needs separate PAT qualification. The existing OAuth exception does not approve PAT delivery.

## Interface changes

### API

Add an adoption operation for an unbound Gateway `codex-pat` Source. Return sanitized Source metadata. Add Codex PAT to static Source permitted-use selection.

### IAM

No new actions. Use the exact Source and Secret permissions above and preserve existing IAM bindings.

### Database entities

Permit only the verified owner/type/instance transition and Source-to-Secret reference removal. Do not create a second Source or rewrite history.

### Driver contract

Add optional TokenService `adoptSource` for the existing Source identity. Its inputs identify the Source, expected Gateway and Secret, selected instance, preset, authorized Secret-read and Gateway-retirement callbacks, and cancellation. TokenService owns the transaction and returns the adopted Source. Refuse unsupported Drivers; `createSource` remains for new enrollment.

Add optional fourth argument `modelPreset?: SourceProviderPresetId` to Compute's `resolveHarnessConfiguration`. Admission derives it from the locked Source before building the preset. Compute uses it to distinguish Codex PAT from an OpenAI API key and reject incompatible `modelProvider` overrides. Do not persist another copy. Credential Proxy and Sandbox reuse the [staged deployment contract](worker-credential-configuration.md).

## Simplifications

Reuse static custody, Source IAM, and ordinary Proxy push. Specialize only the Codex preset and login mode; add no PAT Source type or OAuth refresh mechanism.

## Acceptance criteria

- Through authenticated Fastify and PostgreSQL, prove Stop, detach, adoption, and redeployment preserve Source and Agent identities, grants, history, and the Namespace Secret. Verify one custody record, removal of the old reference, a sanitized response, and refusal of unauthorized or live transfers, wrong owners, unavailable inputs, failed retirement, and uncertain custody or commit.
- Through ordinary Agent deployment, verify the trusted executable, exact request policy, native Provider delivery and Source-update push, placeholder-only startup, and serving-process `personalAccessToken` readiness. Invalid authority, policy, or login must prevent activation.
- Separately qualify a genuine Codex model turn and native Git on the final candidate. PostgreSQL and controlled transport checks do not prove live enforcement or authentication.
