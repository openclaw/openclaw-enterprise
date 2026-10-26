import type {
  PreparedGitHubUseRequest,
  PreparedGitHubInstallationUseRequest,
  ProtectedGitHubInstallationMaterial,
  RepositoryGitAuthority,
  RepositoryGitOnlineAllow,
  RepositoryGitSendPermit,
  PreparedGitHubPullResult,
  PreparedGitHubPullScope,
  PreparedGitHubPullProjection,
  PreparedGitHubUseResponse,
  RepositoryRevisionState,
  DriverRegistrationRef,
  ProtectedRepositoryGitAuthority,
  ProtectedRepositoryGitMaterial,
  RepositoryGitInstallationFence,
  RepositoryGitSendDecision,
} from "@openclaw-enterprise/contracts";
import {
  CredentialDeliveries,
  type PostgresClient,
  type PostgresPool,
} from "@openclaw-enterprise/occ";
import { randomUUID } from "node:crypto";
import type { OperationReceipt } from "../../credentials/backend-contracts.ts";
import { draftOperationId, validateDraftProjection } from "./prepared-draft-pull.ts";
import { isDeepStrictEqual } from "node:util";
import { PreparedGitHubPostgres, preparedAttemptSettled } from "./prepared-postgres.ts";
import type { GitHubPreparationAdmission } from "./prepared-contracts.ts";
import {
  legacyAdoption,
  protectedGitAdoption,
  installationGitAdoption,
  releasedGitProfile,
  registeredGitSelection,
  openShellGitRecipientEvidence,
  openShellPreviewEnded,
  registeredGitRecipientEvidence,
  type RepositoryGitRecipientEvidence,
  repositoryGitAdmissionEnded,
  repositoryGitBrokerOwnerPredicate,
  repositoryGitOwnerPredicate,
  repositoryGitDeliveryTransport,
  selectedRepositoryGitDriver,
  validRecipient,
} from "../../credentials/protected-repository-git-installation.ts";

const pulls = "occ.prepared_repository_draft_pulls";
type PullRow = {
  settled_at?: Date;
  scope: PreparedGitHubPullScope & { repositoryId: string };
  admission_id: string;
  operation_id: string;
  receipt_id: string;
  request_digest_sha256: string;
  outcome: "outcome_unknown" | "created" | "not-submitted";
  projection: PreparedGitHubPullProjection;
};
function pullReceipt(row: PullRow, conflict = false): OperationReceipt {
  const { operation_id: operationId, receipt_id: receiptId, outcome } = row;
  if (conflict) {
    return { kind: "recorded", status: 409, body: { error: "operation_conflict" } };
  }
  if (outcome !== "created") {
    return { kind: "recorded", status: 409, body: { operationId, receiptId, error: outcome } };
  }
  const result = validateDraftProjection(row.projection, row.scope);
  return { kind: "recorded", status: 201, body: { operationId, receiptId, ...result } };
}

/** The grant's one draft create was already claimed: at an installed sender a second one is
 * refused before GitHub, whatever happened to the first (finding 2147). */
class DraftAlreadyOpened extends Error {
  constructor() {
    super("PREPARED_REPOSITORY_DRAFT_ALREADY_OPENED");
    this.name = "DraftAlreadyOpened";
  }
}

/** No live session for the request: the binding was removed, the version replaced or stopped,
 * or the session ended. The Agent is told its access was withdrawn (finding 2149). */
class SessionClosed extends Error {
  constructor() {
    super("PREPARED_REPOSITORY_SESSION_CLOSED");
    this.name = "SessionClosed";
  }
}

type Recipient =
  { evidence: RepositoryGitRecipientEvidence; driver?: DriverRegistrationRef } | undefined;

function installationRecipient(proxy: Recipient) {
  return (
    !!proxy?.driver &&
    (proxy.evidence === registeredGitRecipientEvidence ||
      proxy.evidence === openShellGitRecipientEvidence)
  );
}

const families = "occ.prepared_github_families";
const attempts = "occ.prepared_github_attempts";

export interface PreparedRepositorySession {
  readonly standingApprovalId?: string;
  readonly standingApprovalGeneration?: number;
  readonly standingApprovalScopeFingerprint?: string;
  readonly agentId: string;
  readonly namespaceId: string;
  readonly revisionId: string;
  readonly admissionId: string;
  readonly sessionId: string;
  readonly driver: RepositoryRevisionState["driver"];
  readonly binding: RepositoryRevisionState["bindings"][number];
}

/** The session snapshot binds the Agent and the exact installation used for Compute release or the broker generation.
 * The deadline is checked live instead of extending or treating the snapshot as a lease. */
