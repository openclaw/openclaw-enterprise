---
rfc: index.md
---

# Enroll a Codex PAT in TokenService

An operator enrolls a Codex personal access token (PAT) as a new static Source in the selected TokenService. Dedicated Codex receives a Credential Proxy placeholder and authenticates as `personalAccessToken`. Hosted Apps discovery uses the same authorized Source and obtains account identity from the PAT issuer.

## Ownership and cutover

An operator stops affected Agents and settles pending deployment, withdrawal, or dispatch before cutover. Cutover clears obsolete Gateway selections and deletes the old Source records and their Source-specific links. It preserves Agents, Namespace Secrets, and inactive revision history. OpenShell Providers can retain usable old credentials. The OpenShell operator inventories and removes any retained copies and profiles and verifies their absence.

For an Agent bound directly to a PAT Secret, the operator re-enters the PAT through ordinary Source enrollment before using hosted Apps. The replacement Source receives a new ID and ordinary Source grants. The operator binds it to the Agent draft and deploys a new revision. [Codex device login](https://github.com/openclaw/openclaw-enterprise/blob/c561b70b559dbce49d53c0842b30e8d3ca0f319a/specs/rfcs/20261124-credential-design-1-0/codex-device-login.md) remains a separate OAuth path.

## Issue a new PAT from a ChatGPT ServiceAccount

OCC checks exact ServiceAccount update and Namespace Source create permissions before asking the ServiceAccount Driver to mint. The Driver passes the freshly issued bearer in-process to the selected TokenService's existing static Codex PAT enrollment. The API returns the Source reference. The Agent uses ordinary exact Source operate grants.

TokenService commits custody in its own Namespace transaction. The ServiceAccount issuance flow resumes to record the Source reference and issuer receipt, then audits completion. On a failed enrollment, the issuer revokes the new credential. The ServiceAccount Driver retains the private issuer credential ID for exact revocation and removes the upstream credential when the ServiceAccount is deleted. A managed binding cannot be replaced or discarded through generic static Source mutation. TokenService holds the sole stored bearer. Existing issued Secret credentials require replacement through fresh issuance.

## PAT recipient and enforcement

The trusted runtime selects the dedicated Codex executable, `CODEX_ACCESS_TOKEN`, Bearer presentation, and PAT login mode. An Agent network grant can restrict this executable's requests; it cannot select or enlarge the credential recipient. Admission checks both network access and credential injection for these HTTPS requests on port 443:

| Host              | Method        | Path                                           |
| ----------------- | ------------- | ---------------------------------------------- |
| `auth.openai.com` | `GET`         | `/api/accounts/v1/user-auth-credential/whoami` |
| `chatgpt.com`     | `GET`, `POST` | `/backend-api/codex/**`                        |
| `chatgpt.com`     | `GET`         | `/backend-api/wham/config/bundle`              |
| `chatgpt.com`     | `GET`         | `/backend-api/wham/accounts/check`             |
| `chatgpt.com`     | `GET`         | `/backend-api/wham/settings/user`              |
| `chatgpt.com`     | `GET`         | `/backend-api/wham/usage`                      |

Allow any query parameters on these PAT requests. The subtree selector includes the base and descendants for GET and POST. It reuses the old Gateway Codex subtree and can authorize more operations than model discovery and inference. Do not allow WebSocket upgrades through REST rules or include OAuth or hosted Plugin/App endpoints. Codex can use the HTTP Responses transport instead of WebSocket. The requests come from [OCC model discovery](../../../apps/controller/src/drivers/compute/model-discovery.ts) and Codex 0.164's [PAT login](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/personal_access_token.rs), [backend](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/backend-client/src/client.rs), [models](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/models.rs), [rate limits](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/backend-client/src/client/rate_limit_resets.rs), and [Responses](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/responses.rs) clients.

Worker resolves the Source through TokenService; Credential Proxy creates and updates its native Provider. Compute passes only the stable placeholder. The launcher writes an ephemeral PAT auth file, and Sandbox readiness checks that the serving app-server reports `personalAccessToken`. Missing authority, a mismatched preset or executable, failed login, or unready delivery prevents activation. There is no API-key fallback.

**Open qualification:** OpenShell's [transport-scheme limitation](https://github.com/openclaw/openclaw-enterprise/blob/c561b70b559dbce49d53c0842b30e8d3ca0f319a/specs/rfcs/20261124-credential-design-1-0/codex-device-login.md#renewal-and-delivery) needs separate PAT qualification. The existing OAuth exception does not approve PAT delivery.

## Interface changes

### API

Add Codex PAT to static Source permitted-use selection. Accept an authorized TokenService Source reference for hosted Apps discovery. Return a Source reference from ChatGPT ServiceAccount credential issuance.

### IAM

Use the existing Source creation and use permissions and the existing Agent binding permissions.

### Database entities

Use the existing static Source state. Cutover clears obsolete Agent draft selections and removes the Gateway-owned Sources and their Source-specific links. Keep the ordinary owner, type, and instance immutability guards.

### Driver contract

Reuse TokenService `createSource` and `resolveCredential`. The ChatGPT ServiceAccount Driver hands off a transient bearer and returns a managed Source reference instead of a Secret reference. Retain issuer-owned revocation. Withdraw the proposed `adoptSource` operation.

Add optional fourth argument `modelPreset?: SourceProviderPresetId` to Compute's `resolveHarnessConfiguration`. Admission derives it from the locked Source before building the preset. Compute uses it to distinguish Codex PAT from an OpenAI API key and reject incompatible `modelProvider` overrides. Do not persist another copy. Credential Proxy and Sandbox reuse the [staged deployment contract](https://github.com/openclaw/openclaw-enterprise/blob/c561b70b559dbce49d53c0842b30e8d3ca0f319a/specs/rfcs/20261124-credential-design-1-0/worker-credential-configuration.md).

## Simplifications

Reuse static custody, Source IAM, and ordinary Proxy push. Specialize only the Codex preset and login mode; add no PAT Source type or OAuth refresh mechanism.

## Acceptance criteria

- Through authenticated Fastify and PostgreSQL, enroll a PAT as a static Source, bind it to an Agent, and verify that hosted Apps gets its account identity from the issuer. Check permission denial before hosted requests and preserve Namespace Secrets and inactive revisions during cutover.
- Through authenticated ServiceAccount issuance, verify that a caller missing Source create cannot mint, a new Source binds as the Codex PAT, and a failed enrollment revokes the minted credential. Verify issuer revocation on ServiceAccount deletion.
- Through ordinary Agent deployment, verify the trusted executable, admitted request policy, native Provider delivery and Source-update push, placeholder-only startup, and serving-process `personalAccessToken` readiness. Invalid authority, policy, or login must prevent activation.
- Separately qualify a genuine Codex model turn and native Git on the final candidate. PostgreSQL and controlled transport checks do not prove live enforcement or authentication.
