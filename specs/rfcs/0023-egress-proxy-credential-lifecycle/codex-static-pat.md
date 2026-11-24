---
rfc: index.md
---

# Move an existing Codex PAT Source to TokenService

This proposed amendment moves an existing Gateway-owned `codex-pat` model Source to the selected TokenService and Credential Proxy without changing its Namespace, Source ID, or IAM grants. Migration stops and detaches old deployments first; it preserves the Agent and its inactive revision history rather than converting a running revision in place. TokenService keeps one canonical `static` Source and credential. Dedicated Codex continues to authenticate as `personalAccessToken`; it receives a Proxy placeholder, never the real PAT. The [worker configuration amendment](worker-credential-configuration.md) supplies the staged lifecycle. [Codex device login](codex-device-login.md) remains a separate OAuth path.

## Ownership and migration

The smallest safe migration is an unbound transition that preserves the Agent. For each affected Agent, an operator requests ordinary Stop and waits for the worker to confirm that every admitted runtime has stopped, retire its current egress installation, and clear the active revision. The operator then updates the existing Agent using its current Configuration ID and `harnessAuth: null`, and removes this Source from `credentialSources` if it was explicitly selected there. This leaves the Agent ID, service principal, IAM grants, Configuration, and revision history intact. If a Source withdrawal was requested, its ordinary cleanup must finish as well. OCC refuses migration while a draft binding, active revision, queued or claimed revision work, queued or running provisioning, or unresolved withdrawal or cleanup can still use the old Source. Stop alone does not detach the draft, and a Stop still in progress is not cleanup proof.

An inactive historical revision is not a blocker once its workload has stopped and its installation is retired. It continues to pin its original `credentialGatewayId`, `sourceType`, Provider identity, and admitted policy. A retired installation receipt preserves its installed plan and execution; a settled send receipt preserves its original Source generation, backend, Provider, execution, and outcome. They are evidence, not authorization to attach or dispatch again. A send receipt with an authorized possible dispatch for this Source must settle under its original owner before ownership changes; its recorded material identifies the exact Namespace and Source. A receipt with no selected material cannot authorize credential dispatch. Do not rewrite old snapshots or receipts to point at TokenService. New binding and deployment must create a new revision under the new owner.

After cleanup, OCC authorizes exact Source `update` and `operate` and Secret `operate` on the Source's recorded same-Namespace `access_token` input. OCC verifies the selected TokenService instance, records intent, and ends its admission transaction before invoking TokenService. TokenService uses its ordinary bounded Source mutation transaction for the following sequence; it holds the Source lock from the recheck through the metadata commit:

1. Lock the existing Source and recheck its Namespace, ready state, Gateway owner, `codex-pat` type, exact Secret reference, and absence of the live references and unsettled authorized sends above. New Source attachment admission must acquire the same lock.
2. Read only the authorized, recorded same-Namespace `access_token` Secret through its selected Secret Driver, and place that value in TokenService's private custody under the existing Source ID. TokenService cannot resolve the still-Gateway-owned Source through its normal Source resolver. Do not change or delete the Namespace Secret.
3. Ask the recorded Gateway owner to retire the exact old Provider and confirm that it is absent. Gateway retirement and the new native Provider cannot overlap; both otherwise use the Source-derived Provider identity.
4. Remove the Source-to-Secret reference row, then change the same Source record to `ownerCapability: token_service`, `type: static`, the selected instance ID, the reviewed Codex PAT permitted-use preset, and ready state. Commit the TokenService mutation before reporting the sanitized Source. Preserve its IAM bindings and ID; do not call new-Source enrollment.

The database currently makes owner, type, and instance identity immutable and does not allow application deletion of the Source-to-Secret row. A reviewed restricted transition must permit only this exact verified change; it must not weaken ordinary Source updates. The private Secret store and Gateway are outside the database transaction. A failed or uncertain write can leave private orphan material, or the Gateway Provider can be absent while the database still records the old owner. The unchanged Namespace Secret remains the recovery input. Report failure, retain the original Source/IAM identity, and reconcile the exact known Provider and custody reference before retrying; do not claim atomic rollback, automatic orphan discovery, or successful migration. After migration, an authorized caller can rebind the same Source ID to the same Agent and deploy a new revision.

Existing PAT Secret and issued ServiceAccount bindings retain their current broker and identity behavior. This amendment does not flatten issued accounts into generic Sources or add OAuth refresh.

## PAT recipient and enforcement

The approved model operation selects dedicated Codex, PAT login mode, `CODEX_ACCESS_TOKEN`, Bearer presentation, and the Codex executable from trusted configured runtime/Driver policy. Network grants never choose or enlarge the executable recipient. Admission separately checks the network grant and credential injection policy for that exact executable and each approved request. A missing configured executable, an unsupported match, a mismatched Source preset, or unready delivery prevents activation.

Admit these exact HTTPS operations on port 443:

