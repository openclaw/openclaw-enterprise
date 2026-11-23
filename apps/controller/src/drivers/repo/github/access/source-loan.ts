import { createHash } from "node:crypto";
import { readSourceRepositoryCeiling } from "@openclaw-enterprise/contracts";
import { classifyGitHubToken } from "./static-token.ts";
import type { GitHubTokenClass } from "./types.ts";
import type { GitHubRepositorySourceGrant } from "./repository-grant.ts";
import type {
  CurrentTokenVersion,
  InstalledTokenVersion,
  TokenMaterialReader,
} from "../../../../backends/token-service/material.ts";
import { withWriteHold, type MaterialWriteHold } from "../../access/material-hold.ts";

/** The longest one loan of a Source's value lasts: the provisional revocation bound. */
export const repositorySourceLoanMaximumMs = 900_000;
/** A loan made in window k ends with window k+1, so it is renewed 7.5 to 15 minutes ahead. */
const loanWindowMs = repositorySourceLoanMaximumMs / 2;

export type RepositorySourceRef = Readonly<{ namespaceId: string; sourceId: string }>;

/** The Source's catalog row as the lock read it. Metadata only, never the value. */
export interface LockedRepositorySource {
  readonly state: string;
  /** A TokenService Source of this Installation's selected TokenService instance. */
  readonly owned: boolean;
  readonly preset: string | undefined;
  /** The encoded Source ceiling, as stored in the Source config. */
  readonly repositories: string | undefined;
  /** The owning TokenService instance and its Installation, for the custody read. */
  readonly custody?: Readonly<{ installationId: string; tokenServiceInstanceId: string }>;
}

export interface RepositorySourceCustody {
  /**
   * Takes a shared lock on the Source's catalog row with a bounded wait and reads it. Replacement
   * and retirement take the row exclusively, so they wait until the hold is released.
   * Undefined when the lock could not be taken in time.
   */
  lock(ref: RepositorySourceRef): Promise<{
    readonly source: LockedRepositorySource | undefined;
    readonly hold: MaterialWriteHold;
  }>;
  /** The value and its custody version, read from TokenService under the hold. */
  resolve(
    ref: RepositorySourceRef,
    source: LockedRepositorySource,
  ): Promise<{ readonly credential: string; readonly version: string }>;
  /** Whether the revision's Agent principal holds `credential_source:operate` on the Source. */
  operate(
    session: Readonly<{ namespaceId: string; agentId: string }>,
    ref: RepositorySourceRef,
  ): Promise<boolean>;
}

const reasons = {
  source_locked: "could not be locked within the bounded wait",
  source_unavailable: "is missing or not ready",
  source_not_owned: "is not a Source of this Installation's TokenService",
  source_preset_refused: "is not a github Source",
  source_ceiling_exceeded: "no longer covers every repository of the revision",
  operate_denied: "is not operable by the Agent principal",
  token_class_refused: "holds a token other than a fine-grained token",
  source_unreadable: "could not be read",
} as const;
export type RepositorySourceRefusalReason = keyof typeof reasons;

/** A refused loan. Names the Source, its version and a fixed reason; never the value or a digest. */
export class RepositorySourceLoanRefusal extends Error {
  override readonly name = "RepositorySourceLoanRefusal";
  readonly code = "REPOSITORY_SOURCE_LOAN_REFUSED";
  readonly sourceId: string;
  readonly reason: RepositorySourceRefusalReason;
  /** The refused custody version, when the value was read; never derived from the value. */
  readonly sourceVersion: string | undefined;
  /** Only the class read from the documented prefix. */
  readonly tokenClass: GitHubTokenClass | undefined;
  constructor(
    sourceId: string,
    reason: RepositorySourceRefusalReason,
    sourceVersion?: string,
    tokenClass?: GitHubTokenClass,
  ) {
    super(`Repository token Source ${sourceId} ${reasons[reason]}.`);
    this.sourceId = sourceId;
    this.reason = reason;
    this.sourceVersion = sourceVersion;
    this.tokenClass = tokenClass;
  }
}

