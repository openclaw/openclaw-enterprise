---
rfc: index.md
---

# From first clone to token retirement

This companion to [the proposal](index.md) describes the intended behavior. [Earlier results](acceptance.md#delivery-and-verification) predate the [TokenService and native Credential Proxy cutover](https://github.com/openclaw/openclaw-enterprise/commit/105ffee9962176cf42fc7cfe013b8b94831435db).

## Install and start without a GitHub App

For a fresh local installation, propose `occ dev up --github-repo acme/docs`. Supply one fine-grained PAT on standard input. The launcher handles the Source ID and registry configuration internally.

1. Require a full, lowercase `owner/name`. Use the native registry’s name-only form where supported and reject short names. Select Kubernetes and OpenShell for this local profile. Verify compatible images and network isolation before enrollment. Create and verify a fresh local target and Namespace. Refuse an existing or shared target before sending any credential or changing its configuration.
2. Verify the authenticated OCC endpoint belongs to that target. Read the PAT without echo. Send it only in the Source creation request for that Namespace. Never forward it to GitHub for verification or pass it in arguments, environment variables, Helm values, files or logs.
3. Check the returned Source ID, Namespace, ready state, preset and single-repository Read ceiling. Use that ID for the native Git registration. Set the Installation ceiling to Read for that repository. Replace only the launcher’s known uninspected Git rule. Refuse overlapping rules that could admit other traffic. Apply the required local configuration and wait for the controller and Worker to load it.
4. Check the effective repository catalog. Report success only if the intended repository is available for Git Read through that Source, with no Write or API access. Show the Namespace and how to save an Agent grant. No Agent receives a grant during setup.

Use the native Credential Proxy and keep the separate repository broker off. Do not relax network policy or fall back to another credential. On partial failure, report which steps completed and how to inspect the local state before retrying. An unknown create result must never trigger a second enrollment.

A PAT-only installation needs no GitHub App Client, signing key or App key mount. Preserve key validation on the App path. The earlier prepared Git deployment used Helm key settings. They are not prerequisites for the proposed native flow.

## Register and read a Source

On an existing installation, check the active target and Namespace first. The proposed `occ credential-source create --github-repo acme/docs` reads the PAT from standard input and calls `POST /namespaces/{namespaceId}/credential-sources`. It sets `type` to `static`, `config.provider_preset` to `github` and `config.repositories` to `acme/docs:read`. On current main the write-only `secret` is a single string. The earlier #7152 implementation expects an object. Adapt enrollment to the current contract before enabling this shortcut. Return sanitized metadata. Enrollment alone leaves the registry, Installation ceiling and Agent grants unchanged.

Neither command reads `gh auth` or imports an OAuth login. The [standalone development client](../../../docs/guides/repository-credentials/development-token.md) is a separate workflow. The operator verifies actual permissions in GitHub on enrollment and replacement. GitHub attributes a push to the token owner.

For explicit Write or multiple repositories, use the [managed static Source API](../../../docs/reference/credential-sources/managed-static.md) with the proposed preset and repository ceiling. An administrator sets `credentialSource` to the returned ID in the Namespace registry and applies the change with Helm. Changing the Source invalidates the saved grant. App grant identities stay unchanged.

A registration selects a Source in its own Namespace with `profiles: ["github-repository"]`, `nativeGit: "v1"` and only metadata and contents permissions. It rejects registration-level `apiLimits`, `scopedRest`, `allowStandingApproval`, `pushRefAllowlist`, `transport`, `pullRequestBase` and `draftPullLimit`. Saved API limits cannot enable REST on a Git-only Source. Registry fields `appId` and `githubInstallationId` are optional together. Without them every registration must name a Source.

`GET .../sandbox-policy/networking` adds `repositoryCredential`. App selections return `{ kind: "github_app" }`. With exact Source read access, callers see `{ kind: "credential_source", id, name, state, ceiling }`, effective access and [delivery by running revision](lifecycle.md#replace). Others see only `{ kind: "credential_source", readable: false }` plus the usual saved grants, version and Installation ceiling.

## Save and deploy

| At save, validation and deployment                                 | Result                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Source missing, unready or wrong Namespace, TokenService or preset | `409`                                                               |
| Caller or Agent principal lacks Source `operate`                   | `403`                                                               |
| Grant exceeds the Source's list                                    | `409` on `/repositoryNetworkPolicy`                                 |
| Two Sources or a Source and an App                                 | `409`                                                               |
| Selected registrations have different permissions                  | `409` naming the difference                                         |
| Deploy with missing or empty saved policy                          | `409` on `/repositoryNetworkPolicy`. No fallback to legacy delivery |

Create and replacement reject a token of the wrong class, an oversized value or a value containing the reserved placeholder marker before storage. Reject a Connection Template association and refuse this Source in Plugin, Harness and model delivery. Check the actual GitHub permissions again on replacement. Even on an unbound Source, changing to or from the `github` preset or clearing its configuration returns `409`. Change the repository list separately from the token and only while no registration names the Source.

## Record installed copies

In the transaction that queues deployment, OCC records the Source ID, TokenService instance, Namespace, Agent and revision. Even a queued deployment can leave a copy behind. The Worker adds the Provider name and records each write before sending it, the Source version it sent, whether the Sandbox confirmed it and whether the write's outcome is unknown. Keep this evidence through execution cleanup. Reuse native delivery records wherever possible. TokenService remains the sole owner of the Source and its value. Main already uses migrations 0095 and 0096. Any additional schema must extend the current catalog without reusing those numbers.

At Stop, replacement or retirement of a revision, or if deployment ends without a Sandbox, the Worker checks that the Provider is gone before marking the copy retired. OpenShell cannot delete a Provider while a Sandbox uses it. If a Sandbox still holds it or the Gateway cannot answer, the Worker records the reason. It retries during cleanup and after restart. On startup it checks every unretired copy whose revision no longer runs.

## Replace

For routine rotation, the operator sends a new `secret` to `PATCH /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`. The same checks apply as at [registration](index.md#enrol-the-source). A rejected value leaves the old one in use.

| What the operator sees | What happened                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replacement committed  | TokenService stored the value under a new random version. `PATCH` returns `200`. A Sandbox can still use the old token.                                                                                 |
| `pending`              | The native Git runtime checks for a new version and updates the existing Provider. The Worker is waiting for the target Sandbox to apply the change.                                                    |
| `confirmed`            | The Worker read the target supervisor's report through OpenShell. Credentials are installed, the Provider resource version and environment revision match, and the bound policy is active and verified. |
| `unreconciled`         | The Worker cannot tell how a write ended. Stop or redeploy the affected Agent to retire the copy.                                                                                                       |

For a routine rotation, read the policy and wait for `confirmed` on every running revision using the Source before revoking the old token at GitHub. For a compromised token, revoke it at GitHub immediately, even if that interrupts other users of the token.

## Serialize Provider writes

Serialize replacement and deletion with authorization, version checks and conditional Provider writes. Check current authority before dispatch and confirm the version before recording success. Send nothing if the Source or Provider changed, the Source is no longer ready or the Worker lost the right to write. Set the expiry at the authority check.

The [earlier delivery implementation](https://github.com/openclaw/openclaw-enterprise/commit/a448eac9fdc6ac4040a37f89907432d5da8bf421) used a shared Source row lock and a 60-second idle timeout. The new delivery path must demonstrate the same ordering across TokenService and the native Proxy.

A timeout cannot cancel a write already in flight. The Worker clears the record only when it proves the outcome. Until then, replacing the token or deleting the Source returns `409` with a count and a reason. The response names an affected Agent and revision only if the caller can read that Agent. Metadata edits can proceed. A change to the repository list still requires an unbound Source. The Worker sends no further credential to that revision, even after restart. It does not overwrite a write whose outcome it cannot establish. Stop or redeploy releases the block once the Worker confirms the Provider is gone. A late write retains its original expiration.

## Revocation, stale Sources and Stop

At each loan the Worker checks the Source owner, state and preset, the revision's saved grants against the current list, the Agent principal's `credential_source:operate` and the token class. It renews before expiry only while those checks pass. If the Agent loses authority or a saved grant exceeds the new limits, the Worker refuses the next loan. Saving or deploying the same grants also fails.

- **Healthy connection.** The proposal calls for the Worker to withdraw the installed credential promptly when it detects lost authority. Record when the Sandbox stops sending it. The earlier implementation refused renewal and allowed an installed credential to work until expiry.
- **Outage.** If the Worker cannot reach the Sandbox, its supervisor must stop injecting the credential when the loan expires. The earlier implementation set the maximum at 15 minutes from the authority check, even if the write arrives late. This proposal keeps that upper bound and lets operators set a shorter limit. The shorter limit is not implemented. A loan must never outlast its grant. This deadline does not change the PAT's lifetime at GitHub. [AC-5](acceptance.md#acceptance-criteria) tests both cases.
- **Stop.** The Worker ends renewal, removes the Sandbox and confirms retirement of its Provider. Revoking the PAT at GitHub affects every user of that token. Stopping one Agent leaves its peers alone.
- **Upgrade.** A revision whose Worker no longer delivers to it gets no renewal or replacement. Its loan expires and a replacement reads `pending`. Redeploy to create a new copy and retire the old one.

## Retire

Remove the Source from the registry and restart to load the change. At startup the Worker checks running revisions against the registry. A revision that lost its binding fails that check. The Worker removes its Sandbox and retires its copy automatically. The Agent needs a new deployment to run again.

`DELETE` returns `409` with the reason while the loaded registry names the Source, any copy remains unretired (including queued deployments) or any write is unresolved. Once all three conditions clear, OCC marks the Source `deleting` and TokenService removes the value. Neither replacement nor retirement uses the model delivery path.

## Attribution and audit

OCC audits Source creation, updates and deletion and records the Source ID at deployment. The Worker logs each refusal code once per revision, available version and reason. It records pending delivery, confirmation and retirement with Source ID and version when available. Logs and audit events contain neither the token nor its digest.

See [acceptance criteria and delivery](acceptance.md) for the tests and observed limits.
