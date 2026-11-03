---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: separate Harness credential types from sources

- **ID:** RFC-0027
- **Created:** 2026-11-03
- **Last updated:** 2026-11-03

## Summary

Let each approved Harness declare the credential types and delivery forms it
accepts. An Agent selects a credential type separately from its exact source:
Secret, CredentialSource, or managed ServiceAccount. Sources retain acquisition,
refresh, custody, and delivery ownership. OpenClaw Control Plane (OCC) admits
only combinations supported by the Harness, source owner, Compute, Sandbox,
and selected security policy.

This RFC proposes a contract change. It changes no runtime behavior and does not
establish support for additional providers, topologies, or delivery mechanisms.

## Motivation and evidence

Source inspection at main commit `9ee3007d06478c3c5649f9b35bedb290a1aa8856`
confirms five problems:

| Current owner                                                                                                                                                                                                                                                                | Observed behavior and consequence                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Binding schema](../../packages/contracts/src/api/common.ts) and [public types](../../packages/contracts/src/index.ts)                                                                                                                                                       | `method` combines `api_key` and `codex_pat` credential types with `credential_source` backing and `runtime` ownership. Callers cannot select or report these dimensions independently.                                                                                                  |
| [Harness resolver](../../apps/controller/src/composition/production-harness.ts), [Compute method check](../../apps/controller/src/drivers/compute/harness-auth-method.ts), and [topology table](../../apps/controller/src/drivers/compute/kubernetes/configuration-rules.ts) | `HarnessDescriptor` declares only `id` and `version`. Accepted authentication is distributed across topology rules, Compute validation, source catalogs, and startup code.                                                                                                              |
| [OCC admission](../../packages/occ/src/index.ts)                                                                                                                                                                                                                             | `assertCredentialGatewayDelivery` rejects Secret and managed-account bindings whenever a Credential Gateway is selected. `requireCredentialSourceDrivers` requires the paired Sandbox. The first rule uses Installation selection as a substitute for an explicit delivery restriction. |
| [OpenShell catalog](../../apps/controller/src/drivers/credential-gateway/openshell.ts) and [Console form](../../apps/controller/src/console/agents/harness-auth.mts)                                                                                                         | The catalog offers API-key, PAT, and OAuth Harness sources. OAuth appears as `chatgptAuthTokens` under `credential_source`; the Codex form activates OAuth whenever that method is selected.                                                                                            |
| [Snapshots and resolution](../../packages/contracts/src/harness-auth.ts), [preparation](../../apps/controller/src/drivers/compute/kubernetes/index.ts), and [Codex startup](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)                     | Backing-specific branches reach runtime login. `OCE_CODEX_CREDENTIAL_SOURCE` makes placeholder PAT delivery use a different startup path from a directly delivered token. Removing this distinction without replacing its semantics would break login.                                  |

