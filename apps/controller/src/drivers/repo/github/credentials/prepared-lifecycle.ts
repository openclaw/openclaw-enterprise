import { runPreparation, TokenService } from "../../../../backends/token-service/service.ts";
import { githubProviderOrigin, preparationIssuerAuthority } from "./origin.ts";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  githubMetadataGrant,
  preparedGitHubProviderRef,
  preparedGitHubSourceFromRoute,
  type PreparedTokenIssuer,
  type CredentialReadLifetime,
  type EgressSourceKey,
  type PreparedGitHubEgressSource as Source,
  type PreparedTokenSelection,
  type TokenResolveOptions,
  type Secret,
  type SecretDriver,
} from "@openclaw-enterprise/contracts";
import {
  CredentialTokenUnsettledError,
  postgresPreparedGitHubProof,
  type PostgresPool,
} from "@openclaw-enterprise/occ";
import { createSystemClock } from "../../credentials/clock.ts";
import { createGitHubKeyOwner } from "./material.ts";
import { tokenLifetimeMs } from "./driver/lifetime.ts";
import { PreparedGitHubPostgres, type GitHubPreparationRequest } from "./prepared-postgres.ts";
import { createGitHubPreparationOwner } from "./prepared-owner.ts";
import { createWarmTokenReader } from "../../../../backends/token-service/warm-reader.ts";
import { retirePreparedGitHubToken } from "./prepared-retirement.ts";

const renewBeforeMs = 600_000;
const issueMinimumValidityMs = 60_000;

function grantId({ grant: g }: Source) {
  // Normalize field order using the admission owner's function, including after a jsonb round trip.
  const grant = githubMetadataGrant({
    authority: "execution",
    app_id: g.appId,
    installation_id: g.installationId,
    repository_id: g.repositoryId,
    repository: g.repository,
    agent_id: g.isolationId,
  });
  if (!isDeepStrictEqual(g, grant)) {
    throw new Error("Invalid prepared GitHub grant.");
  }
  return createHash("sha256").update(JSON.stringify(grant)).digest("hex");
}
type Metadata = NonNullable<Awaited<ReturnType<PreparedGitHubPostgres["metadata"]>>>;

function evidence(m: Metadata): Omit<PreparedTokenSelection, "accessToken"> {
  const { admission: a } = m;
  return {
    family: { id: a.familyId, generation: a.generation },
    ownerEpoch: a.ownerEpoch,
    inputVersion: a.inputVersion,
    preparationAttemptId: m.id,
    materialId: a.familyId,
    materialVersion: m.material_version!,
    expiresAt: m.provider_expires_at.toISOString(),
    usableUntil: m.usable_until.toISOString(),
  };
}

/** The API and worker share the same database and a dedicated 32-byte custody key from a private
 * mount. Scheduled work and exact registered requests share the same durable issuance claim. */
export class PostgresPreparedGitHubLifecycle implements PreparedTokenIssuer {
  private repository: PreparedGitHubPostgres | undefined;
  private custodyKey?: Buffer;
  private readonly clock = createSystemClock();
  private readonly maintenance;
  private readonly closing = new AbortController();
  readonly shutdownSignal = this.closing.signal;
  private readonly requested = new Map<string, Promise<string | undefined>>();
  private report: (
    code:
      | "PREPARED_GITHUB_RECOVERY_REQUIRED"
      | "PREPARED_GITHUB_MAINTENANCE_FAILED"
      | "PREPARED_GITHUB_ISSUANCE_DIAGNOSTIC",
    context?: Readonly<Record<string, string | number | boolean | undefined>>,
    severity?: "info" | "error",
  ) => void = () => {};
  readonly tokenKind = "github_app_installation";
  readonly provider = preparedGitHubProviderRef;
  readonly sourceFromRoute = preparedGitHubSourceFromRoute;
  readonly issuerInput = "private_key";

  admission(config: Readonly<Record<string, string>>) {
    return {
      origin: this.apiOrigin,
      grant: githubMetadataGrant(config),
      schemaVersion: 2 as const,
    };
  }

