import { createHash } from "node:crypto";

export const REPOSITORY_CLEANUP_KEY_PREFIX = "agent_revision:";
export const REPOSITORY_CLEANUP_KEY_SEPARATOR = ":repository_cleanup:";

// Agent deletion retains these keys after detaching their revision. Keep the cleanup key
// grammar the database recognizes, with separate digest domains for expiry and removal.
export const REPOSITORY_CLEANUP_FORMATS = {
  sessions: { suffix: "", hashPrefix: "" },
  expiry: { suffix: "", hashPrefix: "expiry:" },
  removal: { suffix: "", hashPrefix: "removal:" },
  "terminal-runtime": { suffix: "retire:", hashPrefix: "" },
} as const;

export function repositoryCleanupWorkKey(
  revisionId: string,
  purpose: keyof typeof REPOSITORY_CLEANUP_FORMATS,
): string {
  const format = REPOSITORY_CLEANUP_FORMATS[purpose];
  const hashInput = format.hashPrefix ? format.hashPrefix + revisionId : revisionId;
  const digest = createHash("sha256").update(hashInput, "utf8").digest("hex");
  return `${REPOSITORY_CLEANUP_KEY_PREFIX}${revisionId}${REPOSITORY_CLEANUP_KEY_SEPARATOR}${format.suffix}${digest}`;
}

/** Stable, revision-owned finite binding removal; distinct from expiry and terminal retirement. */
export function repositoryRemovalWorkKey(revisionId: string): string {
  return repositoryCleanupWorkKey(revisionId, "removal");
}

/** Terminal retirement always supersedes a Git-only removal, including after completion. */
export function repositoryRetirementWorkKey(revisionId: string): string {
  return repositoryCleanupWorkKey(revisionId, "terminal-runtime");
}
