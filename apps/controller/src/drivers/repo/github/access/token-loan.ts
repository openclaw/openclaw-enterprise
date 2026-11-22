import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { classifyGitHubToken } from "./static-token.ts";
import type { GitHubTokenClass } from "./types.ts";
import type {
  CurrentTokenVersion,
  InstalledTokenVersion,
  TokenMaterialReader,
} from "../../../../backends/token-service/material.ts";

/** The endpointless Provider refuses credential material lent for longer (its existing check). */
export const githubTokenLoanMaximumMs = 3_600_000;

const refusals = {
  token_unreadable:
    "must name a readable regular file of 1 to 16384 bytes with no group write or other access",
  token_malformed: "must hold one token of printable ASCII characters",
  token_class_refused: "must hold a fine-grained token; every other class is refused",
} as const;

/** The token Secret cannot be lent. Names the Secret and a fixed reason, never token bytes. */
export class GitHubTokenSourceError extends Error {
  override readonly name = "GitHubTokenSourceError";
  readonly code = "GITHUB_TOKEN_SOURCE_REFUSED";
  readonly reason: keyof typeof refusals;
  /** Only the class read from the documented prefix. */
  readonly tokenClass: GitHubTokenClass | undefined;
  constructor(secretName: string, reason: keyof typeof refusals, tokenClass?: GitHubTokenClass) {
    super(
      `repository token Secret ${secretName} ${refusals[reason]}` +
        (tokenClass && reason === "token_class_refused" ? ` (found ${tokenClass}).` : "."),
    );
    this.reason = reason;
    this.tokenClass = tokenClass;
  }
}

/** One loan of the Installation's token to the endpointless Provider. `usableUntil` is the end
 * of OCE's loan, never the token's validity at GitHub, which OCE cannot learn or shorten. */
export interface GitHubTokenLoan {
  readonly value: string;
  readonly tokenClass: "fine-grained";
  readonly usableUntil: string;
  /** Identifies the Secret file generation; derived from file metadata, never from the value. */
  readonly secretVersion: string;
}

/** Names and times only: never the value, a digest of it, or its length. */
export interface GitHubTokenLoanAudit {
  readonly event: "github-token-loan";
  readonly source: "github-token";
  readonly secretName: string;
  readonly secretVersion: string;
  readonly revisionId: string;
  readonly usableUntil: string;
  readonly at: string;
}

export interface GitHubTokenLoanSourceOptions {
  /** The Worker-only projection of the Installation-private Secret. */
  readonly path: string;
  readonly secretName: string;
  readonly clock?: { now(): number };
  readonly audit?: (event: GitHubTokenLoanAudit) => void;
}

/**
 * Reads the Secret's current file at every loan, as the App lifecycle re-reads its key, so a
 * replaced value reaches the next loan without a redeploy. Makes no network call. The caller
 * hands the loan to the Provider and drops it; nothing here is cached or persisted.
 */
