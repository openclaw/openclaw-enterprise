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

const adoption = "prepared_repository_git";
const families = "occ.prepared_github_families";
const attempts = "occ.prepared_github_attempts";

export interface PreparedRepositorySession {
  readonly namespaceId: string;
  readonly revisionId: string;
  readonly admissionId: string;
  readonly sessionId: string;
  readonly driver: RepositoryRevisionState["driver"];
  readonly binding: RepositoryRevisionState["bindings"][number];
}

/** The session snapshot also binds Agent, installation and the broker's particular generation.
 * The deadline is checked live instead of extending or treating the snapshot as a lease. */
const sessions = `SELECT jsonb_build_object(
  'namespaceId',s.namespace_id, 'agentId',s.agent_id, 'revisionId',s.live_revision_id,
  'installationId',i.id, 'admissionId',s.admission_id, 'sessionId',b.session_id,
  'brokerGeneration',b.generation, 'driver',s.cleanup_context->'driver', 'binding',s.cleanup_context->'binding',
  'grant',s.cleanup_context #> '{binding,grant}') AS session,
  least(b.deadline_wall_ms, s.deadline_wall_ms) AS end_ms
  FROM occ.repository_session_attempts s
  JOIN occ.repository_broker_receipts b USING(admission_id)
  JOIN occ.agents g ON g.namespace_id=s.namespace_id AND g.id=s.agent_id AND g.active_revision_id=s.live_revision_id
  JOIN occ.agent_revisions rev ON rev.id=s.live_revision_id AND rev.namespace_id=s.namespace_id AND rev.agent_id=s.agent_id
  CROSS JOIN occ.installation i
  WHERE s.phase='open' AND s.broker_protocol=1 AND s.live_revision_id=s.revision_id
  AND b.state='active' AND b.generation IS NOT NULL AND b.session_id=s.session_id
  AND clock_timestamp() < to_timestamp(least(b.deadline_wall_ms, s.deadline_wall_ms) / 1000.0)
  AND g.status='active' AND g.desired_runtime_state='running' AND g.execution_mode='dedicated'
  AND s.cleanup_context #>> '{binding,profile}' = 'git-write'
  AND g.repository_bindings @> jsonb_build_array(jsonb_build_object('repositoryRef',s.repository_ref,'profile','git-write'))
  AND rev.admitted_spec #> '{repository_credentials,driver}'=s.cleanup_context->'driver'
  AND rev.admitted_spec #> '{repository_credentials,bindings}' @> jsonb_build_array(s.cleanup_context->'binding')`;
const live = `EXISTS (SELECT FROM (${sessions}) l WHERE l.session = f.source->'session')`;

