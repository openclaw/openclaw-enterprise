# Basic observability: security

[Overview](../31-basic-observability.md) · [Architecture](architecture.md) · [Interfaces](interfaces.md)

**Status:** Proposed controls and qualification requirements. Recorded trust and scope limits do not accept missing implementation or undecided risks.

## Assets, actors and trust

Protect historical facts, original attribution, exact authorization references, recovery references and retention metadata. Opaque identifiers can reveal protected relationships even without credentials. Local integrity prevents ordinary application roles from altering accepted facts; it does not establish independent witnessing.

Lifecycle admission, State, workers, authentication and credential owners are trusted producers of their own facts. Reader C has explicit audit permission; deployer A and requester B retain separate identities and authorities. The [repository scenario](repository-read.md#decision) must prove those distinctions through real handoffs.

Browser, Agent, model/tool, header, provider and network data are untrusted as owner assertions. Trusted producer compromise, database/host administrators and independent backups are outside the local integrity guarantee. Product-created and operator-owned copies have separate [retention responsibilities](retention.md#restore-and-copy-ownership).

## Fact authenticity and disclosure

Only the named owner can establish an admission, execution or authorization fact; attacker-controlled strings must not appear to do so. Validate closed projections before persistence and disclosure, rejecting unknown versions/fields, unsafe text and excess size or depth under the [fact contract](interfaces.md#facts-and-events).

Exclude raw `details`, credentials, custody handles, identity labels, issuer/subject claims, requests, plans, URLs, headers, commands, paths, prompts, responses, provider bodies and exception text. They can leak content or make untrusted input appear to be evidence. Legacy facts require original trusted provenance and cannot gain synthesized causation during projection.

References are protected metadata, never lookup authority; serialized assurance grants no effect authority. A revision identifier cannot prove an Agent executed a request, and a bearer cannot establish requester B. Actual receiving and runtime association remain [producer obligations](repository-read.md#currentness-and-closure).

Each page and exact recovery observation requires current authenticated account/session state and the selected IAM Driver's exact permission. The [disclosure transaction](interfaces.md#disclosure-transaction) prevents disclosure after an earlier committed revoke and releases bytes only after acknowledged COMMIT. Refusal, uncertain commit or dependency loss releases no protected page.

## Audit failure and protective work

New authority, privileged mutation, credential dispatch, retention changes and History disclosure require established local evidence before effects or bytes. New restrictive intent shares its original transaction.

Already durably accepted protective work can continue during remote-delivery failure. Audit failure must not block safe refusal or closure. Such work must not claim newly durable stop/revoke acceptance without a local commit. The [retention writer order](retention.md#expiry-and-concurrency) applies without inventing a human session for a protective worker.

Report append refusal, unknown COMMIT, storage pressure and overdue erasure through sanitized operational health, without protected content or high-cardinality labels. Required operations fail closed when local audit cannot commit, including under indefinite retention.

## Accepted limits and closure

These trust and scope boundaries do not accept unresolved mechanisms as residual risk. The [owner decisions](interfaces.md#retention-interface-index) on [expiry-crossing release](interfaces.md#disclosure-transaction), [recovery keys/reference policy](interfaces.md#mutation-outcomes) and [authoritative restore custody](retention.md#restore-and-copy-ownership) require closure before serving acceptance.

Released bytes cannot be recalled. Live-ledger erasure cannot certify deletion of downloads, backups or other independent copies. The [restore contract](retention.md#restore-and-copy-ownership) must prevent an older database from resurrecting expired evidence.

Exact mutation recovery observes local acceptance only; entire-response loss before the caller receives its reference is outside the contract. Missing or erased evidence stays unknown. Search, client idempotency, replay, compensation, an operation journal and a transaction-status API await a selected lifecycle/API use case with pre-response identity, deduplication and real unknown-outcome proof. A pre-COMMIT signature cannot certify acceptance.

Separately triggered capabilities remain:

- **Transcripts and broader content.** Content/IAM must select and enforce separate content authority before transcript storage.
- **Installation-wide search and CLI.** State/API must provide bounded authorized queries for search; a later CLI reuses the History API.
- **General policy editing or remote policy mutation.** IAM must establish grant ceilings and durable-intent/recovery. Observability adds neither a general access-management UI nor another policy writer.
- **Remote export and cryptographic or independent witnessing.** Audit, operators and the independent trust domain must define custody, acknowledgment, replay/completeness and evidence-loss verification. Preserve stable event identity, version, receipt, scope, causation and the producer/State boundary. The local ledger currently makes no such assurance claim.

[Retention follow-ups](retention.md#acceptance-and-follow-ups) retain richer periods and legal holds. [Runtime follow-ups](repository-read.md#alternatives-and-follow-ups) retain exact-container origin, outage-time physical termination and provider cleanup recovery. These successors cannot weaken selected off-Pod protection, traffic withdrawal or original erasure deadlines.

## Threat closure evidence

Acceptance evidence must follow the actual threat boundary:

| Threat                                          | Required evidence owner                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-scope reads or revoked access             | [Lifecycle acceptance](architecture.md#availability-and-delivery): real account/Group/Restriction races, exact post-deletion grants and browser denial.                                                |
| Forged time or resurrection                     | [Retention acceptance](retention.md#acceptance-and-follow-ups): restricted SQL roles, concurrent expiry transitions and actual restore continuity.                                                     |
| Token/reference leakage or fabricated requester | [Repository acceptance](repository-read.md#acceptance-and-delivery): ordinary A/B/C turn, managed child, off-Pod denial and secret/reference exclusion.                                                |
| Unknown effects mistaken for safe replay        | [Recovery](interfaces.md#mutation-outcomes) and [repository handoffs](repository-read.md#connect-authentic-handoffs): lost acknowledgment, durable independent fences and retained settlement custody. |

Verify privacy through real producers, storage, HTTP, diagnostics and health surfaces. Keep source, composed, installed, live-provider and release evidence distinct. These are future requirements, not claims that the proposed controls passed.