function sessionQuery(proxy: Recipient): string {
  // An old protected sender without a selected Driver may already hold material or have sent
  // a request. Without a selected Driver we can neither adopt that custody nor retire it.
  if (proxy && !proxy.driver) {
    return "SELECT NULL::jsonb AS session WHERE false";
  }
  const driver = proxy ? `'driver', ${selectedRepositoryGitDriver},` : "";
  const profile = installationRecipient(proxy) ? releasedGitProfile : "'git-write'";
  // Installation membership can change at GitHub. Across a scope change on this Agent, require
  // disposal and settled custody even when the old and new operator selection names differ.
  const broad = "s.cleanup_context #>> '{binding,profile}' = 'github-installation'";
  const execution = `p.installation#>>'{plan,execution,executionId}'`;
  return `SELECT jsonb_build_object(
  'namespaceId',s.namespace_id, 'agentId',s.agent_id, 'revisionId',s.live_revision_id,
  'installationId',i.id, 'admissionId',s.admission_id, 'sessionId',s.session_id,
  ${
    proxy
      ? `'credentialProxyExecution', jsonb_build_object(${driver}'executionId',${execution},'sandboxId',p.sandbox_id,
        'sender',p.installation->'sender','enforcement',p.installation->'enforcement')`
      : "'brokerGeneration',b.generation"
  }, 'driver',s.cleanup_context->'driver', 'binding',s.cleanup_context->'binding',
  'grant',s.cleanup_context #> '{binding,grant}') ||
    CASE WHEN rev.admitted_spec->'repository_credentials' ? 'standingApprovalId' THEN jsonb_build_object(
      'standingApprovalId',rev.admitted_spec #> '{repository_credentials,standingApprovalId}',
      'standingApprovalGeneration',rev.admitted_spec #> '{repository_credentials,standingApprovalGeneration}',
      'standingApprovalScopeFingerprint',rev.admitted_spec #> '{repository_credentials,standingApprovalScopeFingerprint}')
      ELSE '{}'::jsonb END AS session,
  ${proxy ? "s.deadline_wall_ms" : "least(b.deadline_wall_ms, s.deadline_wall_ms)"} AS end_ms,
  ${proxy ? "p.installation #>> '{plan,repositoryGitAuthorization}'" : "NULL"} AS authorization
  FROM occ.repository_session_attempts s
  ${
    proxy
      ? `JOIN ${proxy.evidence.join} JOIN occ.egress_installations p ON ${proxy.evidence.released}`
      : "JOIN occ.repository_broker_receipts b USING(admission_id)"
  }
  JOIN occ.agents g ON g.namespace_id=s.namespace_id AND g.id=s.agent_id AND g.active_revision_id=s.live_revision_id
  JOIN occ.agent_revisions rev ON rev.id=s.live_revision_id AND rev.namespace_id=s.namespace_id AND rev.agent_id=s.agent_id
  CROSS JOIN occ.installation i
  WHERE s.phase='open' AND s.live_revision_id=s.revision_id
  AND ${
    proxy
      ? `s.broker_protocol=2 AND s.session_id IS NOT NULL
    AND rev.admitted_spec #>> '{execution_admission,version}' =
      CASE WHEN p.installation #>> '{plan,policyReductionVersion}' = '2' THEN '7'
        WHEN p.installation #>> '{plan,repositoryGitAuthorization}' = 'online-request' THEN '5'
        WHEN p.installation #>> '{plan,repositoryGitAuthorization}' = 'request-hook-observed' THEN '6'
        ELSE '4' END
    AND p.installation#>'{plan,driver}'=${selectedRepositoryGitDriver}
    AND p.installation->'plan'=rev.admitted_spec->'egress_plan'
    AND p.installation#>'{plan,repositoryGit}'=rev.admitted_spec->'repository_credentials'
    AND clock_timestamp() < to_timestamp(s.deadline_wall_ms / 1000.0)
    `
      : `s.broker_protocol=3 AND b.state='active' AND b.generation IS NOT NULL AND b.session_id=s.session_id
    AND clock_timestamp() < to_timestamp(least(b.deadline_wall_ms, s.deadline_wall_ms) / 1000.0)`
  }
  AND NOT EXISTS (
    SELECT FROM occ.repository_session_attempts old
    WHERE (old.namespace_id,old.agent_id)=(s.namespace_id,s.agent_id)
      AND old.admission_id<>s.admission_id AND old.phase<>'disposed'
      AND (old.cleanup_context #>> '{binding,profile}' = 'github-installation'
        ${proxy ? `OR ${broad} OR old.repository_ref=s.repository_ref` : ""}))
  AND g.status='active' AND g.desired_runtime_state='running' AND g.execution_mode='dedicated'
  AND s.cleanup_context #>> '{binding,profile}' = ${profile}
  AND g.repository_bindings @> jsonb_build_array(jsonb_build_object('repositoryRef',s.repository_ref,'profile',s.cleanup_context #>> '{binding,profile}'))
  AND occ.repository_standing_approval_is_current(rev.admitted_spec->'repository_credentials',s.namespace_id,s.agent_id)
  AND NOT EXISTS (SELECT FROM occ.repository_standing_executions e WHERE e.revision_id=s.revision_id AND e.closed)
  AND (s.predecessor_admission_id IS NULL OR occ.repository_standing_execution_is_current(rev.admitted_spec->'repository_credentials',s.namespace_id,s.agent_id,s.revision_id))
  AND NOT EXISTS (
    SELECT FROM occ.prepared_github_families prior JOIN occ.prepared_github_attempts attempt ON attempt.source_id=prior.source_id
    WHERE prior.source#>>'{session,namespaceId}'=s.namespace_id AND prior.source#>>'{session,agentId}'=s.agent_id
      AND prior.source#>>'{session,admissionId}'<>s.admission_id
      AND NOT ${preparedAttemptSettled("attempt")}
      AND (prior.source->>'adoption'='${installationGitAdoption}'
        OR (prior.source->>'adoption' IN ('${legacyAdoption}','${protectedGitAdoption}') AND ${
          proxy
            ? `(${broad} OR prior.source#>>'{session,binding,repositoryRef}'=s.repository_ref)`
            : `(rev.admitted_spec->'repository_credentials' ? 'standingApprovalId'
            AND prior.source#>>'{session,revisionId}'=s.revision_id)`
        })))
  AND rev.admitted_spec #> '{repository_credentials,driver}'=s.cleanup_context->'driver'
  AND rev.admitted_spec #> '{repository_credentials,bindings}' @> jsonb_build_array(s.cleanup_context->'binding')`;
}