export interface PreparedRepositoryGitSource {
  readonly adoption: typeof adoption;
  readonly key: { source: { id: string } };
  readonly session: PreparedRepositorySession;
  readonly grant: GitHubPreparationAdmission["grant"] & {
    profile: "git-ref-write" | "git-ref-draft-pr";
    pushRef: string;
  };
}
type Policy = (session: PreparedRepositorySession) => PreparedRepositoryGitSource | undefined;

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
  constructor(pool: PostgresPool, key: Buffer, authority: string, policy: Policy) {
    super(pool, key, authority, { active: live, adoption });
    this.authority = authority;
    this.policy = policy;
  }

  /** Background discovery only. Admission and key lookup are not reachable from use(). */
  async discover(): Promise<PreparedRepositoryGitSource[]> {
    return this.transaction(async (c) => {
      // Denial doesn't depend on this cleanup. Keep attempts, including unknown issuance, for recovery.
      await c.query(
        `WITH stopped AS (
        UPDATE ${families} f SET enabled=false
        WHERE enabled AND source->>'adoption'=$1 AND admission->>'issuerAuthority'=$2 AND NOT ${live}
        RETURNING source_id)
        UPDATE ${attempts} a SET custody='retire' FROM stopped s
        WHERE a.source_id=s.source_id AND custody='current'`,
        [adoption, this.authority],
      );
      const { rows } = await c.query(sessions);
      return (rows as { session: PreparedRepositorySession }[]).flatMap(
        ({ session }) => this.policy(session) ?? [],
      );
    });
  }

  async claimGit(
    source: PreparedRepositoryGitSource,
    version: string,
  ): Promise<GitHubPreparationAdmission | undefined> {
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
  ): Promise<OpenShellRepositoryMaterial | undefined> {
    let bytes: Buffer | undefined;
    try {
      signal.throwIfAborted();
      const result = await this.transaction(async (c) => {
        const { rows } = await c.query(
          `SELECT session,end_ms FROM
          (${sessions} AND s.live_revision_id=$1 FOR SHARE OF s,b,g) l`,
          [revisionId],
        );
        // A revision with multiple eligible repository sessions has no single installation
        // target. Do not select whichever row the database happens to return first.
        if (rows.length !== 1) {
          return undefined;
        }
        const current = rows[0] as { session: PreparedRepositorySession; end_ms: string };
        const source = this.policy(current.session);
        if (!source) {
          return undefined;
        }
        const { rows: found } = await c.query(
          `SELECT a.id,a.admission,a.material_version,a.usable_until,a.sealed
          FROM ${families} f JOIN ${attempts} a USING(source_id)
          WHERE f.source_id=$1 AND f.source=$2::jsonb AND f.enabled
          AND f.admission->>'issuerAuthority'=$3
          AND a.custody='current' AND a.state='committed' AND a.admission=f.admission
          AND a.usable_until BETWEEN clock_timestamp() AND clock_timestamp() + interval '61 minutes'
          AND a.provider_expires_at >= a.usable_until FOR SHARE OF f,a`,
          [source.key.source.id, source, this.authority],
        );
        if (found.length !== 1) {
          return undefined;
        }
        const material = found[0] as {
          id: string;
          admission: GitHubPreparationAdmission;
          material_version: string;
          usable_until: Date;
          sealed: Buffer;
        };
        const until = Math.min(Number(current.end_ms), material.usable_until.getTime());
        if (
          !isDeepStrictEqual(material.admission.grant, source.grant) ||
          !material.sealed ||
          !material.material_version ||
          signal.aborted ||
          !Number.isFinite(until) ||
          Date.now() >= until
        ) {
          return undefined;
        }
        bytes = this.open(material.sealed, material.admission, material.id);
        return {
          expiresAt: new Date(until).toISOString(),
          preparationAttemptId: material.id,
          materialVersion: material.material_version,
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
      if (!result || !bytes || Date.now() >= Date.parse(result.expiresAt)) {
        return undefined;
      }
      return Object.freeze({ ...result, value: bytes.toString("utf8") });
    } finally {
      bytes?.fill(0);
    }
  }

  /** Authorizes a validated request from an authenticated OpenShell session mapping.
   * The sender already holds this exact material. No secret is read or released here.
   * The durable receipt records possible use, never delivery or a provider outcome. */
  async authorizeOpenShellRequest(
    q: PreparedGitHubUseRequest,
    installed: { preparationAttemptId: string; materialVersion: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!installed?.preparationAttemptId || !installed.materialVersion) {
      return false;
    }
    try {
      const result = await this.transaction((c) => this.recordUse(c, q, signal, installed));
      return !("kind" in result) && !signal.aborted && Date.now() < Date.parse(result.sendStartBy);
    } catch {
      // A lost commit acknowledgment may leave a receipt. Never retry or turn it into an allow.
      return false;
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
        const { admission, sealed, ...receipt } = decision;
        if (!sealed || signal.aborted || Date.now() >= Date.parse(receipt.sendStartBy)) {
          throw new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
        }
        // Under the same material lock, with no await between this check and open.
        bytes = this.open(sealed, admission, decision.preparationAttemptId);
        return receipt;
      });
      if ("kind" in result) {
        return result;
      }
      if (!bytes || signal.aborted || Date.now() >= Date.parse(result.sendStartBy)) {
        throw new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
      }
      return { ...result, value: bytes.toString("utf8") };
    } finally {
      bytes?.fill(0);
    }
  }

  private async recordUse(
    c: PostgresClient,
    q: PreparedGitHubUseRequest,
    signal: AbortSignal,
    installed?: { preparationAttemptId: string; materialVersion: string },
  ) {
    const deadline = Date.parse(q.deadlineAt);
    const valid = (until: number) => !signal.aborted && Date.now() < until;
    const fail = (): never => {
      throw new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
    };
    if (!valid(deadline) || deadline > Date.now() + 30_000) {
      return fail();
    }
    // Locks on the mutable session, receipt and Agent serialize withdrawal with this decision.
    // The admitted revision is immutable; the Agent row owns its current selection. The caller can never substitute its own Agent or repository policy.
    const { rows } = await c.query(
      `SELECT session,end_ms FROM
      (${sessions} AND b.session_id=$1 FOR SHARE OF s,b,g) l`,
      [q.sessionId],
    );
    const current = rows[0] as { session: PreparedRepositorySession; end_ms: string } | undefined;
    const source = current && this.policy(current.session);
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
    // Authority and live-session locks above apply equally to reads of an existing receipt.
    const grant = source.grant;
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
      } = await c.query(`SELECT * FROM ${pulls} WHERE grant_id=$1`, [q.grantId]);
      if (prior) {
        if (installed) {
          return fail();
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
    const { rows: found } = await c.query(
      `SELECT a.id,a.admission,a.material_version, a.usable_until${installed ? "" : ", a.sealed"}
      FROM ${families} f JOIN ${attempts} a USING(source_id)
      WHERE f.source_id=$1 AND f.source=$2::jsonb AND f.enabled AND f.admission->>'issuerAuthority'=$3
      AND a.custody='current' AND a.state='committed' AND a.admission=f.admission
      AND a.usable_until BETWEEN clock_timestamp() AND clock_timestamp() + interval '61 minutes'
      AND a.provider_expires_at >= a.usable_until FOR SHARE OF f,a`,
      [source.key.source.id, source, this.authority],
    );
    const m = found[0] as
      | {
          id: string;
          admission: GitHubPreparationAdmission;
          material_version: string;
          usable_until: Date;
          sealed?: Buffer;
        }
      | undefined;
    if (
      !m ||
      !isDeepStrictEqual(m.admission.grant, source.grant) ||
      (installed &&
        (m.id !== installed.preparationAttemptId ||
          m.material_version !== installed.materialVersion))
    ) {
      return fail();
    }
    const until = Math.min(
      Date.now() + 5000,
      deadline,
      Number(current.end_ms),
      m.usable_until.getTime(),
    );
    if (!valid(until)) {
      return fail();
    }
    const sendStartBy = new Date(until).toISOString();
    if (scope) {
      // The primary key admits only ONE create for this repository/ref/base grant,
      // across process or session replacement. Unknown/expired permits are never reissued.
      const claim = await c.query(
        `INSERT INTO ${pulls}
         (grant_id,operation_id,receipt_id,admission_id,attempt_id,material_version,request_digest_sha256,scope,send_start_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (grant_id) DO NOTHING RETURNING receipt_id`,
        [
          q.grantId,
          scope.operationId,
          q.exchangeId,
          current.session.admissionId,
          m.id,
          m.material_version,
          q.requestDigestSha256,
          scope,
          sendStartBy,
        ],
      );
      if (!claim.rowCount) {
        return fail();
      }
    } else {
      await c.query(
        `INSERT INTO occ.prepared_repository_git_uses
      (exchange_id,admission_id,attempt_id,material_version,operation,request_digest_sha256,send_start_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          q.exchangeId,
          current.session.admissionId,
          m.id,
          m.material_version,
          q.operation,
          q.requestDigestSha256,
          sendStartBy,
        ],
      );
    }
    if (!valid(until)) {
      return fail();
    }
    return {
      sendStartBy,
      exchangeId: q.exchangeId,
      preparationAttemptId: m.id,
      materialVersion: m.material_version,
      admission: m.admission,
      sealed: m.sealed,
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
