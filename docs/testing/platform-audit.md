# Verify the Platform audit projection

Run the component checks from the repository root with Node.js 24 or newer and
the matching installed workspace dependencies:

```sh
node --test tests/conformance/platform-audit.test.mjs tests/conformance/audit.test.mjs tests/conformance/contracts.test.mjs
```

These tests exercise the production raw-row projector, closed event/page parsers,
and page encoder. They cover the twelve selected producer tuples in the
[Platform audit proposal](../../specs/rfcs/37-platform-audit/index.md), including both
bootstrap actions and the two creation-denial collection targets.

**There is no implemented Platform audit reader.** This component is a source
checkpoint. It neither persists nor serves events. Component tests do not satisfy
the repository's required integration proof for the full capability.

## Receiving contract

The public `projectPlatformAuditRow` export from `@openclaw-enterprise/audit`
accepts a `PlatformAuditRawRow` and the Installation ID that State has verified
against its singleton. Read the original ledger columns; the existing generic
decoded `AuditEvent` is unsuitable because its metadata can overwrite those
columns and its timestamp conversion loses sub-millisecond precision.

The row uses the existing database column names for ID, producer time, kind,
actor ID, action, Namespace, resource kind/ID, and outcome. All fields in the
[receiving type](../../packages/audit/src/platform-audit.ts) are required. Nullable
columns and absent extracts use `null`, never `undefined`.

State must obtain these additional bounded extracts directly from stored JSONB:

| Fields                                                                   | Original value                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `details_type`                                                           | JSON type of `details`, or SQL null when absent                            |
| `metadata_type`, `metadata_keys`                                         | JSON type and complete top-level keys of `details.__occAuditMetadata`      |
| `metadata_schema_version`, `metadata_source`                             | Reserved `schemaVersion` and `source` JSON values                          |
| `metadata_request_id`, `metadata_admission_decision_id`                  | Reserved `requestId` and `admissionDecisionId` JSON values                 |
| `actor_type`, `actor_keys`                                               | JSON type and complete keys of the reserved `actor`                        |
| `actor_id_value`, `actor_principal_id`, `actor_kind`, `actor_unresolved` | Reserved actor's `id`, `principalId`, `kind`, and `unresolved` JSON values |
| `history_fact_type`                                                      | JSON type of top-level `details.history_fact`, or SQL null when absent     |

Type values follow `jsonb_typeof`: SQL null means absent; the string `"null"`
means a present JSON null. The latter is rejected where a selected object or
value is required. An absent object's key inventory is null. An empty object's
inventory is `[]`. Extract JSON values without text coercion so a number cannot
masquerade as a reference string. Key inventories must be complete, with no
omission or truncation. At most nine reserved metadata keys and six actor keys
are accepted. State must refuse an oversized or malformed extract before
transferring it, including unknown keys; it must not silently drop the row.

The receiving shape has no arbitrary details, authorization object, issuer,
subject, or error content. State must not materialize these values to build it.
No source tag or caller-supplied trust flag bypasses validation. Ledger targets
and actor IDs must agree with selected metadata. Injected envelope fields or
History facts cause the fixed `Platform audit data is unavailable.` error.
Unsupported kind/action/outcome tuples return `undefined`; malformed selected
tuples throw that error and must fail the entire read. SQL must apply the positive
selection before pagination; the projector is not a scan-and-skip query API.

Recorded actor references carry `kind: "unknown"`. The current selected producers
do not independently establish identity kind, including when copied metadata
contains `principalId` or `kind`. The literal unresolved actor and explicit
unresolved metadata remain unresolved. Projection performs no live identity or
resource lookup and does not reconstruct deleted targets.
An explicit unresolved marker paired with a non-sentinel ledger actor ID is
contradictory evidence and is rejected.

## Event and page validation

`@openclaw-enterprise/contracts` exports `PlatformAuditEventV1`,
`PlatformAuditPageV1`, their parsers, `PLATFORM_AUDIT_LIMITS`, and
`encodePlatformAuditPageV1`. State can validate projected events through these
contracts; the eventual HTTP consumer can validate and encode a complete page.
The encoder returns JSON text, not a disclosure receipt or permission to send it.

The parsers reject additional fields, accessors, inherited records, malformed
nominal IDs, invalid dates, contradictory target/Namespace relationships, and
unsafe references. Optional request and admission references use the current
`req_` and `adm_` UUIDv4 formats. Recorded actor IDs use a bounded ASCII token
format. Invalid or oversized values fail without truncation. The ID and optional
reference ceilings are 256 and 128 UTF-8 bytes; their nominal formats can impose
stricter limits.

Producer timestamps remain UTC text with up to six fractional digits. Validation
and ordering retain microseconds. Page events must use one Installation and be
strictly descending by `(occurredAt, id)` inside the half-open `[from, to)` window.
The window spans at most seven days. The event limit is an integer from 1 through 100. Projection and coverage versions are fixed; the latter describes the
bootstrap, Namespace, and Secret selection, not complete audit coverage.

Serialization checks each event against 8,192 UTF-8 bytes and the complete page
against 1 MiB, including its envelope and continuation. Closed fields currently
impose a stronger bound: even a conservative 2 KiB per event plus the 4,096-byte
continuation and fixed envelope stays below 210 KiB for 100 events. Tests exercise
the actual encoder at the largest variable-field sizes. They do not create a
test-only way to bypass the tighter schema to reach an aggregate limit.

Continuation validation checks token shape and size only. It does not issue,
decrypt, authenticate, expire, or bind a cursor to a reader. This component also
does not decide the default window or compare its upper bound to trusted time.
Those checks belong to the eventual authenticated request and State path.

## Integration evidence still required

Full A1 requires genuine supported-caller integration. The State owner must prove
bounded original-row extraction and positive tuple/window/keyset selection before
LIMIT against persisted ordinary producers, exact ordering precision, populated
query plans, and finite query/lock waits. The metadata extraction boundary needs
real JSONB forgery and sensitive-value canary cases; hand-built row inputs here
do not prove that SQL boundary.

The IAM, authentication, State, and HTTP owners must compose the exact
Installation grant with genuine current human account/method/session evidence,
reauthorization after waits and queries, mandatory safe disclosure on the original
transaction, and acknowledged COMMIT before releasing bytes. Required negative
cases include missing/wrong grants, expiry, revocation, failed disclosure append,
rollback, and unknown COMMIT. Empty pages need the same authorization and
disclosure guarantees. Shipping schema/index and limited-role checks, protected
cursor behavior, no-store responses, and the connected source-backed flow doc
remain part of that delivery.

Console behavior and installed allow/deny/expiry/revocation proof are later
milestones. This suite claims no PostgreSQL, HTTP, browser, installed-runtime,
provider, or release proof. It neither changes protected Agent History nor
provides a substitute History implementation. See the
[audit guide](../guides/topics/audit-log.md) for current product access limits and
[test integrity rules](../../AGENTS.md#test-integrity) for evidence requirements.