const active = (sessions: string) =>
  `EXISTS (SELECT FROM (${sessions}) l WHERE l.session = f.source->'session')`;

/** Identifies the actual installed sender observation to the transaction recording possible use. */
export interface InstalledGitMaterial {
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
  readonly route?: RepositoryGitInstallationFence;
}

/** Compatibility with the broker-backed OpenShell trial only. Never use at a protected sender. */
function openShellOnlineGitDecision(result: RepositoryGitSendDecision) {
  if (result.kind === "denied") {
    return result.reason === "unavailable" ? false : result.reason;
  }
  return result.kind === "permit" && Date.now() < Date.parse(result.sendStartBy);
}

/**
 * Match standing removal's lock order. The session ID or revision locates the Namespace;
 * it is not authority. Keep the Namespace, Agent and exact approval locked while taking
 * the session and receipt locks, then read the decision at a fresh READ COMMITTED snapshot.
 * In particular, never put the approval-locking predicate in the query that locks the Agent:
 * PostgreSQL can evaluate that predicate before locking the outer row.
 */
async function lockLiveSession(
  c: PostgresClient,
  by: "session_id" | "live_revision_id",
  id: string,
  proxy: Recipient,
): Promise<LockedSession | null | undefined> {
  if (proxy && !proxy.driver) {
    return undefined; // Missing a protected sender is not a withdrawal of its outstanding custody.
  }
  const { rows } = await c.query(
    `SELECT s.namespace_id, s.agent_id, s.live_revision_id, s.admission_id
     FROM occ.repository_session_attempts s JOIN occ.namespaces n ON n.id=s.namespace_id
     WHERE s.${by}=$1 AND s.phase='open' AND n.status='ready' AND n.deleted_at IS NULL
     FOR SHARE OF n`,
    [id],
  );
  // No live session means withdrawn; multiple candidates have no single installation target.
  if (rows.length !== 1) {
    return rows.length === 0 ? null : undefined;
  }
  const { namespace_id, agent_id, live_revision_id, admission_id } = rows[0] as {
    namespace_id: string;
    agent_id: string;
    live_revision_id: string;
    admission_id: string;
  };
  const target = [namespace_id, agent_id, live_revision_id];
  const agent = await c.query(
    `SELECT FROM occ.agents WHERE (namespace_id,id,active_revision_id)=($1,$2,$3)
     AND status='active' AND desired_runtime_state='running' AND execution_mode='dedicated' FOR SHARE`,
    target,
  );
  if (!agent.rowCount) {
    return null;
  }

  // The Agent lock also serializes closure or replacement of its standing execution.
  const exact = `${sessionQuery(proxy)} AND (s.namespace_id,s.agent_id,s.live_revision_id,s.admission_id)=($1,$2,$3,$4)
    AND s.${by}=$5`;
  const identity = [...target, admission_id, id];
  if (!(await c.query(exact, identity)).rowCount) {
    if (!proxy?.driver) {
      return null;
    }
    // An open admission with missing or foreign recipient evidence is unavailable, not withdrawn.
    // Report withdrawal only when this owner's recorded admission has positively ended.
    const ended = await c.query(
      `SELECT FROM ${families} f WHERE f.source_id='repository-git:' || $1
        AND ${repositoryGitOwnerPredicate} AND ${repositoryGitAdmissionEnded}`,
      [admission_id],
    );
    return ended.rowCount ? null : undefined;
  }
  const locked = await c.query(
    `SELECT FROM occ.repository_session_attempts s
     ${
       proxy
         ? `JOIN ${proxy.evidence.join} JOIN occ.egress_installations p USING(namespace_id,agent_id,revision_id)`
         : "JOIN occ.repository_broker_receipts b USING (admission_id)"
     }
     WHERE s.admission_id=$1 FOR SHARE OF s,${proxy ? "r,p" : "b"}`,
    [admission_id],
  );
  const absent = proxy?.driver ? undefined : null;
  if (!locked.rowCount) {
    return absent;
  }
  const current = await c.query(exact, identity);
  return (current.rows[0] as LockedSession | undefined) ?? absent;
}
type LockedSession = {
  session: PreparedRepositorySession;
  end_ms: string;
  authorization: "online-request" | "request-hook-observed" | null;
};
type Authorization = LockedSession["authorization"];
type GitUse = Pick<
  RepositoryGitSendPermit,
  "exchangeId" | "requestDigestSha256" | "preparationAttemptId" | "materialVersion"
>;
const sendPermit = (use: GitUse, sendStartBy: string) =>
  ({ ...use, kind: "permit", sendStartBy }) as const;
const onlineAllow = (use: GitUse, replyBy: string) => ({ ...use, kind: "allow", replyBy }) as const;

export interface PreparedRepositoryGitSource {
  readonly adoption:
    typeof legacyAdoption | typeof protectedGitAdoption | typeof installationGitAdoption;
  readonly key: { source: { id: string } };
  readonly session: PreparedRepositorySession;
  readonly grant: GitHubPreparationAdmission["grant"] &
    (
      | { profile: "git-ref-write" | "git-ref-draft-pr"; pushRef: string }
      | { profile: "github-installation" }
    );
  /** The registry's opt-out of the one-draft limit; honored by the protected sender only. */
  readonly draftPullLimit?: "none";
}
type Policy = (session: PreparedRepositorySession) => PreparedRepositoryGitSource | undefined;