  private readonly custodyKeyPath: string;
  private readonly secretDriver: SecretDriver;
  readonly apiOrigin: string;
  readonly issuerAuthority: string;
  private readonly ca: Uint8Array | undefined;
  constructor(
    custodyKeyPath: string,
    secretDriver: SecretDriver,
    apiOrigin = "https://api.github.com",
    ca?: Uint8Array,
    tokenService = new TokenService(),
  ) {
    this.custodyKeyPath = custodyKeyPath;
    this.secretDriver = secretDriver;
    this.apiOrigin = githubProviderOrigin(apiOrigin);
    this.ca = ca && Buffer.from(ca);
    this.issuerAuthority = preparationIssuerAuthority(this.apiOrigin, this.ca);
    if (!isAbsolute(custodyKeyPath) || !secretDriver.readCredentialInput) {
      throw new Error(
        "Prepared GitHub requires a custody key mount and authoritative issuer Secret Driver.",
      );
    }
    tokenService.registerIssuer(this, postgresPreparedGitHubProof);
    this.maintenance = tokenService.ownFamilies({
      discover: async (signal) => {
        signal.throwIfAborted();
        await this.db.withdrawEndedAgents();
      },
      retire: async (signal) => {
        const result = await this.retire(null, signal);
        if (result === "issuer-mismatch") {
          this.report("PREPARED_GITHUB_RECOVERY_REQUIRED", { reason: result });
        }
        return result;
      },
      prepare: (signal) => this.prepare(signal, issueMinimumValidityMs),
      failed: () => this.report("PREPARED_GITHUB_MAINTENANCE_FAILED"),
    });
  }

  private async prepare(
    signal: AbortSignal,
    minimumValidityMs: number,
    request?: GitHubPreparationRequest,
  ) {
    const claim = randomUUID();
    const job = await this.db.claim(claim, request);
    if (!job) {
      return request ? "unclaimed" : undefined;
    }
    const { source, issuer } = job;
    try {
      if (source.origin !== this.apiOrigin) {
        throw new Error("Prepared GitHub origin changed.");
      }
      const input = await this.readIssuer(
        issuer,
        AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      );
      const admission = await this.db.observeInput(source, claim, input.version);
      if (!admission || admission.grant.id !== grantId(source)) {
        return "fenced";
      }
      if (request?.urgency === "required") {
        // A different replica may have published after this caller observed a cold token
        // and before it took the claim. Reuse even a short-lived replacement if it suffices.
        const current = await this.db.metadata(source);
        if (
          current?.material_version &&
          current.usable_until.getTime() > Date.now() + minimumValidityMs
        ) {
          return "ready";
        }
      }
      const clock = this.clock;
      const key = createGitHubKeyOwner({
        privateKey: createPrivateKey(input.value),
        appId: source.grant.appId,
        clock,
      });
      try {
        const outcome = await runPreparation(
          createGitHubPreparationOwner({
            admission,
            store: this.db.store(source, null),
            clock,
            getKey: async () => key,
            apiOrigin: this.apiOrigin,
            ...(this.ca ? { ca: this.ca } : {}),
            renewBeforeMs: Math.max(renewBeforeMs, minimumValidityMs),
            minimumValidityMs: issueMinimumValidityMs,
            observe: ({ error, ...diagnostic }) =>
              this.report(
                "PREPARED_GITHUB_ISSUANCE_DIAGNOSTIC",
                {
                  ...diagnostic,
                  ...(error ? { errorClass: error } : {}),
                },
                "info",
              ),
          }),
          signal,
        );
        if (outcome === "quarantined" || outcome === "blocked") {
          this.report("PREPARED_GITHUB_RECOVERY_REQUIRED", { reason: outcome });
        }
        return outcome;
      } finally {
        key.close();
      }
    } finally {
      await this.db.releaseClaim(source, claim);
    }
  }

