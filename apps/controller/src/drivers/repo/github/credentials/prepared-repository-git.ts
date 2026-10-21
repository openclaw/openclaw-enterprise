import type {
  PreparedGitHubUseRequest,
  PreparedGitHubPullResult,
  PreparedGitHubPullScope,
  PreparedGitHubPullProjection,
  PreparedGitHubUseResponse,
  RepositoryRevisionState,
} from "@openclaw-enterprise/contracts";
import type { PostgresClient, PostgresPool } from "@openclaw-enterprise/occ";
import type { OperationReceipt } from "../../credentials/backend-contracts.ts";
import { draftOperationId, validateDraftProjection } from "./prepared-draft-pull.ts";
import { isDeepStrictEqual } from "node:util";
import { PreparedGitHubPostgres } from "./prepared-postgres.ts";
import type { GitHubPreparationAdmission } from "./prepared-contracts.ts";
import { protectedRepositoryGitInstallationSql } from "../../../egress-proxy/protected-repository-git-installation.ts";

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

/** The grant's one draft create was already claimed: on the OpenShell route a second one is
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

const adoption = "prepared_repository_git";
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
function sessionQuery(proxy: boolean): string {
  return `SELECT jsonb_build_object(
  'namespaceId',s.namespace_id, 'agentId',s.agent_id, 'revisionId',s.live_revision_id,
  'installationId',i.id, 'admissionId',s.admission_id, 'sessionId',s.session_id,
  ${
    proxy
      ? `'credentialProxyExecution', jsonb_build_object('executionId',r.binding_id,'sandboxId',p.sandbox_id,
        'sender',p.installation->'sender','enforcement',p.installation->'enforcement')`
      : "'brokerGeneration',b.generation"
  }, 'driver',s.cleanup_context->'driver', 'binding',s.cleanup_context->'binding',
  'grant',s.cleanup_context #> '{binding,grant}') ||
    CASE WHEN rev.admitted_spec->'repository_credentials' ? 'standingApprovalId' THEN jsonb_build_object(
      'standingApprovalId',rev.admitted_spec #> '{repository_credentials,standingApprovalId}',
      'standingApprovalGeneration',rev.admitted_spec #> '{repository_credentials,standingApprovalGeneration}',
      'standingApprovalScopeFingerprint',rev.admitted_spec #> '{repository_credentials,standingApprovalScopeFingerprint}')
      ELSE '{}'::jsonb END AS session,
  ${proxy ? "s.deadline_wall_ms" : "least(b.deadline_wall_ms, s.deadline_wall_ms)"} AS end_ms
  FROM occ.repository_session_attempts s
  ${
    proxy
      ? `JOIN occ.openshell_git_routes r USING(revision_id, namespace_id, agent_id)
    JOIN occ.egress_installations p ON ${protectedRepositoryGitInstallationSql}
      AND r.blocked IS NULL AND r.detach_request_id IS NULL`
      : "JOIN occ.repository_broker_receipts b USING(admission_id)"
  }
  JOIN occ.agents g ON g.namespace_id=s.namespace_id AND g.id=s.agent_id AND g.active_revision_id=s.live_revision_id
  JOIN occ.agent_revisions rev ON rev.id=s.live_revision_id AND rev.namespace_id=s.namespace_id AND rev.agent_id=s.agent_id
  CROSS JOIN occ.installation i
  WHERE s.phase='open' AND s.live_revision_id=s.revision_id
  AND ${
    proxy
      ? `s.broker_protocol=2 AND s.session_id IS NOT NULL
    AND rev.admitted_spec #>> '{execution_admission,version}' = '4'
    AND p.installation->'plan'=rev.admitted_spec->'egress_plan'
    AND p.installation#>'{plan,repositoryGit}'=rev.admitted_spec->'repository_credentials'
    AND clock_timestamp() < to_timestamp(s.deadline_wall_ms / 1000.0)
    AND NOT EXISTS (SELECT FROM occ.repository_session_attempts old
        WHERE (old.namespace_id,old.agent_id,old.repository_ref)=(s.namespace_id,s.agent_id,s.repository_ref)
        AND old.admission_id<>s.admission_id AND old.phase<>'disposed')`
      : `s.broker_protocol=1 AND b.state='active' AND b.generation IS NOT NULL AND b.session_id=s.session_id
    AND clock_timestamp() < to_timestamp(least(b.deadline_wall_ms, s.deadline_wall_ms) / 1000.0)`
  }

  AND g.status='active' AND g.desired_runtime_state='running' AND g.execution_mode='dedicated'
  AND s.cleanup_context #>> '{binding,profile}' = 'git-write'
  AND g.repository_bindings @> jsonb_build_array(jsonb_build_object('repositoryRef',s.repository_ref,'profile','git-write'))
  AND occ.repository_standing_approval_is_current(rev.admitted_spec->'repository_credentials',s.namespace_id,s.agent_id)
  AND NOT EXISTS (SELECT FROM occ.repository_standing_executions e WHERE e.revision_id=s.revision_id AND e.closed)
  AND (s.predecessor_admission_id IS NULL OR occ.repository_standing_execution_is_current(rev.admitted_spec->'repository_credentials',s.namespace_id,s.agent_id,s.revision_id))
  AND (${proxy ? "false" : "NOT (rev.admitted_spec->'repository_credentials' ? 'standingApprovalId')"} OR NOT EXISTS (
    SELECT FROM occ.prepared_github_families prior JOIN occ.prepared_github_attempts attempt ON attempt.source_id=prior.source_id
    WHERE prior.source->>'adoption'='prepared_repository_git'
      AND ${
        proxy
          ? `prior.source#>>'{session,namespaceId}'=s.namespace_id
        AND prior.source#>>'{session,agentId}'=s.agent_id
        AND prior.source#>>'{session,binding,repositoryRef}'=s.repository_ref`
          : "prior.source #>> '{session,revisionId}'=s.revision_id"
      }
      AND prior.source #>> '{session,admissionId}'<>s.admission_id
      AND attempt.custody NOT IN ('revoked','expired')))
  AND rev.admitted_spec #> '{repository_credentials,driver}'=s.cleanup_context->'driver'
  AND rev.admitted_spec #> '{repository_credentials,bindings}' @> jsonb_build_array(s.cleanup_context->'binding')`;
}

const active = (sessions: string) =>
  `EXISTS (SELECT FROM (${sessions}) l WHERE l.session = f.source->'session')`;

/** Identifies the actual installed sender observation to the transaction recording possible use. */
export interface InstalledGitMaterial {
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
  readonly route?: GitInstallationFence;
}
export interface GitInstallationFence {
  readonly revisionId: string;
  readonly fence: number;
  /** Nonsecret result of verifying the provider and supervisor, including its installed policy. */
  readonly observed: unknown;
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
  proxy: boolean,
): Promise<LockedSession | null | undefined> {
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
    return null;
  }
  const locked = await c.query(
    `SELECT FROM occ.repository_session_attempts s
     ${
       proxy
         ? `JOIN occ.openshell_git_routes r USING(namespace_id,agent_id,revision_id)
            JOIN occ.egress_installations p USING(namespace_id,agent_id,revision_id)`
         : "JOIN occ.repository_broker_receipts b USING (admission_id)"
     }
     WHERE s.admission_id=$1 FOR SHARE OF s,${proxy ? "r,p" : "b"}`,
    [admission_id],
  );
  if (!locked.rowCount) {
    return null;
  }
  const current = await c.query(exact, identity);
  return (current.rows[0] as LockedSession | undefined) ?? null;
}
type LockedSession = { session: PreparedRepositorySession; end_ms: string };