/** An ended admission is withdrawn. Incomplete recipient or material evidence is unprepared. */
export interface RepositoryGitMaterialAbsence {
  readonly absent: "withdrawn" | "unprepared";
}

/** A family of an earlier issuer authority that discovery retired without revoking. */
export interface PreparedRepositoryGitForeignRetirement {
  readonly namespaceId: string;
  readonly revisionId: string;
  readonly repositoryRef: string;
  readonly providerExpiresAt: string;
}

export class PreparedRepositoryGitStore extends PreparedGitHubPostgres {
  private readonly deliveryWorker = randomUUID();
  private readonly authority: string;
  private readonly policy: Policy;
  private readonly proxy: Recipient;
  private readonly adoption: readonly PreparedRepositoryGitSource["adoption"][];

  constructor(
    pool: PostgresPool,
    key: Buffer,
    authority: string,
    policy: Policy,
    recipient?: DriverRegistrationRef | "unregistered",
    evidence: RepositoryGitRecipientEvidence = registeredGitRecipientEvidence,
  ) {
    const driver = typeof recipient === "object" ? recipient : undefined;
    const proxy: Recipient = driver
      ? { driver, evidence }
      : recipient
        ? { evidence: openShellGitRecipientEvidence }
        : undefined;
    const adoption: PreparedRepositoryGitSource["adoption"][] = [
      driver ? protectedGitAdoption : legacyAdoption,
    ];
    if (installationRecipient(proxy)) {
      adoption.push(installationGitAdoption);
    }
    super(pool, key, authority, {
      active: active(sessionQuery(proxy)),
      // Fence an issuance intent against a concurrently replaced active revision. After the
      // Agent lock is acquired, store() checks live authority at a new READ COMMITTED snapshot.
      lockIssuance: `SELECT FROM occ.agents WHERE (namespace_id,id) =
        ($1::jsonb #>> '{session,namespaceId}', $1::jsonb #>> '{session,agentId}') FOR SHARE`,
      adoption,
      owns: driver
        ? repositoryGitOwnerPredicate
        : proxy
          ? "false"
          : repositoryGitBrokerOwnerPredicate,
      ...(driver && { driver }),
    });
    this.proxy = proxy;
    this.adoption = adoption;
    this.authority = authority;
    this.policy = policy;
  }

  /** Background discovery only. Admission and key lookup are not reachable from use().
   * `onForeignRetired` is told, after commit, of each family of an earlier issuer authority
   * (another GitHub API origin or CA) retired in this pass: its token cannot be revoked here. */
  async discover(
    onForeignRetired?: (retired: PreparedRepositoryGitForeignRetirement) => void,
  ): Promise<PreparedRepositoryGitSource[]> {
    const sessions = sessionQuery(this.proxy);
    const live = active(sessions);
    const ended = !this.proxy
      ? `NOT ${live}`
      : this.proxy.evidence === openShellGitRecipientEvidence
        ? `(${repositoryGitAdmissionEnded} OR ${openShellPreviewEnded})`
        : repositoryGitAdmissionEnded;
    const { sources, foreign } = await this.transaction(async (c) => {
      // Denial doesn't depend on this cleanup. Keep attempts, including unknown issuance, for recovery.
      // Only the recipient owner can act on positive evidence that OCC ended its admission.
      // Queue an old issuer's obligation too, but never send its material to the new issuer.
      const { rows: retired } = await c.query(
        `WITH stopped AS (
        UPDATE ${families} f SET enabled=false
        WHERE enabled AND ${this.retiringFamily("$1", ended)}
        RETURNING source_id, source, admission->>'issuerAuthority' IS DISTINCT FROM $2 AS foreign),
        moved AS (UPDATE ${attempts} a SET custody='retire' FROM stopped s
        WHERE a.source_id=s.source_id AND custody='current' RETURNING a.source_id, a.provider_expires_at)
        SELECT s.source->'session' AS session, m.provider_expires_at
        FROM stopped s JOIN moved m USING (source_id) WHERE s.foreign`,
        [this.adoption, this.authority],
      );
      const { rows } = await c.query(sessions);
      return {
        sources: (rows as { session: PreparedRepositorySession }[]).flatMap(
          ({ session }) => this.policy(session) ?? [],
        ),
        foreign: retired as { session: PreparedRepositorySession; provider_expires_at: Date }[],
      };
    });
    for (const { session, provider_expires_at: expires } of foreign) {
      onForeignRetired?.({
        namespaceId: session.namespaceId,
        revisionId: session.revisionId,
        repositoryRef: session.binding.repositoryRef,
        providerExpiresAt: expires.toISOString(),
      });
    }
    return sources;
  }