  async connect(pool: PostgresPool) {
    const key = await readFile(this.custodyKeyPath);
    if (key.length !== 32) {
      key.fill(0);
      throw new Error("Prepared GitHub custody key must contain 32 bytes.");
    }
    this.custodyKey = key;
    this.repository = new PreparedGitHubPostgres(pool, key, this.issuerAuthority);
  }

  private get db() {
    if (!this.repository) {
      throw new Error("Prepared GitHub custody not connected.");
    }
    return this.repository;
  }

  private async readIssuer(secret: Readonly<Secret>, signal: AbortSignal) {
    if (secret.driverId !== this.secretDriver.id) {
      throw new Error("Prepared issuer Secret Driver changed.");
    }
    const start = Date.now();
    const deadlineAt = new Date(start + 20_000).toISOString();
    const input = await this.secretDriver.readCredentialInput!({
      secret,
      lifetime: { signal, deadlineAt },
      retention: "none",
    });
    const observed = Date.parse(input.authoritativeObservedAt);
    signal.throwIfAborted();
    if (
      !input.version ||
      !(
        observed >= start - 1000 &&
        observed <= Date.now() + 1000 &&
        Date.now() < Date.parse(deadlineAt)
      )
    ) {
      throw new Error("Prepared issuer input is not an authoritative current version.");
    }
    return input;
  }

  async configure(source: Source, issuer: Readonly<Secret>, signal: AbortSignal) {
    const { key, grant } = source;
    const id = grantId(source);
    if (source.origin !== this.apiOrigin || key.namespaceId !== issuer.namespaceId) {
      throw new Error("Prepared GitHub issuer or origin mismatch.");
    }
    const { version } = await this.readIssuer(issuer, signal);
    await this.db.enroll(source, issuer, {
      familyId: key.source.id,
      issuerAuthority: this.issuerAuthority,
      generation: key.source.generation,
      inputVersion: version,
      ownerEpoch: 1,
      grant: { ...grant, id },
    });
  }

  async withdraw(source: Source, signal: AbortSignal) {
    signal.throwIfAborted();
    const db = this.db;
    await db.withdraw(source);
    // Denial commits first; background cleanup still works if the API stops or loses the response.
    try {
      while ((await this.retire(source.key.source.id, signal)) === "retired") {
        signal.throwIfAborted();
      }
    } catch (error) {
      // A lost or refused revocation is recorded as 'unknown' and never replayed. Report it
      // as unsettled custody below, not as a failure of this request.
      signal.throwIfAborted();
      if (!(error instanceof Error) || !unsettledRetirement.has(error.message)) {
        throw error;
      }
    }
    let settlement = await db.withdrawalSettlement(source);
    // The worker may be revoking a token right now (for example after the Agent was deleted).
    // Its answer arrives within the revocation budget: wait for it, never take it over.
    const until = Date.now() + 25_000;
    while (!settlement.settled && settlement.revoking && Date.now() < until && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (signal.aborted) {
        break;
      }
      settlement = await db.withdrawalSettlement(source);
    }
    if (!settlement.settled) {
      throw new CredentialTokenUnsettledError(settlement.settlesAt);
    }
  }

  async ready(source: Source, signal: AbortSignal) {
    if (signal.aborted) {
      return false;
    }
    const m = await this.db.metadata(source);
    return !!m && m.usable_until.getTime() > Date.now() && !signal.aborted;
  }