export interface PreparedRepositoryGitSource {
  readonly adoption: typeof adoption;
  readonly key: { source: { id: string } };
  readonly session: PreparedRepositorySession;
  readonly grant: GitHubPreparationAdmission["grant"] & {
    profile: "git-ref-write" | "git-ref-draft-pr";
    pushRef: string;
  };
  /** The registry's opt-out of the one-draft limit; honored on the OpenShell route only. */
  readonly draftPullLimit?: "none";
}
type Policy = (session: PreparedRepositorySession) => PreparedRepositoryGitSource | undefined;

/** Why a revision has no OpenShell material: no live admitted session (`withdrawn`), or a live
 * session with no usable committed material (`unprepared`). */
export interface OpenShellMaterialAbsence {
  readonly absent: "withdrawn" | "unprepared";
}

/** A family of an earlier issuer authority that discovery retired without revoking. */
export interface PreparedRepositoryGitForeignRetirement {
  readonly namespaceId: string;
  readonly revisionId: string;
  readonly repositoryRef: string;
  readonly providerExpiresAt: string;
}

/** Private worker-plane material. Never serialize this through a workload-facing service. */
export interface OpenShellRepositoryMaterial {
  readonly value: string;
  readonly expiresAt: string;
  readonly preparationAttemptId: string;
  readonly materialVersion: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly repositoryId: string;
  readonly grantId: string;
  readonly repository: string;
  readonly pushRef: string;
  readonly pullRequestBase?: string;
  readonly apiOrigin: string;
}