  async claimGit(
    source: PreparedRepositoryGitSource,
    version: string,
  ): Promise<GitHubPreparationAdmission | undefined> {
    const sessions = sessionQuery(this.proxy);
    const live = active(sessions);
    const familyId = source.key.source.id;
    const admission: GitHubPreparationAdmission = {
      familyId,
      issuerAuthority: this.authority,
      generation: 1,
      ownerEpoch: 1,
      inputVersion: version,
      grant: source.grant,
    };
    return this.transaction(async (c) => {
      await c.query(
        `INSERT INTO ${families}(source_id,source,issuer,admission)
        SELECT $1, $2::jsonb, '{"kind":"worker-mounted-github-app-key"}', $3::jsonb
        FROM (${sessions}) l WHERE l.session=$2::jsonb->'session'
        ON CONFLICT (source_id) DO NOTHING`,
        [familyId, source, admission],
      );
      // A rotated App key fences the old material. It never clears an uncertain preparation attempt.
      await c.query(
        `WITH rotated AS (
        UPDATE ${families} f SET admission = f.admission || jsonb_build_object(
          'inputVersion', $3::text, 'ownerEpoch', (f.admission->>'ownerEpoch')::integer+1),
          next_check_at=clock_timestamp()
        WHERE source_id=$1 AND enabled AND f.source=$2::jsonb AND admission->>'issuerAuthority'=$4
          AND f.admission->>'inputVersion' <> $3 AND ${live} RETURNING source_id)
        UPDATE ${attempts} a SET custody='retire' FROM rotated r
        WHERE a.source_id=r.source_id AND custody='current'`,
        [familyId, source, version, this.authority],
      );
      const { rows } = await c.query(
        `UPDATE ${families} f SET next_check_at=clock_timestamp() + interval '60 seconds'
        WHERE source_id=$1 AND enabled AND source=$2::jsonb AND admission->>'inputVersion'=$3 AND admission->>'issuerAuthority'=$4
        AND next_check_at <= clock_timestamp() AND ${live} RETURNING admission`,
        [familyId, source, version, this.authority],
      );
      return (rows[0] as { admission: GitHubPreparationAdmission } | undefined)?.admission;
    });
  }

  /** This port exists only on a selected Driver. It carries no issuer, connection or maintenance authority. */
  protectedAuthority(
    stopped: AbortSignal,
    checkRequest: {
      (input: unknown): PreparedGitHubUseRequest;
      (input: unknown, scope: "github-installation"): PreparedGitHubInstallationUseRequest;
    },
  ): ProtectedRepositoryGitAuthority | undefined {
    if (!this.proxy?.driver) {
      return;
    }
    const delivery = <Allow extends RepositoryGitSendPermit | RepositoryGitOnlineAllow>(
      mode: Authorization,
      decide: (receipt: GitUse, deadline: string) => Allow,
    ): RepositoryGitAuthority<Allow> => {
      const scope = "github-installation";
      const lifetime = (signal: AbortSignal) => AbortSignal.any([stopped, signal]);
      return Object.freeze({
        ...(installationRecipient(this.proxy) && {
          githubInstallation: Object.freeze({
            readMaterial: (route, signal) =>
              this.readRecipientMaterial(route.revisionId, lifetime(signal), route, scope, mode),
            authorize: async (request, installed, signal) => {
              const q = checkRequest(request, scope);
              const binding = structuredClone(installed);
              const decision = await this.authorizeProtectedRequest(
                q,
                binding,
                lifetime(signal),
                mode,
                decide,
              );
              if (decision.kind === "denied") {
                return decision;
              }
              const { revisionId, fence } = binding.route;
              return { ...decision, scope, operation: q.operation, revisionId, fence };
            },
          } satisfies NonNullable<RepositoryGitAuthority<Allow>["githubInstallation"]>),
        }),
        readMaterial: (route, signal) =>
          this.readRecipientMaterial(route.revisionId, lifetime(signal), route, undefined, mode),
        authorize: (request, installed, signal) =>
          this.authorizeProtectedRequest(
            checkRequest(request),
            structuredClone(installed),
            lifetime(signal),
            mode,
            decide,
          ),
      } satisfies RepositoryGitAuthority<Allow>);
    };
    return Object.freeze({
      recipients: this.recipients,
      ...delivery(null, sendPermit),
      online: delivery("online-request", onlineAllow),
      ...(this.proxy.evidence === openShellGitRecipientEvidence && {
        observedHook: delivery("request-hook-observed", onlineAllow).githubInstallation!,
      }),
    });
  }

  private async deliveryKey(c: PostgresClient, revisionId: string, observed: unknown) {
    const { rows } = await c.query(
      `SELECT binding_id FROM occ.credential_deliveries
       WHERE revision_id=$1 AND target->>'transport'='${repositoryGitDeliveryTransport}'
         AND target->'installation'=$2::jsonb
         AND target#>'{installation,plan,driver}'=${selectedRepositoryGitDriver}`,
      [revisionId, JSON.stringify(observed)],
    );
    return rows.length === 1
      ? { revisionId, bindingId: (rows[0] as { binding_id: string }).binding_id }
      : undefined;
  }