export function createGitHubTokenLoanSource(options: GitHubTokenLoanSourceOptions) {
  const { path, secretName } = options;
  const clock = options.clock ?? Date;
  return Object.freeze({
    /** Reads only the Secret file's generation, never its bytes. */
    async version(): Promise<string> {
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat({ bigint: true });
          return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
        } finally {
          await file.close();
        }
      } catch {
        throw new GitHubTokenSourceError(secretName, "token_unreadable");
      }
    },
    async lend(input: {
      readonly revisionId: string;
      readonly loanMs?: number;
      /** An absolute loan end; still never more than one hour away. */
      readonly untilMs?: number;
    }): Promise<GitHubTokenLoan> {
      let bytes: Buffer;
      let secretVersion: string;
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat({ bigint: true });
          if (
            (Number(stat.mode) & constants.S_IFMT) !== constants.S_IFREG ||
            (Number(stat.mode) & 0o027) !== 0 ||
            stat.size < 1n ||
            stat.size > 16385n
          ) {
            throw new Error("unreadable");
          }
          // A projected Secret is replaced by a new file: device, inode and change time differ.
          secretVersion = `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
          bytes = await file.readFile();
        } finally {
          await file.close();
        }
      } catch {
        throw new GitHubTokenSourceError(secretName, "token_unreadable");
      }
      try {
        // One trailing newline from `kubectl create secret --from-file` is not part of the token.
        const end = bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length;
        const token = bytes.subarray(0, end);
        if (!token.length || token.length > 16384 || !token.every((b) => b >= 0x21 && b <= 0x7e)) {
          throw new GitHubTokenSourceError(secretName, "token_malformed");
        }
        const tokenClass = classifyGitHubToken(token);
        if (tokenClass !== "fine-grained") {
          throw new GitHubTokenSourceError(secretName, "token_class_refused", tokenClass);
        }
        const now = clock.now();
        const requested = Math.min(
          input.untilMs !== undefined ? input.untilMs - now : (input.loanMs ?? githubTokenLoanMaximumMs),
          githubTokenLoanMaximumMs,
        );
        if (!Number.isSafeInteger(requested) || requested < 1000) {
          throw new RangeError("A token loan lasts 1 s to 1 h.");
        }
        // Whole seconds: the Provider compares the ISO form without milliseconds.
        const usableUntil = new Date(Math.floor((now + requested) / 1000) * 1000).toISOString();
        options.audit?.(
          Object.freeze({
            event: "github-token-loan",
            source: "github-token",
            secretName,
            secretVersion,
            revisionId: input.revisionId,
            usableUntil,
            at: new Date(now).toISOString(),
          }),
        );
        return Object.freeze({
          value: token.toString("ascii"),
          tokenClass,
          usableUntil,
          secretVersion,
        });
      } finally {
        bytes.fill(0);
      }
    },
  });
}

/** Renewal cadence: a loan made in window k ends at the end of window k+1 (30 to 60 minutes). */
export const githubTokenLoanWindowMs = 1_800_000;

/** A version-4-shaped UUID from loan metadata (source, window, Secret file generation). */
function loanUuid(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type TokenLoanSource = ReturnType<typeof createGitHubTokenLoanSource>;

/**
 * The native material reader for a token source, in place of App token rows: it keeps no copy
 * of the value in the database and needs no migration. Attempt and material identifiers are
 * derived from the source, the loan window and the Secret file generation, so the sender's
 * installed version stays current for its loan and turns stale when the Secret is replaced.
 * The caller's transaction still holds the live session lock; no material row is locked.
 */
export function createGitHubTokenMaterialReader<Transaction, Source extends { readonly key: { readonly source: { readonly id: string } } }>(
  loans: TokenLoanSource,
  clock: { now(): number } = Date,
): TokenMaterialReader<Transaction, Source> {
  const identity = (source: Source, window: number, secretVersion: string) => ({
    preparationAttemptId: loanUuid("github-token-loan", source.key.source.id, String(window)),
    materialVersion: loanUuid("github-token-material", source.key.source.id, String(window), secretVersion),
    usableUntil: (window + 2) * githubTokenLoanWindowMs,
  });
  return Object.freeze({
    async readWarm(_tx: Transaction, source: Source) {
      const window = Math.floor(clock.now() / githubTokenLoanWindowMs);
      let loan: GitHubTokenLoan;
      try {
        loan = await loans.lend({
          revisionId: source.key.source.id,
          untilMs: (window + 2) * githubTokenLoanWindowMs,
        });
      } catch {
        // The named diagnostic is the loan source's audit and report; the route waits for material.
        return undefined;
      }
      const current = identity(source, window, loan.secretVersion);
      let value: string | undefined = loan.value;
      return Object.freeze({
        ...current,
        usableUntil: Date.parse(loan.usableUntil),
        open() {
          if (value === undefined) {
            throw new Error("Token loan material was already opened.");
          }
          const bytes = Buffer.from(value, "ascii");
          value = undefined;
          return bytes;
        },
      });
    },
    async current(
      _tx: Transaction,
      source: Source,
      installed: InstalledTokenVersion,
    ): Promise<(CurrentTokenVersion & { readonly open?: never }) | undefined> {
      if (!installed?.preparationAttemptId || !installed.materialVersion) {
        return undefined;
      }
      let secretVersion: string;
      try {
        secretVersion = await loans.version();
      } catch {
        return undefined;
      }
      const now = clock.now();
      const window = Math.floor(now / githubTokenLoanWindowMs);
      // The installed loan stays current until it ends, unless the Secret was replaced.
      for (const candidate of [window, window - 1]) {
        const version = identity(source, candidate, secretVersion);
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