/** A version-4-shaped UUID from loan metadata (source, window, custody version), never the value. */
function loanUuid(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type LentSource = {
  readonly key: { readonly source: { readonly id: string } };
  readonly session: Readonly<{ namespaceId: string; agentId: string }>;
  readonly grant: Pick<GitHubRepositorySourceGrant, "credentialSource" | "repositories">;
};

/**
 * The native material reader for a TokenService Source, in place of App token rows: no copy of
 * the value is kept in the database and no migration is needed. At each loan it rechecks the
 * Source's state, owner, preset and ceiling, the Agent principal's `operate` and the token class,
 * then lends the value for at most 15 minutes. Ids derive from the source key, the loan window
 * and the custody version, so a replaced value is new material and the runtime rotates it in.
 * `readWarm` returns its material with the row hold, which the Provider write releases.
 */
export function createRepositorySourceMaterialReader<Transaction, Source extends LentSource>(
  custody: RepositorySourceCustody,
  options: {
    readonly clock?: { now(): number };
    /** Told once per Source, version and reason; a waiting route reads at every pass. */
    readonly refused?: (refusal: RepositorySourceLoanRefusal) => void;
  } = {},
): TokenMaterialReader<Transaction, Source> {
  const clock = options.clock ?? Date;
  const reported = new Map<string, string>();
  const identity = (source: Source, window: number, version: string) => ({
    preparationAttemptId: loanUuid("repository-source-loan", source.key.source.id, String(window)),
    materialVersion: loanUuid(
      "repository-source-material",
      source.key.source.id,
      String(window),
      version,
    ),
    usableUntil: (window + 2) * loanWindowMs,
  });
  const refuse = (error: unknown, source: Source) => {
    const refusal =
      error instanceof RepositorySourceLoanRefusal
        ? error
        : new RepositorySourceLoanRefusal(
            source.grant.credentialSource.sourceId,
            "source_unreadable",
          );
    const key = `${refusal.sourceVersion ?? "-"} ${refusal.reason}`;
    if (reported.get(refusal.sourceId) !== key) {
      reported.set(refusal.sourceId, key);
      options.refused?.(refusal);
    }
  };
  /** Every loan-time check; holds the row until the caller releases the returned hold. */
  async function check(source: Source) {
    const ref = source.grant.credentialSource;
    const { sourceId } = ref;
    let locked: Awaited<ReturnType<RepositorySourceCustody["lock"]>>;
    try {
      locked = await custody.lock(ref);
    } catch {
      throw new RepositorySourceLoanRefusal(sourceId, "source_locked");
    }
    try {
      const row = locked.source;
      if (row?.state !== "ready") {
        throw new RepositorySourceLoanRefusal(sourceId, "source_unavailable");
      }
      if (!row.owned) {
        throw new RepositorySourceLoanRefusal(sourceId, "source_not_owned");
      }
      if (row.preset !== "github") {
        throw new RepositorySourceLoanRefusal(sourceId, "source_preset_refused");
      }
      let ceiling: ReadonlySet<string>;
      try {
        ceiling = new Set(
          readSourceRepositoryCeiling(row.repositories ?? "").map(({ repository }) => repository),
        );
      } catch {
        throw new RepositorySourceLoanRefusal(sourceId, "source_ceiling_exceeded");
      }
      if (source.grant.repositories.some(({ repository }) => !ceiling.has(repository))) {
        throw new RepositorySourceLoanRefusal(sourceId, "source_ceiling_exceeded");
      }
      if (!(await custody.operate(source.session, ref))) {
        throw new RepositorySourceLoanRefusal(sourceId, "operate_denied");
      }
      let resolved: Awaited<ReturnType<RepositorySourceCustody["resolve"]>>;
      try {
        resolved = await custody.resolve(ref, row);
      } catch {
        throw new RepositorySourceLoanRefusal(sourceId, "source_unreadable");
      }
      const bytes = Buffer.from(resolved.credential, "utf8");
      try {
        const tokenClass = classifyGitHubToken(bytes);
        if (tokenClass !== "fine-grained") {
          throw new RepositorySourceLoanRefusal(
            sourceId,
            "token_class_refused",
            resolved.version,
            tokenClass,
          );
        }
      } finally {
        bytes.fill(0);
      }
      reported.delete(sourceId);
      return { resolved, hold: locked.hold };
    } catch (error) {
      await locked.hold.release();
      throw error;
    }
  }
  return Object.freeze({
    async readWarm(_tx: Transaction, source: Source) {
      let checked: Awaited<ReturnType<typeof check>>;
      try {
        checked = await check(source);
      } catch (error) {
        refuse(error, source);
        return undefined;
      }
      const window = Math.floor(clock.now() / loanWindowMs);
      const current = identity(source, window, checked.resolved.version);
      let value: string | undefined = checked.resolved.credential;
      return withWriteHold(
        {
          ...current,
          sourceVersion: checked.resolved.version,
          open() {
            if (value === undefined) {
              throw new Error("Source loan material was already opened.");
            }
            const bytes = Buffer.from(value, "utf8");
            value = undefined;
            return bytes;
          },
        },
        checked.hold,
      );
    },
    async current(
      _tx: Transaction,
      source: Source,
      installed: InstalledTokenVersion,
    ): Promise<(CurrentTokenVersion & { readonly open?: never }) | undefined> {
      if (!installed?.preparationAttemptId || !installed.materialVersion) {
        return undefined;
      }
      let checked: Awaited<ReturnType<typeof check>>;
      try {
        checked = await check(source);
      } catch (error) {
        refuse(error, source);
        return undefined;
      }
      await checked.hold.release();
      const now = clock.now();
      const window = Math.floor(now / loanWindowMs);
      // The installed loan stays current until it ends, unless the Source was replaced.
      for (const candidate of [window, window - 1]) {
        const version = identity(source, candidate, checked.resolved.version);
        if (
          version.preparationAttemptId === installed.preparationAttemptId &&
          version.materialVersion === installed.materialVersion &&
          version.usableUntil > now
        ) {
          return Object.freeze(version);
        }
      }
      return undefined;
    },
  });
}