  private readonly recipients: ProtectedRepositoryGitAuthority["recipients"] = Object.freeze({
    observe: async (installation) => {
      if (this.proxy?.evidence !== registeredGitRecipientEvidence) {
        return;
      }
      return this.transaction(async (c) => {
        const revisionId = installation.plan.execution.revisionId;
        const same = `p.revision_id=$1 AND p.installation=$2::jsonb
          AND p.installation#>'{plan,driver}' = ${selectedRepositoryGitDriver}`;
        const values = [revisionId, JSON.stringify(installation)];
        // Keep the Driver's independent GET equal to the committed Compute release.
        const released = await c.query(
          `SELECT FROM occ.egress_installations p WHERE ${same}
           AND p.installation#>>'{enforcement,authorityScope}'='execution'
           AND ${validRecipient} AND ${registeredGitSelection}`,
          values,
        );
        if (released.rowCount !== 1) {
          return;
        }
        const fence = await new CredentialDeliveries(c).observe(
          { ...installation.plan.execution, bindingId: installation.plan.execution.executionId },
          { transport: repositoryGitDeliveryTransport, installation },
          this.deliveryWorker,
        );
        if (fence !== undefined) {
          return { revisionId, fence, observed: installation };
        }
      });
    },
    beginInstall: async (route, { preparationAttemptId, materialVersion }) => {
      if (this.proxy?.evidence !== registeredGitRecipientEvidence) {
        return;
      }
      return this.transaction(async (c) => {
        const { revisionId, observed } = route;
        const current = await lockLiveSession(c, "live_revision_id", revisionId, this.proxy);
        const source = current && this.policy(current.session);
        const version = { preparationAttemptId, materialVersion };
        if (!source || !(await this.tokens.current(c, source, version))) {
          return;
        }
        const key = await this.deliveryKey(c, revisionId, observed);
        if (!key) {
          return;
        }
        const fence = await new CredentialDeliveries(c).beginInstall(
          key,
          route.fence,
          { transport: repositoryGitDeliveryTransport, installation: observed },
          version,
        );
        if (fence !== undefined) {
          return { revisionId, observed, fence, ...version };
        }
      });
    },
    confirmInstall: async ({
      revisionId,
      observed,
      fence,
      preparationAttemptId,
      materialVersion,
    }) => {
      if (this.proxy?.evidence !== registeredGitRecipientEvidence) {
        return;
      }
      // Settle the observed effect, even if authority ended. This never confers permission to send.
      return this.transaction(async (c) => {
        const key = await this.deliveryKey(c, revisionId, observed);
        if (!key) {
          return;
        }
        const currentFence = await new CredentialDeliveries(c).confirmInstall(
          key,
          fence,
          { transport: repositoryGitDeliveryTransport, installation: observed },
          { preparationAttemptId, materialVersion },
        );
        if (currentFence !== undefined) {
          return { revisionId, fence: currentFence, observed };
        }
      });
    },
  } satisfies ProtectedRepositoryGitAuthority["recipients"]);

  /** Reads existing material for the worker's selected revision, never a workload request.
   * This neither prepares material nor grants permission to send. Each later request must
   * still authorize the exact installed attempt/version against current session authority. */
  async readRecipientMaterial(
    revisionId: string,
    signal: AbortSignal,
    install?: RepositoryGitInstallationFence,
    scope?: undefined,
    mode?: Authorization,
  ): Promise<ProtectedRepositoryGitMaterial | RepositoryGitMaterialAbsence | undefined>;
  async readRecipientMaterial(
    revisionId: string,
    signal: AbortSignal,
    install: RepositoryGitInstallationFence,
    scope: "github-installation",
    mode?: Authorization,
  ): Promise<ProtectedGitHubInstallationMaterial | RepositoryGitMaterialAbsence | undefined>;
  async readRecipientMaterial(
    revisionId: string,
    signal: AbortSignal,
    install?: RepositoryGitInstallationFence,
    scope?: "github-installation",
    mode: Authorization = null,
  ): Promise<
    | ProtectedRepositoryGitMaterial
    | ProtectedGitHubInstallationMaterial
    | RepositoryGitMaterialAbsence
    | undefined
  > {
    let bytes: Buffer | undefined;
    const withdrawn: RepositoryGitMaterialAbsence = Object.freeze({ absent: "withdrawn" });
    const unprepared: RepositoryGitMaterialAbsence = Object.freeze({ absent: "unprepared" });
    try {
      signal.throwIfAborted();
      const result = await this.transaction(async (c) => {
        const current = await lockLiveSession(c, "live_revision_id", revisionId, this.proxy);
        if (!current) {
          return current === null ? withdrawn : unprepared;
        }
        if (this.proxy) {
          // The session transaction holds the current route, approval and Agent. Only the
          // conditional installer may receive a token; a changed fence or observation gets none.
          if (
            current.authorization !== mode ||
            !install ||
            install.revisionId !== revisionId ||
            !(
              await c.query(this.proxy.evidence.observed, [
                revisionId,
                install.fence,
                JSON.stringify(install.observed),
              ])
            ).rowCount
          ) {
            return unprepared;
          }
        }
        const source = this.policy(current.session);
        if (!source) {
          // The registry no longer admits this binding.
          return withdrawn;
        }
        // The compatibility material/online paths never receive the installation credential.
        const wide = scope === "github-installation";
        const { grant } = source;
        if (
          wide !== (source.adoption === installationGitAdoption) ||
          wide !== (grant.profile === "github-installation") ||
          (wide && (!install || !installationRecipient(this.proxy)))
        ) {
          return unprepared;
        }
        const material = await this.tokens.readWarm(c, source);
        if (!material) {
          return unprepared;
        }
        const { preparationAttemptId, materialVersion } = material;
        const until = Math.min(Number(current.end_ms), material.usableUntil);
        if (signal.aborted || !(Date.now() < until)) {
          return unprepared;
        }
        bytes = material.open();
        return {
          expiresAt: new Date(until).toISOString(),
          preparationAttemptId,
          materialVersion,
          sessionId: current.session.sessionId,
          apiOrigin: this.authority.split("#")[0]!,
          ...(grant.profile === "github-installation"
            ? {
                scope: grant.profile,
                grantId: grant.id,
                installationId: grant.installationId,
                providerInstanceId: current.session.binding.grant.providerInstanceId,
              }
            : {
                ...current.session.binding.grant,
                repository: grant.repository,
                pushRef: grant.pushRef,
                ...(grant.pullRequestBase ? { pullRequestBase: grant.pullRequestBase } : {}),
              }),
        };
      });
      signal.throwIfAborted();
      if (!result || "absent" in result) {
        return result;
      }
      if (!bytes || Date.now() >= Date.parse(result.expiresAt)) {
        return unprepared;
      }
      return Object.freeze({
        ...result,
        value: bytes.toString("utf8"),
      });
    } finally {
      bytes?.fill(0);
    }
  }