| Host              | Method | Path                                           | PAT operation                                                            |
| ----------------- | ------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `auth.openai.com` | `GET`  | `/api/accounts/v1/user-auth-credential/whoami` | Validate and hydrate PAT account identity.                               |
| `chatgpt.com`     | `GET`  | `/backend-api/codex/models`                    | Discover available Codex models; query parameters do not widen the path. |
| `chatgpt.com`     | `POST` | `/backend-api/codex/responses`                 | Run the model turn over HTTP.                                            |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/config/bundle`              | Load managed configuration.                                              |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/accounts/check`             | Resolve account and workspace routing.                                   |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/settings/user`              | Load user settings and attribution.                                      |
| `chatgpt.com`     | `GET`  | `/backend-api/wham/usage`                      | Read rate limits.                                                        |

These methods follow the [PAT discovery caller](../../../apps/controller/src/drivers/compute/model-discovery.ts) and the pinned Codex 0.164 [PAT login client](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/personal_access_token.rs), [backend client](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/backend-client/src/client.rs), [model catalog client](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/models.rs), [rate-limit client](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/backend-client/src/client/rate_limit_resets.rs), and [HTTP Responses client](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/responses.rs). Do not inherit the Gateway's broader `/backend-api/codex/**` selector or admit WebSocket upgrade through a REST rule; the current Codex launcher has a bounded HTTP fallback. Hosted Plugin and App routes belong to their separate consumers. No OAuth authorize, token, refresh, or revocation endpoint is part of this PAT operation. The transport-scheme limitation documented for [Codex device injection](codex-device-login.md#renewal-and-delivery) also needs explicit PAT qualification; its OAuth-specific exception does not establish PAT acceptance.

The worker uses the existing source-bound TokenService resolver and selected Credential Proxy. The Proxy delivers and updates the Source-owned native Provider through the existing deployment and source-update operations. Compute installs only the stable placeholder; the launcher writes the ephemeral PAT auth file and checks native login. Sandbox readiness verifies `personalAccessToken` in the serving app-server, rather than treating a launcher login check as proof that the serving process authenticated. No API-key fallback is permitted.

## Interface changes

### API

Add an explicit migration operation for an existing unbound Gateway `codex-pat` Source. Refuse live references and unresolved authorized dispatch or cleanup before transfer; permit inactive retained history after confirmed stop and retirement. The response is the same sanitized canonical Source; it never returns material. Extend static Source permitted-use selection with the reviewed Codex PAT operation.

### IAM

No new action or grant identity. Require the existing exact Source and credential-input permissions before custody or delivery effects; preserve the Source's existing IAM bindings and Agent authorization.

### Database entities

No second Source or account record. Add the restricted owner/type/instance transition and Source-to-Secret reference removal required above. Preserve the Source and IAM identities, the Namespace Secret, and immutable historical receipts. Do not rewrite admitted revision snapshots.

### Driver contract

Add one TokenService adoption operation for an existing Source identity. It accepts the admitted Source reference, expected Gateway owner and Secret reference, selected instance, reviewed static preset, a callback bound to the authorized Secret Driver read, an exact Gateway-retirement callback, and cancellation. TokenService owns the transaction, Source lock, custody, restricted owner transition, and returned Source. `createSource` continues to allocate identities only for new enrollment. Reuse Credential Proxy deployment/update and Sandbox staged operations; qualify the exact PAT recipient, requests, placeholder launch, and serving-process authentication observation.

## Simplifications

Keep one typed static custody path and specialize only the approved model operation and login mode. Do not introduce a second PAT Source type, an account-identity alias, an OAuth refresh owner, or a model-specific Proxy implementation.

## Acceptance criteria

- Through authenticated Fastify and PostgreSQL, refuse migration while an Agent draft, active or pending revision, provisioning, withdrawal, cleanup, or unsettled authorized send can still use the Source. Stop and detach the draft through the real Agent callers, retain inactive historical revisions and receipts unchanged, then migrate the Gateway `codex-pat` Source. Verify the same Agent ID, service principal and IAM grants; the same Source ID, Namespace and IAM grants; unchanged Namespace Secret; removed Source-to-Secret row; one TokenService custody record; and sanitized response. Rebind the same Source to the same Agent and prove that a new revision uses TokenService while the historical revision cannot attach or dispatch. Exercise permission denial, wrong owner, unavailable input, failed retirement, and uncertain custody/commit without reporting success or creating a duplicate Source.
- Through the ordinary Agent deployment caller, verify admission uses the configured Codex executable and exact approved endpoint/method matches. A network grant for another executable or destination must not select the recipient or activate the Harness.
- Verify native Provider delivery and post-commit Source update through the selected Proxy. The dedicated launcher receives only a placeholder and the serving app-server reports `personalAccessToken`; failed login or readiness remains non-serving.
- Qualify a real Codex model turn and the existing ordinary native Git composition separately on the final cutover candidate. PostgreSQL or controlled transport coverage alone does not prove native enforcement, external authentication, or Git execution.
