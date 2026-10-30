import { TokenService } from "../../../../backends/token-service/service.ts";
import { githubProviderOrigin, preparationIssuerAuthority } from "./origin.ts";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  githubMetadataGrant,
  preparedGitHubProviderRef,
  preparedGitHubSourceFromRoute,
  type PreparedTokenIssuer,
  type CredentialReadLifetime,
  type PreparedGitHubEgressSource as Source,
  type PreparedTokenSelection,
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
import { PreparedGitHubPostgres } from "./prepared-postgres.ts";
import { createGitHubPreparationOwner } from "./prepared-owner.ts";
import { createGitHubWarmReader } from "./prepared-reader.ts";
import { retirePreparedGitHubToken } from "./prepared-retirement.ts";

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

function evidence(m: Metadata): Omit<PreparedTokenSelection, "value"> {
  const { admission: a } = m;
  return {
    family: { id: a.familyId, generation: a.generation },
    ownerEpoch: a.ownerEpoch,
    inputVersion: a.inputVersion,
    preparationAttemptId: m.id,
    materialId: a.familyId,
    materialVersion: m.material_version!,
    providerExpiresAt: m.provider_expires_at.toISOString(),
    usableUntil: m.usable_until.toISOString(),
  };
}

/** The API and worker share the same database and a dedicated 32-byte custody key from a private
 * mount. Only the worker starts the preparation loop; a request never invokes or wakes that loop. */
export class PostgresPreparedGitHubLifecycle implements PreparedTokenIssuer {
  private repository: PreparedGitHubPostgres | undefined;
  private custodyKey?: Buffer;
  private readonly clock = createSystemClock();
  private readonly maintenance;
  private report: (
    code: "PREPARED_GITHUB_RECOVERY_REQUIRED" | "PREPARED_GITHUB_MAINTENANCE_FAILED",
    context?: Readonly<Record<string, string>>,
  ) => void = () => {};
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
    tokenService.register(this, postgresPreparedGitHubProof);
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
      prepare: async (signal, run) => {
        const claim = randomUUID();
        const job = await this.db.claim(claim);
        if (!job) {
          return;
        }
        const { source, issuer } = job;
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
        const clock = this.clock;
        const key = createGitHubKeyOwner({
          privateKey: createPrivateKey(input.value),
          appId: source.grant.appId,
          clock,
        });
        try {
          const outcome = await run(
            createGitHubPreparationOwner({
              admission,
              store: this.db.store(source, null),
              clock,
              getKey: async () => key,
              apiOrigin: this.apiOrigin,
              ...(this.ca ? { ca: this.ca } : {}),
              renewBeforeMs: 600_000,
              minimumValidityMs: 60_000,
            }),
          );
          if (outcome === "quarantined" || outcome === "blocked") {
            this.report("PREPARED_GITHUB_RECOVERY_REQUIRED", { reason: outcome });
          }
          return outcome;
        } finally {
          key.close();
        }
      },
      failed: () => this.report("PREPARED_GITHUB_MAINTENANCE_FAILED"),
    });
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

  async readWarm(
    source: Source,
    lifetime: CredentialReadLifetime,
  ): Promise<PreparedTokenSelection | undefined> {
    const { signal, deadlineAt } = lifetime;
    const deadline = Date.parse(deadlineAt);
    const active = (until = deadline) => !signal.aborted && Date.now() < until;
    if (!active()) {
      return;
    }
    const m = await this.db.metadata(source);
    if (!m?.material_version) {
      return;
    }
    const effectiveUntil = Math.min(deadline, m.usable_until.getTime());
    if (!active(effectiveUntil)) {
      return;
    }
    const reader = createGitHubWarmReader(
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
        usableUntil > Date.now() &&
        active(effectiveUntil)
      ) {
        return {
          ...evidence(m),
          value: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(),
        };
      }
    } finally {
      bytes.fill(0);
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
    await this.maintenance.close();
    this.custodyKey?.fill(0);
    this.repository = undefined;
  }
}

const unsettledRetirement = new Set([
  "Prepared GitHub token revocation is unconfirmed.",
  "provider-unavailable",
]);