  /** Only the protocol-1 broker trial may use a decision that omits the send-start deadline. */
  async authorizeOpenShellRequest(
    q: PreparedGitHubUseRequest,
    installed: InstalledGitMaterial,
    signal: AbortSignal,
  ): Promise<boolean | "draft_already_opened" | "access_withdrawn"> {
    if (this.proxy) {
      return false;
    }
    return openShellOnlineGitDecision(
      await this.authorizeProtectedRequest(q, installed, signal, null, sendPermit),
    );
  }

  /** Only a confirmed commit can return an allow or send permit. The authenticated recipient already
   * holds this exact material. The durable receipt records possible use, never delivery. */
  private async authorizeProtectedRequest<
    Allow extends RepositoryGitOnlineAllow | RepositoryGitSendPermit,
  >(
    q: PreparedGitHubUseRequest | PreparedGitHubInstallationUseRequest,
    installed: InstalledGitMaterial,
    signal: AbortSignal,
    mode: Authorization,
    decide: (receipt: GitUse, deadline: string) => Allow,
  ): Promise<Allow | Extract<RepositoryGitSendDecision, { kind: "denied" }>> {
    const denied = { kind: "denied", reason: "unavailable" } as const;
    if (!installed?.preparationAttemptId || !installed.materialVersion) {
      return denied;
    }
    // transaction() replaces every error with a redacted one, so the refusal class is noted here.
    let reason: Extract<RepositoryGitSendDecision, { kind: "denied" }>["reason"] = denied.reason;
    try {
      const result = await this.transaction(async (c) => {
        try {
          return await this.recordUse(c, q, signal, installed, mode);
        } catch (error) {
          reason =
            error instanceof DraftAlreadyOpened
              ? "draft_already_opened"
              : error instanceof SessionClosed
                ? "access_withdrawn"
                : "unavailable";
          throw error;
        }
      });
      if ("kind" in result || signal.aborted || !(Date.now() < Date.parse(result.decisionBy))) {
        return denied;
      }
      const { exchangeId, requestDigestSha256, preparationAttemptId, materialVersion, decisionBy } =
        result;
      return Object.freeze(
        decide(
          { exchangeId, requestDigestSha256, preparationAttemptId, materialVersion },
          decisionBy,
        ),
      );
    } catch {
      // A lost commit acknowledgment may leave a receipt. Never retry or turn it into an allow.
      return { kind: "denied", reason };
    }
  }

  /** Lock against admission withdrawal and material rotation. If commit is uncertain the copy is
   * discarded, but its non-secret use receipt may have committed. Never retry an exchange. */
  async use(
    q: PreparedGitHubUseRequest,
    signal: AbortSignal,
  ): Promise<PreparedGitHubUseResponse | OperationReceipt> {
    let bytes: Buffer | undefined;
    try {
      const result = await this.transaction(async (c) => {
        const decision = await this.recordUse(c, q, signal);
        if ("kind" in decision) {
          return decision;
        }
        const {
          open,
          exchangeId,
          preparationAttemptId,
          materialVersion,
          decisionBy: sendStartBy,
        } = decision;
        const receipt = { exchangeId, preparationAttemptId, materialVersion, sendStartBy };
        if (!open || signal.aborted || Date.now() >= Date.parse(receipt.sendStartBy)) {
          throw new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
        }
        // Under the same material lock, with no await between this check and open.
        bytes = open();
        return receipt;
      });
      if ("kind" in result) {
        return result;
      }
      if (!bytes || signal.aborted || Date.now() >= Date.parse(result.sendStartBy)) {
        throw new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
      }
      return {
        ...result,
        value: bytes.toString("utf8"),
      };
    } finally {
      bytes?.fill(0);
    }
  }