  private async readWarm(
    source: Source,
    lifetime: CredentialReadLifetime,
    minimumValidityMs = 0,
  ): Promise<PreparedTokenSelection | undefined> {
    const { signal, deadlineAt } = lifetime;
    const deadline = Date.parse(deadlineAt);
    const active = (until = deadline) => !signal.aborted && Date.now() < until;
    if (!active()) {
      return;
    }
    const m = await this.db.metadata(source);
    if (!m?.material_version || m.usable_until.getTime() <= Date.now() + minimumValidityMs) {
      return;
    }
    const effectiveUntil = Math.min(deadline, m.usable_until.getTime());
    if (!active(effectiveUntil)) {
      return;
    }
    const reader = createWarmTokenReader(
      this.db.store(source, {
        deadlineAt: new Date(effectiveUntil).toISOString(),
        attemptId: m.id,
        materialVersion: m.material_version,
        active: () => active(effectiveUntil),
      }),
      Date.now,
    );
    const warm = await reader.readWarm(m.admission);
    if (warm.kind !== "warm") {
      return;
    }
    const { bytes, attemptId, materialVersion, usableUntil } = warm.material;
    try {
      // A renewal between the two reads is cold for this operation, never mixed evidence.
      if (
        attemptId === m.id &&
        materialVersion === m.material_version &&
        usableUntil > Date.now() + minimumValidityMs &&
        active(effectiveUntil)
      ) {
        return {
          ...evidence(m),
          accessToken: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(),
        };
      }
    } finally {
      bytes.fill(0);
    }
  }

  private requestPreparation(
    source: Source,
    minimumValidityMs: number,
    urgency: GitHubPreparationRequest["urgency"],
  ) {
    const id = source.key.source.id;
    const current = this.requested.get(id);
    if (current) {
      return current;
    }
    // A use may be cancelled after GitHub accepts the issue. Its owner must still
    // settle the attempt and make the result available to any other waiter.
    const work = this.prepare(this.closing.signal, minimumValidityMs, { source, urgency })
      .catch(() => {
        this.report("PREPARED_GITHUB_MAINTENANCE_FAILED");
        return "blocked";
      })
      .finally(() => this.requested.delete(id));
    this.requested.set(id, work);
    return work;
  }

  async resolve(
    reference: EgressSourceKey,
    options: TokenResolveOptions,
  ): Promise<PreparedTokenSelection | undefined> {
    const { minimumValidityMs } = options;
    if (minimumValidityMs >= tokenLifetimeMs) {
      return undefined;
    }
    const lifetime = options;
    const deadline = Date.parse(lifetime.deadlineAt);
    const active = () => !lifetime.signal.aborted && Date.now() < deadline;
    const source = await this.db.registeredSource(reference);
    if (!source || source.origin !== this.apiOrigin || !active()) {
      return;
    }
    let waitingForPeer = false;
    while (active()) {
      const current = await this.readWarm(source, lifetime, minimumValidityMs);
      if (!active()) {
        return;
      }
      if (current) {
        if (!waitingForPeer && Date.parse(current.usableUntil) <= Date.now() + renewBeforeMs) {
          void this.requestPreparation(source, minimumValidityMs, "proactive");
        }
        return current;
      }
      const result = await this.requestPreparation(source, minimumValidityMs, "required");
      if (result === "ready" || result === "committed") {
        return this.readWarm(source, lifetime, minimumValidityMs);
      }
      if (result !== "unclaimed") {
        return;
      }
      // Another replica may own the exact family's claim. Its publication will satisfy
      // the next read; a lost claim becomes eligible for takeover when its lease expires.
      if (!active() || !(await this.db.registeredSource(reference))) {
        return;
      }
      waitingForPeer = true;
      await delay(100, undefined, { signal: lifetime.signal });
    }
  }

  private async retire(familyId: string | null, outer: AbortSignal) {
    outer.throwIfAborted();
    return retirePreparedGitHubToken(this.db, familyId, outer, this.apiOrigin, this.ca, this.clock);
  }

  startWorker(report: typeof this.report) {
    this.report = report;
    this.maintenance.start();
  }

  maintain(signal: AbortSignal) {
    return this.maintenance.maintain(signal);
  }

  async close() {
    this.closing.abort();
    await this.maintenance.close();
    await Promise.all(this.requested.values());
    this.custodyKey?.fill(0);
    this.repository = undefined;
  }
}

const unsettledRetirement = new Set([
  "Prepared GitHub token revocation is unconfirmed.",
  "provider-unavailable",
]);
