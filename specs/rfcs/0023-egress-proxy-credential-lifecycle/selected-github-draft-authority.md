---
rfc: index.md
---

# Selected GitHub repository: authority over an original draft

**Proposed amendment to RFC-0023.** An Agent with an explicitly selected repository grant may create and update drafts that the OpenClaw Control Plane (OCC) can prove it authorized that Agent to create. The selected request path does not currently deliver a trusted create response to OCC, so an allowed create request cannot establish authority to edit the resulting pull request. A workload-supplied ID, branch, title, or shared GitHub App actor cannot supply that proof.

## Decision and scope

Require a trusted, correlated response check before returning a successful create response to the workload. OCC must durably bind the provider's returned pull request ID to the approved create operation. A later edit requires a separate current authorization and an independent live provider read.

This is a distinct, explicitly selected repository policy. Permit only the inspected GitHub GraphQL documents and variables needed for the selected create, target read and update operations over verified HTTPS to `api.github.com`; reject arbitrary GraphQL, aliases or batching that changes the approved operation, redirects, and alternate egress. Keep the existing [installation-wide mode](github-installation-access.md#decision) free of an OCE original-draft filter. Saved bounded-draft grants retain their separate one-create allowance, uncertain-outcome handling and no-replay rule; do not widen or reinterpret them.

```mermaid
---
config:
  htmlLabels: true
  theme: base
  themeVariables:
    fontSize: 14px
---
flowchart TB
  W["<b>Agent workload</b><br/>Create draft"] -.->|request| S["<b>Trusted Supervisor</b>"]
  S -.->|PRE_CREDENTIALS| A["<b>OCC authorization</b><br/>Commit pending operation"]
  A -.->|allow once| S
  S -.->|send create| G["<b>GitHub</b>"]
  G -.->|trusted response| S
  S -.->|mandatory PRE_RETURN| R["<b>OCC response check</b><br/>Correlate and settle"]
  R -.->|durable object binding| D[("<b>Operation and object state</b>")]
  R -.->|allow return after settlement| S
  S -.->|return approved response| W
  W -.->|later edit| E["<b>GitHub Backend + OCC</b><br/>Live target and grant checks"]
  E -.->|read canonical target| G
  E -.->|match original| D
  E -.->|authorize update| U["<b>Trusted Supervisor</b><br/>Update request"]
  U -.->|send update| G
```

All dashed arrows describe the proposed connected contract; they do not establish installed behavior.

## Boundaries and settlement

The Sandbox and Credential Proxy Drivers must establish authenticated, mandatory `PRE_CREDENTIALS` and `PRE_RETURN` bindings on the exact selected route, an exclusive credential recipient, verified transport, and no bypass. OCC must verify the actual applied bindings and recipient before release and after material or policy changes. A capability advertisement or configured hook is insufficient. Missing, stale, substituted or unavailable enforcement refuses the protected operation; do not fall back to request-only preview, native Git, installation-wide authority or credential-free egress.

Before allowing create, OCC commits an unspent operation bound to immutable Sandbox, execution, Agent revision and admission identities; grant, provider, credential and stable repository IDs; authenticated sender and response recipient; request ID and digest; and the actual attached material attempt, version and recipient fence. The Supervisor owns provider dispatch and credential injection. The GitHub Backend owns operation classification and response parsing; OCC owns authorization and durable settlement.

At `PRE_RETURN`, authenticate the Supervisor and correlate the response to that exact pending operation and attempt. Accept only a complete, size-limited HTTPS GraphQL success with the expected status and schema, no GraphQL errors, duplicate members, ambiguous encoding or trailers. Extract the canonical pull request node ID from that create response. Atomically settle the operation once and append an immutable object binding before releasing the approved response to its original recipient. Store identifiers, digests and outcomes, never tokens or response payloads, in state or logs. Allow many immutable operation/object records per selected grant; this is not the legacy one-draft quota.

Failed, forged, mismatched, replayed, incomplete or lost responses create no successful object receipt or binding. Preserve explicit failed or unknown outcomes. If a mutation may have reached GitHub, or settlement acknowledgment is lost, reconcile that operation without repeating the provider mutation; neither restart nor a claimed success permits replay or edit authority.

For each edit, the Backend independently reads GitHub's canonical pull request ID, stable repository ID and `isDraft`. OCC matches them to the immutable original binding for this Agent and grant, then rechecks current admission, withdrawal, recipient, material attempt/version and fence immediately before authorizing the update. A stale observation, changed execution after restart, missing record, non-draft or different object denies the mutation.

## Acceptance and qualification

Through the ordinary Agent workflow, create two drafts under one selected grant and update an original while it remains a draft. In the same journey, deny edits to a colleague's same-repository draft, a published pull request, a foreign repository, and stale or withdrawn authority, with zero forwarded update mutations. Missing mandatory response enforcement must prevent create dispatch. Forged, mismatched or lost responses must yield no edit authority and no repeated create mutation; any original provider effect remains possible and must be reported. If settlement acknowledgment is lost, deny edits until reconciliation confirms the durable binding, and never repeat the create mutation. Replays must not create another binding. Separately retain the bounded grant's one-create/unknown controls and installation-wide behavior. Source, integrated, released Supervisor, installed Agent and live GitHub qualification remain separate; none is established by this proposal.