  private async recordUse(
    c: PostgresClient,
    q: PreparedGitHubUseRequest | PreparedGitHubInstallationUseRequest,
    signal: AbortSignal,
    installed?: InstalledGitMaterial,
    mode: Authorization = null,
  ) {
    const deadline = Date.parse(q.deadlineAt);
    const valid = (until: number) => !signal.aborted && Date.now() < until;
    const fail = (): never => {
      throw new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
    };
    if (!valid(deadline) || deadline > Date.now() + 30_000) {
      return fail();
    }
    if (this.proxy && !installed?.route) {
      return fail(); // This admission never serves the native token-returning operation.
    }
    const current = await lockLiveSession(c, "session_id", q.sessionId, this.proxy);
    const source = current && this.policy(current.session);
    if (installed && current !== undefined && (!current || !source)) {
      // The session ended or the registry no longer admits it. Missing recipient evidence just denies.
      throw new SessionClosed();
    }
    if (!source || !current || current.authorization !== mode) {
      return fail();
    }
    const { grant } = source;
    const installation = "installationId" in q;
    let repositoryId;
    if (installation) {
      if (
        source.adoption !== installationGitAdoption ||
        grant.profile !== "github-installation" ||
        !installed ||
        !installationRecipient(this.proxy) ||
        grant.installationId !== q.installationId
      ) {
        return fail();
      }
      // The admission contract calls this opaque selection identity repositoryId.
      // The provider request and installation sender port carry the actual installationId.
      repositoryId = "github-installation:" + grant.installationId;
    } else {
      if (grant.profile === "github-installation" || grant.pushRef !== q.pushRef) {
        return fail();
      }
      repositoryId = q.repositoryId;
    }
    if (
      !isDeepStrictEqual(current.session.binding.grant, {
        providerInstanceId: q.providerInstanceId,
        repositoryId,
        grantId: q.grantId,
      })
    ) {
      return fail();
    }
    if (this.proxy) {
      const { revisionId, fence, observed } = installed!.route!;
      if (
        revisionId !== current.session.revisionId ||
        !(
          await c.query(this.proxy.evidence.installed, [
            revisionId,
            fence,
            JSON.stringify(observed),
            installed!.preparationAttemptId,
            installed!.materialVersion,
          ])
        ).rowCount
      ) {
        return fail();
      }
    }
    // Authority and live-session locks above apply equally to reads of an existing receipt.
    // The grant controls how many drafts may be opened. Every new authorized exchange
    // records possible use, independently of whether it also consumes that one-draft allowance.
    const unlimited = installed !== undefined && source.draftPullLimit === "none";
    let scope: PullRow["scope"] | undefined;
    if (q.operation === "create-draft-pull") {
      const pull = q.pull;
      if (
        !pull ||
        grant.profile !== "git-ref-draft-pr" ||
        !draftOperationId.test(pull.operationId) ||
        pull.repository !== grant.repository ||
        "refs/heads/" + pull.head !== grant.pushRef ||
        pull.head === pull.base ||
        pull.base !== grant.pullRequestBase ||
        !pull.apiOrigin ||
        pull.apiOrigin !== this.authority.split("#")[0]
      ) {
        return fail();
      }
      const { operationId, apiOrigin, repository, head, base } = pull;
      scope = { operationId, apiOrigin, repository, head, base, repositoryId: q.repositoryId };
      const {
        rows: [prior],
      } = unlimited
        ? { rows: [] }
        : await c.query(`SELECT * FROM ${pulls} WHERE grant_id=$1`, [q.grantId]);
      if (prior) {
        if (installed) {
          throw new DraftAlreadyOpened();
        }
        const row = prior as PullRow;
        return pullReceipt(
          row,
          row.admission_id !== current.session.admissionId ||
            row.operation_id !== pull.operationId ||
            row.request_digest_sha256 !== q.requestDigestSha256 ||
            !isDeepStrictEqual(row.scope, scope),
        );
      }
    } else if ("pull" in q && q.pull) {
      return fail();
    }
    // The same transaction keeps both live authority and the selected version locked until the
    // use (and, when applicable, the grant's draft allowance) commits. The protected sender already has the
    // installed material; only the explicitly selected native sender may open it here.
    const material = installed
      ? await this.tokens.current(c, source, installed)
      : await this.tokens.readWarm(c, source);
    if (!material) {
      return fail();
    }
    const { preparationAttemptId, materialVersion } = material;
    const until = Math.min(
      Date.now() + 5000,
      deadline,
      Number(current.end_ms),
      material.usableUntil,
    );
    if (!valid(until)) {
      return fail();
    }
    const decisionBy = new Date(until).toISOString();
    const deadlineColumn = mode === null ? "send_start_by" : "authorization_reply_by";
    const { exchangeId, requestDigestSha256 } = q;
    if (scope && !unlimited) {
      // A possibly spent allowance outlives this session, including an unknown commit or send.
      const claim = await c.query(
        `INSERT INTO ${pulls}
         (grant_id,operation_id,receipt_id,admission_id,attempt_id,material_version,request_digest_sha256,scope,${deadlineColumn})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (grant_id) DO NOTHING RETURNING receipt_id`,
        [
          q.grantId,
          scope.operationId,
          exchangeId,
          current.session.admissionId,
          preparationAttemptId,
          materialVersion,
          requestDigestSha256,
          scope,
          decisionBy,
        ],
      );
      if (!claim.rowCount) {
        return fail();
      }
    }
    await c.query(
      `INSERT INTO occ.prepared_repository_git_uses
    (exchange_id,admission_id,attempt_id,material_version,operation,request_digest_sha256,${deadlineColumn},recipient_fence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        exchangeId,
        current.session.admissionId,
        preparationAttemptId,
        materialVersion,
        q.operation,
        requestDigestSha256,
        decisionBy,
        installation ? installed!.route!.fence : null,
      ],
    );
    if (!valid(until)) {
      return fail();
    }
    return {
      decisionBy,
      exchangeId,
      requestDigestSha256,
      preparationAttemptId,
      materialVersion,
      open: material.open,
    };
  }

  /** The original sender may settle once, including after withdrawal; no authority is released here. */
  async finishPull(receiptId: string, result: PreparedGitHubPullResult): Promise<OperationReceipt> {
    if (!draftOperationId.test(receiptId)) {
      throw new Error("invalid-operation-receipt");
    }
    return this.transaction(async (c) => {
      const {
        rows: [saved],
      } = await c.query(`SELECT * FROM ${pulls} WHERE receipt_id=$1 FOR UPDATE`, [receiptId]);
      const row = saved as PullRow | undefined;
      if (!row || row.settled_at) {
        throw new Error("operation-already-settled");
      }
      if (typeof result === "object" && result && "created" in result) {
        row.projection = validateDraftProjection(result.created, row.scope);
        row.outcome = "created";
      } else if (result === "outcome_unknown" || result === "not-submitted") {
        row.outcome = result;
      } else {
        throw new Error("invalid-operation-result");
      }
      await c.query(
        `UPDATE ${pulls} SET outcome=$2, projection=$3::jsonb, settled_at=clock_timestamp()
        WHERE receipt_id=$1 AND settled_at IS NULL`,
        [receiptId, row.outcome, row.projection],
      );
      return pullReceipt(row);
    });
  }
}