[PR #4507](https://github.com/openclaw/openclaw-enterprise/pull/4507), at
`93af1b8291c9ccabc8587668891db5b10df66e84`, derives the public binding type
from `HarnessAuthBindingSchema`, preserving readonly fields and source-union
distribution for `Extract`. Retain that approach when changing the schema.
This RFC neither duplicates that refactor nor changes that PR's OpenShell setup
paths.

The [architecture implementation status](../../docs/design.md#implementation-status)
and [Harness reference](../../docs/reference/harness-execution.md) remain the
current support boundaries. Source inspection is not live authentication proof.

## Scope and related decisions

This is a successor to the binding model delivered by
[RFC-0005](0005-harness-auth-binding.md). Its embedded-provider amendment remains
separate. Preserve historical specifications and Manual Notes.

[RFC-0016](0016-sandbox-credential-injection/index.md) owns Gateway injection and
refresh. [RFC-0023](0023-egress-proxy-credential-lifecycle/index.md) owns protected
egress, online authority, and credential lifecycle; its
[Token Service amendment](https://github.com/openclaw/openclaw-enterprise/pull/3804)
owns issuer selection. This RFC consumes those owners' capabilities without
creating a competing token service or dispatch protocol.
[RFC-0024](0024-sandbox-harness-mode-support.md) owns Sandbox execution-mode
discovery. [OAuth connections](https://github.com/openclaw/openclaw-enterprise/pull/3068)
owns browser consent and personal-Agent restrictions; this RFC does not expand
consent or caller access.

The scope is Harness declarations, Agent authentication intent, admission,
revision snapshots, and runtime handoff through existing primitives. General
model routing, new IAM grants, automatic account issuance, and new platform
resources are excluded.

## Proposed contracts

The following TypeScript is an RFC example, not an exported contract. Reference
types denote exact Namespace-owned resources. The API schema remains the source
of truth for the public readonly union.

```ts
type CredentialType = "api_key" | "service_account_token" | "oauth";

type HarnessAuthBinding =
  | {
      readonly mode: "credential";
      readonly credentialType: "api_key";
      readonly source: SecretReference | CredentialSourceReference;
    }
  | {
      readonly mode: "credential";
      readonly credentialType: "service_account_token";
      readonly source:
        | SecretReference
        | CredentialSourceReference
        | ServiceAccountReference;
    }
  | {
      readonly mode: "credential";
      readonly credentialType: "oauth";
      readonly source: CredentialSourceReference;
    }
  | { readonly mode: "external_runtime" }
  | { readonly mode: "no_inference" };

type HarnessAuthProfile = {
  readonly id: string;
  readonly credentialType: CredentialType;
  readonly provider: string;
  readonly delivery: "workload_secret" | "mediated";
  readonly format: string;
  readonly requiredAccountFields: readonly string[];
};

// Proposed additions to the approved HarnessDescriptor.
type HarnessAuthentication = {
  readonly profiles: readonly HarnessAuthProfile[];
  readonly supportsExternalRuntime: boolean;
  readonly supportsNoInference: boolean;
};
```

The Harness integration owns immutable, versioned profiles for its approved
runtime. `format` identifies a closed integration-owned input contract, such as
Codex external authentication with account metadata. It is not a caller-supplied
login command. `provider` denotes the authentication protocol/provider, not an
arbitrary egress destination. A generic provider profile still requires validated
Configuration endpoints.

Each source owner declares which credential type, provider, format, delivery
form, and account fields it can supply. Secret storage does not infer credential
type from bytes or token prefixes. An imported token's selected type is intent;
provider acceptance is established by the Harness's normal startup checks.
Managed accounts and CredentialSources must match their owner's declared output.

OCC intersects these declarations with execution-mode support and delivery
security requirements. The selected profile is private admission metadata.
There must be one compatible result; absent or ambiguous results fail with an
actionable error before work is queued. Capability discovery and mutations use
the same checks. Discovery performs no token acquisition or provider login.

### Valid combinations

These are proposed grammar limits, not a promise that each Installation supports
every row. Within each row, provider, format, topology, and policy must also match.

| Credential type       | Permitted source       | Delivery and conditions                                                                                                  |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| API key               | Secret                 | Workload delivery only where explicitly permitted; preserves current embedded or dedicated limits.                       |
| API key               | CredentialSource       | Owner-declared mediated delivery, including supported API-key substitution.                                              |
| Service-account token | Secret                 | Imported token, with an accepting Harness profile; initial scope is dedicated Codex PAT login.                           |
| Service-account token | Managed ServiceAccount | Existing issued token and exact Backend binding; binding cannot issue it.                                                |
| Service-account token | CredentialSource       | Mediated PAT profile; runtime receives the declared placeholder format.                                                  |
| OAuth                 | CredentialSource       | Managed lifecycle and trusted account metadata where required; initial scope is dedicated Codex external authentication. |

Reject OAuth from a raw Secret, API keys from managed ServiceAccounts, and generic
OAuth sources without an accepting Harness profile. A scalar Secret cannot
represent a renewable OAuth grant and trusted account metadata. Further forms
require an explicit contract proposal and qualification.

Selecting a Credential Gateway alone no longer rejects a direct Secret.
An Installation that requires mediated delivery still rejects workload secrets,
regardless of credential type. Existing OpenShell delivery still requires its
paired Sandbox, matching owner, protected endpoints, and ready attachments.
The declaration must not advertise a direct-delivery exception to those controls.
Supporting another delivery path requires its own implemented capability and
proof; no fallback is allowed.

## Ownership and lifecycle

1. **Save intent.** Existing Agent create/update APIs validate the union and
   authorize exact references, including the removed and replacement sources.
   Secret and CredentialSource bindings require actor `operate`; managed
   ServiceAccount bindings require actor `read`. Cross-Namespace bindings fail.
   Null remains an incomplete draft, not an authentication mode.
2. **Admit deployment.** OCC requires Agent `deploy`, Configuration `read`, and
   actor source authority. It also requires the Agent principal's exact
   `operate` for Secrets and CredentialSources. Managed accounts retain their
   current account/Backend checks without an implied Agent account grant.
   CredentialSources remain listed in `credentialSources` for lifecycle tracking.
3. **Freeze references.** The Agent revision saves the credential type, source
   reference, Harness/profile version, selected delivery, and exact source owner.
   Preserve Secret Driver identity; CredentialSource owner capability, Driver,
   and type; and managed account credential reference, Backend, Driver, and
   workspace binding. Save no token bytes or refresh material. Credential renewal
   may change bytes, but cannot silently change the admitted account or scope.
4. **Resolve before effects.** The worker rechecks requester and required Agent
   authority, source readiness, ownership, and the saved capabilities. Owner or
   profile mismatch fails closed. It does not reinterpret an older revision using
   a changed draft or substitute another source.
5. **Deliver and activate.** Source owners provide authoritative delivery
   references and trusted metadata. Compute places those references only at the
   admitted consumer; the Harness integration maps the chosen format to native
   login. Required attachments, login, and model checks must pass before guarded
   activation. Failure leaves the candidate unready under existing recovery rules.
6. **Withdraw and clean up.** Removing a draft binding does not revoke a running
   revision. Retain source references for every revision that may still run.
   Existing withdrawal owners must establish revoked/absent evidence or keep
   withdrawal pending; retries cannot reattach a withdrawn source. Directly
   delivered bytes require consumer shutdown or issuer revocation for immediate
   containment. Source deletion and shared consumers retain their existing guards.

Secret Drivers retain storage and resolution. Managed ServiceAccount Drivers and
their Backend retain explicit issuance and upstream cleanup. CredentialSource
owners retain registration, acquisition, delivery, and withdrawal; their selected
refresh/issuer owner renews tokens. OCC coordinates authority and durable work,
not provider token handling. Compute must not copy all forms into a new generic
Secret to simplify delivery.

### OAuth and account metadata

Reuse the [Credential Refresh lifecycle](../../packages/contracts/src/drivers/credential-refresh/index.ts).
The trusted owner completes authorization, retains refresh custody, and reports
ready only when a usable access token and required account metadata exist.
Pending consent, expiry without successful renewal, revoked consent, or missing
metadata prevents usable delivery. Recovery is explicit retry, reauthorization,
or configuration repair; never an API-key fallback.

The Harness profile declares required account fields. For the existing Codex
external-auth format, the [Gateway attachment](../../packages/contracts/src/drivers/credential-gateway/index.ts)
carries a placeholder plus account ID and plan type, with optional identity
fields. The owner obtains and validates these values from the provider; callers
cannot assert them in the Agent binding. Bind token and metadata to the same
source, issuer, account, and admitted scope. Renewal preserves that identity;
the source owner retains the private account binding and the revision pins its
opaque identity version. Account changes require reauthorization and a new
deployment. This version does not change for ordinary token renewal.

Refresh material stays with its existing custodian. Runtime receives only its
declared placeholder and minimal account fields. Public resources, revisions,
audit payloads, and logs exclude token material and private account details.
Preserve refresh idempotency, withdrawal evidence, and existing attributable
mutation/denial audits. A recorded ready state is not proof of a live model turn.

### Runtime-owned and no-inference modes

Replace the overloaded `runtime` intent with two explicit modes.
`external_runtime` preserves the SSH embedded operator-managed credential path:
OCC does not acquire credentials, and process readiness does not prove model
access. `no_inference` preserves protected dedicated Codex execution with no
admitted inference route. Its security owner must enforce that absence; it
cannot mean anonymous model access or credential-free general inference.

Neither mode accepts a credential source. Both require declared Harness and
Compute support plus normal Agent, Configuration, and execution authorization.
Missing auth never selects either mode. Provisioning retains its explicit
credential requirement. Runtime login uses type plus delivery format, replacing
backing-name flags such as `OCE_CODEX_CREDENTIAL_SOURCE` only when their placeholder
and metadata behavior is represented explicitly.

## API and Console impact

Update the canonical API schema and derive public readonly types from it,
preserving source-union narrowing. The Console separates credential type from
source selection and filters both through admitted capabilities. OAuth controls
appear for OAuth, including required account status; an API-key/PAT
CredentialSource must not open an OAuth flow. Source readiness, deployment
acceptance, and runtime readiness remain separate observations.

Implementation must update generated OpenAPI, API/permission cheat sheets where
affected, current Harness/Agent/source references, and owning flows together.
This RFC leaves those current-support documents unchanged. Reject unsupported
old state explicitly; do not add silent inference or parallel compatibility paths.

## Alternatives and open decisions

Keeping `method` and adding more values preserves the ambiguity and distributed
checks. Putting every credential in a CredentialSource would force managed
account and direct-Secret lifecycles into another owner. Letting the Harness
refresh OAuth grants would move custody into the workload. Reject these options.

Maintainers must resolve these choices before implementation:

- **Harness owners:** Confirm `service_account_token` as the public name for the
  current `codex_pat` family, and whether another token protocol needs its own
  type. Do not classify arbitrary bearer tokens as account tokens.
- **Driver/security owners:** Confirm the minimal versioned profile and delivery
  capability shape, including how RFC-0023's protection level constrains it.
  Recommend explicit required capabilities, not a Gateway-presence check.
- **OAuth/Harness owners:** Confirm the minimal account-field allowlist and
  identity-change checks for each format. Recommend provider-validated metadata
  with no caller overrides or arbitrary metadata bag.

## Validation and next step

After review, the next step is `$spec plan RFC-0027`: map the agreed contracts
to existing owners and qualification lanes. This RFC-only PR does not authorize
implementation or acceptance. Recheck the RFC number against main before merge;
other unmerged proposals do not reserve numbers.

The implementation plan must extend the regular Agent workflow, including the
[QA matrix](../../tests/integration/qa-matrix-real.test.mjs), to prove:

- API/Console agreement for the valid combinations and rejection of unsupported
  type/source/format/topology/policy combinations before effects.
- Real PostgreSQL admission and dispatch with revoked grants, source-owner
  changes, immutable revision references, and concurrent withdrawal; extend
  [revision ownership](../../tests/integration/postgres-credential-source-revision-owner.test.ts)
  and existing worker/source coverage.
- Real delivery and startup for each supported form, including placeholder PATs,
  OAuth token renewal with account metadata, missing metadata, expired/revoked
  grants, failed attachment, and sibling-Agent isolation. Extend
  [OAuth runtime proof](../../tests/integration/openshell-oauth-credentials-real.test.mjs).
- Custody and fail-closed enforcement: no credentials in forbidden consumers or
  output, no direct-egress escape, and no inference for the explicit mode; extend
  [protected credential-free execution](../../tests/integration/postgres-protected-credential-free.test.mjs).

Mocks cannot establish issuer renewal, Kubernetes isolation, or model execution.
Missing authorized credentials or infrastructure are verification gaps. Earlier
cluster results do not verify this redesign. For this prose-only change, run
formatting, length, links, and spec metadata checks; no product tests or live
authentication checks.
