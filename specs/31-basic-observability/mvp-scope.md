# Basic observability: MVP scope and dependencies

**Status:** Selected proposal; implementation and qualification pending.

Use this checklist to deliver the [Basic Agent observability RFC](../31-basic-observability.md). Linked contracts define the details and open decisions.

The selected scope allows lifecycle History to serve first, but the **complete MVP** requires an authentic repository read. A [review suggestion](https://github.com/openclaw/openclaw-enterprise/pull/250#issuecomment-5754821713) would make lifecycle History the complete first release and track that read separately. This decision is open; the suggestion has not been adopted.

## Required outcomes

The MVP covers personal and team Agents through the existing resource model. Full acceptance uses three distinct people: deployer A, requester B, and separately granted audit reader C.

- [ ] **Current audit access.** Check exact-Agent `read_audit` on every page. Exercise personal/team grants, cross-scope denial, revocation, account and group changes, and restrictions. Ownership, membership, participation, and deployment grant no access.
- [ ] **Explicit administration.** Installation administrators grant and revoke both audit roles through [common IAM administration](interfaces.md#authorization-and-policy-consumption), atomically with evidence. Retention administration grants no History access.
- [ ] **Truthful lifecycle.** Preserve causation through create, update, deploy, stop, retries, supersession, completion, and failure. Distinguish requested, accepted, observed, and unknown; queue completion does not prove workload stop or provider success.
- [ ] **Safe facts.** Validate the [closed projection](interfaces.md#facts-and-events) before storage and disclosure. Reject unsupported or unsafe data, and prove credentials and other excluded content do not leak.
- [ ] **Atomic evidence and recovery.** Commit local mutation, work intent, and mandatory evidence together in original State; rollback removes all three. Uncertain commit stays unknown. [Recovery](interfaces.md#mutation-outcomes) reauthorizes the original action, observes only its result, and creates no work. Disclosure requires acknowledged evidence commit.
- [ ] **Bounded query.** Use indexed exact-Agent queries, closed filters, and authenticated subject-bound cursors. Return at most 100 events per page, with no total count or unbounded Installation scan.
- [ ] **Small console.** Implement the [History view states](interfaces.md#console-and-examples), including unknown and stale responses. An audit-only reader can reach retained History without configuration-read permission.
- [ ] **Retained Agent authority.** Preserve historical parentage and exact audit grant/revoke/regrant after deletion. Current IAM decides access without a live Agent lookup.
- [ ] **One authentic repository read.** Complete the [A/B/C acceptance](repository-read.md#acceptance-and-delivery) through an actual Agent/Harness turn and managed Git child. Show the requester, executor, exact resource and authorization, and strongest observed or unknown result.
- [ ] **Retention and restore.** Qualify [both retention modes and restore](retention.md#acceptance-and-follow-ups), including legacy rows, transitions, races, restricted purge, and restart. Expired evidence must not return; live deletion does not certify independent-backup erasure.
- [ ] **Safe operational health.** Report append refusal, unknown commit, storage pressure, and overdue erasure without protected content or high-cardinality labels. Follow the [evidence-failure rules](security.md#audit-failure-and-protective-work).
- [ ] **Connected acceptance.** Review the integrated tree, including SQL and security. Each cumulative cut builds and passes applicable checks; the final stack tree equals the accepted feature tree. Record source/database, composed, installed, live-provider, and release proof separately, including gaps.

## Dependency cut points

**Independent diagnostics** may use existing filtered logs and optional local files. Their [acceptance](architecture.md#availability-and-delivery) preserves current authentication, authorization, and mandatory audit. They do not qualify History or repository read.

**Non-serving source slices** may validate contracts before all suppliers are ready, but must leave protected History unavailable. Source acceptance does not enable disclosure or complete an adjacent capability.

**First serving lifecycle History** requires the current local account, method, and session guards; selected IAM and original State; lifecycle producers; API and console; the complete retention and restore contract; and exact recovery across restarts, replicas, and key rotation. All are prerequisites to disclosure. Local accounts suffice; federation and Google/GitHub login are not prerequisites.

Use original State transactions and recovery, `PlatformUnitOfWork.audit.queryAgentHistory` and its lifetime binder, and raw-SQL migration integration. IAM supplies `IAMPolicyAdministrationV1.bindPolicy`; the OpenClaw Control Plane (OCC) owns `readPolicy`, `applyChange`, and `readPolicyOperation`. Require read-bound authorization and currentness guards. Accept and compile these exports and review participating writers; the whole RBAC and OIDC programs need not be complete. If a supplier is unsupported, History remains unavailable.

**The complete selected MVP** also integrates accepted `AgentInvocation`, `AgentAuthorityContext`, and `AgentInvocationRuntime` exports with the credential owner's real session/exchange and safe observation exports. Qualify one actual execution profile under [authentic handoffs](repository-read.md#connect-authentic-handoffs) and [currentness and closure](repository-read.md#currentness-and-closure). SPIRE, gVisor, and egress program completion are not blanket gates; any receiving, isolation, or transport control required by that profile remains a dependency.

## Small reviewable deliverables

These source cuts create no new authority. Independent cuts can proceed when their named interfaces are accepted; serving and shipping require the combined gates above. Separate storage from query, worker facts from recovery, retention SQL from sweeper/restore integration, and API from console.

1. **Safe facts and causation.** With lifecycle producers and Audit/State, define closed fact and query types that reject unsafe or conflicting facts. Do not serve History.
2. **State persistence and query.** Build on cut 1 and original State transaction and migration exports. Verify receipt, sequence, retained subjects and indexed queries through real PostgreSQL migration, ordering and limited-role checks.
3. **Audit grants and currentness.** Build on cut 2, the common IAM writer and account/session guards. Commit evidence with grant/revoke/regrant; prove exact post-deletion grant/revoke/regrant with limited-role PostgreSQL and check authorization denials and races.
4. **Lifecycle producers and exact recovery.** Build on cuts 1–3, original transaction-owner recovery and accepted key/expiry decisions. Preserve causation; keep lost acknowledgements unknown; verify recovery across supported restarts, replicas and key rotation.
5. **Retention and restore.** Build on cuts 2–3 and State/SQL, composition and operator contracts. Qualify both modes, authorized configuration, restricted erasure, the sweeper, health and installed restore gates.
6. **History API and console.** Use cuts 2–3 and accepted recovery/retention query contracts. Review API and view separately; real routes and browser must prove access, pagination, disclosure commit, privacy and view states. Serving requires cuts 2–5 and the full lifecycle gate above.
7. **Repository observation.** Use accepted invocation/runtime, credential and safe-event exports for one qualified profile. An actual B-initiated Agent/Git read must pass the repository-read checks; complete A/B/C acceptance also requires serving History.
8. **Connected acceptance and delivery.** Integrate cuts 1–7 and prove the A/B/C journey, SQL and security checks, independent review, current documentation and cumulative checks on the final feature tree.

## Decisions still required

The release boundary still needs a product decision. Owners must also close these decisions before accepting the dependent implementations:

| Owners                                     | Decision                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Audit, State, authentication and producers | Freeze [event membership and attribution](interfaces.md#facts-and-events) against the facts each producer can establish.             |
| State, Audit and API                       | Choose how to handle [expiry during disclosure](retention.md#expiry-and-concurrency) for both History and recovery.                  |
| Composition and operators                  | Choose [recovery-reference validity and key continuity](interfaces.md#mutation-outcomes), including rotation and verifier retention. |
| State, composition, IAM and SQL            | Bind current authority to the separate [purge execution role](retention.md#database-and-runtime-enforcement).                        |
| Product, State and operators               | Define [restore authority, checkpoint custody and continuity](retention.md#restore-and-copy-ownership).                              |

Dependent source work may proceed without serving History. If restore continuity or another serving gate cannot be established, disclosure stays unavailable.

The scope excludes a new journal, generic registry, broad search, transcript store, arbitrary retention periods, legal holds, remote export, and independent witnessing. Existing owners retain enforcement and credential custody. Proposed scope and completed source checks are separate from shipping acceptance.
