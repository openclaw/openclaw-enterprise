import { githubProviderOrigin } from "./factory.ts";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  githubMetadataGrant,
  type PreparedGitHubEgressLifecycle,
  type PreparedGitHubCurrentProof,
  type CredentialReadLifetime,
  type PreparedGitHubEgressSource as Source,
  type PreparedGitHubMaterialEvidence as Evidence,
  type PreparedGitHubSelection,
  type Secret,
  type SecretDriver,
} from "@openclaw-enterprise/contracts";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import type { AttemptContext } from "../../credentials/backend-contracts.ts";
import { createSystemClock } from "../../credentials/clock.ts";
import { createGitHubKeyOwner } from "./material.ts";
import { preparationIssuerAuthority } from "./grants.ts";
import { PreparedGitHubPostgres } from "./prepared-postgres.ts";
import { createGitHubPreparationOwner } from "./prepared-owner.ts";
import { createGitHubWarmReader } from "./prepared-reader.ts";
import { createProviderTransport } from "./provider-transport.ts";

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

function evidence(m: Metadata): Omit<PreparedGitHubSelection, "value"> {
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
export class PostgresPreparedGitHubLifecycle implements PreparedGitHubEgressLifecycle {
  private repository: PreparedGitHubPostgres | undefined;
  private custodyKey?: Buffer;
  private readonly clock = createSystemClock();
  private stopWorker?: AbortController;
  private running?: Promise<void>;
  private cancelNext?: () => void;
  private readonly custodyKeyPath: string;
  private readonly secretDriver: SecretDriver;
  readonly apiOrigin: string;
  private readonly issuerAuthority: string;
  private readonly ca: Uint8Array | undefined;
  constructor(
    custodyKeyPath: string,
    secretDriver: SecretDriver,
    apiOrigin = "https://api.github.com",
    ca?: Uint8Array,
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
    while ((await this.retire(source.key.source.id, signal)) === "retired") {
      signal.throwIfAborted();
    }
    if (!(await db.withdrawalSettled(source))) {
      throw new Error(
        "Prepared GitHub use withdrawn; unsettled provider attempt requires recovery.",
      );
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
  ): Promise<PreparedGitHubSelection | undefined> {
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

  async current(
    source: Source,
    ev: Evidence,
    lifetime: CredentialReadLifetime,
    proof: PreparedGitHubCurrentProof,
  ) {
    const { signal } = lifetime;
    const until = Date.parse(ev.usableUntil);
    if (
      signal.aborted ||
      !(until > Date.now()) ||
      ev.kind !== "prepared_github" ||
      !isDeepStrictEqual(ev.source, source.key) ||
      ev.grantHash !== grantId(source) ||
      ev.isolationId !== source.grant.isolationId
    ) {
      return false;
    }
    return proof.current(source, ev, this.issuerAuthority, lifetime);
  }

  private async retire(familyId: string | null, outer: AbortSignal) {
    outer.throwIfAborted();
    return retirePreparedGitHubToken(this.db, familyId, outer, this.apiOrigin, this.ca, this.clock);
  }

  startWorker(
    report: (
      code: "PREPARED_GITHUB_RECOVERY_REQUIRED" | "PREPARED_GITHUB_MAINTENANCE_FAILED",
    ) => void,
  ) {
    const stop = new AbortController();
    this.stopWorker = stop;
    const tick = () => {
      let delay = 5_000;
      this.running = this.maintain(stop.signal)
        .then((outcome) => {
          // Drain due families promptly; each claim independently moves the family scan forward.
          if (outcome !== "idle" && outcome !== "issuer-mismatch") {
            delay = 100;
          }
          if (outcome === "quarantined" || outcome === "blocked" || outcome === "issuer-mismatch") {
            report("PREPARED_GITHUB_RECOVERY_REQUIRED");
          }
        })
        .catch(() => {
          if (!stop.signal.aborted) {
            report("PREPARED_GITHUB_MAINTENANCE_FAILED");
          }
        })
        .finally(() => {
          if (!stop.signal.aborted) {
            this.cancelNext = this.clock.schedule(delay, tick);
          }
        });
    };
    tick();
  }

  /** One proactive worker pass; duplicates share the durable claim/attempt fence. */
  async maintain(outer: AbortSignal) {
    const retirement = await this.retire(null, outer);
    const claim = randomUUID();
    const job = await this.db.claim(claim);
    if (!job) {
      return retirement;
    }
    const signal = AbortSignal.any([outer, AbortSignal.timeout(25_000)]);
    const { source, issuer } = job;
    if (source.origin !== this.apiOrigin) {
      throw new Error("Prepared GitHub origin changed.");
    }
    const id = grantId(source);
    const input = await this.readIssuer(issuer, signal);
    const admission = await this.db.observeInput(source, claim, input.version);
    if (!admission || admission.grant.id !== id) {
      return "fenced";
    }
    const clock = this.clock;
    const key = createGitHubKeyOwner({
      privateKey: createPrivateKey(input.value),
      appId: source.grant.appId,
      clock,
    });
    try {
      const owner = createGitHubPreparationOwner({
        admission,
        store: this.db.store(source, null),
        clock,
        getKey: async () => key,
        apiOrigin: this.apiOrigin,
        ...(this.ca ? { ca: this.ca } : {}),
        renewBeforeMs: 10 * 60_000,
        minimumValidityMs: 60_000,
      });
      return await owner.run(randomUUID(), {
        signal,
        deadlineMonoMs: clock.monotonicNow() + 25_000,
      });
    } finally {
      key.close();
    }
  }

  async close() {
    this.stopWorker?.abort();
    this.cancelNext?.();
    await this.running;
    this.custodyKey?.fill(0);
    this.repository = undefined;
  }
}

/** Retirement is shared by both background owners. An ambiguous attempt is never replayed. */
export async function retirePreparedGitHubToken(
  repository: PreparedGitHubPostgres,
  familyId: string | null,
  outer: AbortSignal,
  apiOrigin: string,
  ca: Uint8Array | undefined,
  clock: ReturnType<typeof createSystemClock>,
) {
  const candidate = await repository.takeRetirement(familyId);
  if (!candidate || candidate === "issuer-mismatch") {
    return candidate ?? "idle";
  }
  let revoked = false;
  const { bytes, admission: a, id } = candidate;
  try {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(25_000)]);
    const assertAdmitted = () => signal.throwIfAborted();
    const attempt: AttemptContext = {
      id,
      signal,
      action: "retire",
      deadlineMonoMs: clock.monotonicNow() + 25_000,
      assertAdmitted,
      observeDispatch: assertAdmitted,
      authority: {
        sessionId: a.familyId,
        providerInstanceId: a.grant.appId,
        repositoryId: a.grant.repositoryId,
        grantId: a.grant.id,
      },
    };
    const response = await createProviderTransport(apiOrigin, ca, clock, a.grant).revoke(
      bytes.toString(),
      attempt,
      () => {},
    );
    revoked = response.status === 204;
    response.body.fill(0);
  } finally {
    bytes.fill(0);
    await repository.finishRetirement(id, revoked);
  }
  if (!revoked) {
    throw new Error("Prepared GitHub token revocation is unconfirmed.");
  }
  return "retired" as const;
}