export class PreparedRepositoryGitStore extends PreparedGitHubPostgres {
  private readonly authority: string;
  private readonly policy: Policy;
  private readonly proxy: boolean;
  constructor(pool: PostgresPool, key: Buffer, authority: string, policy: Policy, proxy = false) {
    super(pool, key, authority, { active: active(sessionQuery(proxy)), adoption });
    this.proxy = proxy;
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
    const { sources, foreign } = await this.transaction(async (c) => {
      // Denial doesn't depend on this cleanup. Keep attempts, including unknown issuance, for recovery.
      // Families of every issuer authority retire once their session is no longer live: after
      // the registry moves to another App or CA, the previous authority's families for replaced
      // versions would otherwise stay enabled with current material (finding 2150). Revocation
      // (takeRetirement) still never sends a token to an authority other than its own.
      const { rows: retired } = await c.query(
        `WITH stopped AS (
        UPDATE ${families} f SET enabled=false
        WHERE enabled AND source->>'adoption'=$1 AND (source->'session' ? 'credentialProxyExecution')=$3 AND NOT ${live}
        RETURNING source_id, source, admission->>'issuerAuthority' IS DISTINCT FROM $2 AS foreign),
        moved AS (UPDATE ${attempts} a SET custody='retire' FROM stopped s
        WHERE a.source_id=s.source_id AND custody='current' RETURNING a.source_id, a.provider_expires_at)
        SELECT s.source->'session' AS session, m.provider_expires_at
        FROM stopped s JOIN moved m USING (source_id) WHERE s.foreign`,
        [adoption, this.authority, this.proxy],
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

  /** Reads existing material for the worker's selected revision, never a workload request.
   * This neither prepares material nor grants permission to send. Each later request must
   * still authorize the exact installed attempt/version against current session authority. */
  async readOpenShellMaterial(
    revisionId: string,
    signal: AbortSignal,
    install?: GitInstallationFence,
  ): Promise<OpenShellRepositoryMaterial | OpenShellMaterialAbsence | undefined> {
    let bytes: Buffer | undefined;
    const withdrawn: OpenShellMaterialAbsence = Object.freeze({ absent: "withdrawn" });
    const unprepared: OpenShellMaterialAbsence = Object.freeze({ absent: "unprepared" });
    try {
      signal.throwIfAborted();
      const result = await this.transaction(async (c) => {
        const current = await lockLiveSession(c, "live_revision_id", revisionId, this.proxy);
        if (!current) {
          return current === null ? withdrawn : undefined;
        }
        if (this.proxy) {
          // The session transaction holds the current route, approval and Agent. Only the
          // conditional installer may receive a token; a changed fence or observation gets none.
          if (
            !install ||
            install.revisionId !== revisionId ||
            !(
              await c.query(
                `SELECT FROM occ.openshell_git_routes WHERE revision_id=$1 AND fence=$2
               AND observed=$3::jsonb AND blocked IS NULL AND detach_request_id IS NULL`,
                [revisionId, install.fence, JSON.stringify(install.observed)],
              )
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
          ...current.session.binding.grant,
          repository: source.grant.repository,
          pushRef: source.grant.pushRef,
          ...(source.grant.pullRequestBase
            ? { pullRequestBase: source.grant.pullRequestBase }
            : {}),
          apiOrigin: this.authority.split("#")[0]!,
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

  /** Authorizes a validated request from an authenticated OpenShell session mapping.
   * The sender already holds this exact material. No secret is read or released here.
   * The durable receipt records possible use, never delivery or a provider outcome. */
  async authorizeOpenShellRequest(
    q: PreparedGitHubUseRequest,
    installed: InstalledGitMaterial,
    signal: AbortSignal,
  ): Promise<boolean | "draft_already_opened" | "access_withdrawn"> {
    if (!installed?.preparationAttemptId || !installed.materialVersion) {
      return false;
    }
    // transaction() replaces every error with a redacted one, so the refusal class is noted here.
    let refused: "draft_already_opened" | "access_withdrawn" | false = false;
    try {
      const result = await this.transaction(async (c) => {
        try {
          return await this.recordUse(c, q, signal, installed);
        } catch (error) {
          refused =
            error instanceof DraftAlreadyOpened
              ? "draft_already_opened"
              : error instanceof SessionClosed
                ? "access_withdrawn"
                : false;
          throw error;
        }
      });
      return !("kind" in result) && !signal.aborted && Date.now() < Date.parse(result.sendStartBy);
    } catch {
      // A lost commit acknowledgment may leave a receipt. Never retry or turn it into an allow.
      return refused;
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
        const { open, ...receipt } = decision;
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
    q: PreparedGitHubUseRequest,
    signal: AbortSignal,
    installed?: InstalledGitMaterial,
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
    if (installed && (!current || !source)) {
      // OpenShell route only: the session ended or the registry no longer admits it.
      throw new SessionClosed();
    }
    if (
      !source ||
      !current ||
      source.grant.pushRef !== q.pushRef ||
      !isDeepStrictEqual(current.session.binding.grant, {
        providerInstanceId: q.providerInstanceId,
        repositoryId: q.repositoryId,
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
          await c.query(
            `SELECT FROM occ.openshell_git_routes WHERE revision_id=$1 AND fence=$2
           AND observed=$3::jsonb AND observed->>'credentialState'='active'
           AND preparation_attempt_id=$4 AND material_version=$5
           AND blocked IS NULL AND write_pending IS NULL AND detach_request_id IS NULL`,
            [
              revisionId,
              fence,
              JSON.stringify(observed),
              installed!.preparationAttemptId,
              installed!.materialVersion,
            ],
          )
        ).rowCount
      ) {
        return fail();
      }
    }
    // Authority and live-session locks above apply equally to reads of an existing receipt.
    const grant = source.grant;
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
    } else if (q.pull) {
      return fail();
    }
    // The same transaction keeps both live authority and the selected version locked until the
    // use (and, when applicable, the grant's draft allowance) commits. OpenShell already has the
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
    const sendStartBy = new Date(until).toISOString();
    if (scope && !unlimited) {
      // A possibly spent allowance outlives this session, including an unknown commit or send.
      const claim = await c.query(
        `INSERT INTO ${pulls}
         (grant_id,operation_id,receipt_id,admission_id,attempt_id,material_version,request_digest_sha256,scope,send_start_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (grant_id) DO NOTHING RETURNING receipt_id`,
        [
          q.grantId,
          scope.operationId,
          q.exchangeId,
          current.session.admissionId,
          preparationAttemptId,
          materialVersion,
          q.requestDigestSha256,
          scope,
          sendStartBy,
        ],
      );
      if (!claim.rowCount) {
        return fail();
      }
    }
    await c.query(
      `INSERT INTO occ.prepared_repository_git_uses
    (exchange_id,admission_id,attempt_id,material_version,operation,request_digest_sha256,send_start_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        q.exchangeId,
        current.session.admissionId,
        preparationAttemptId,
        materialVersion,
        q.operation,
        q.requestDigestSha256,
        sendStartBy,
      ],
    );
    if (!valid(until)) {
      return fail();
    }
    return {
      sendStartBy,
      exchangeId: q.exchangeId,
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
