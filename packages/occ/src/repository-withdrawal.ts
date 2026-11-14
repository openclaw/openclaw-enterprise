import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { createHash } from "node:crypto";
import type { ControllerWork } from "./controller-work.ts";

export const REPOSITORY_CLEANUP_KEY_PREFIX = "agent_revision:";
export const REPOSITORY_CLEANUP_KEY_SEPARATOR = ":repository_cleanup:";
export const REVISION_ID_PATTERN =
  "rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REPOSITORY_CLEANUP_TERMINAL_MARKER = "retire:";

// Agent deletion retains these keys after detaching their revision. Keep the cleanup key
// grammar the database recognizes, with separate digest domains for expiry and removal.
export const REPOSITORY_CLEANUP_FORMATS = {
  sessions: { suffix: "", hashPrefix: "" },
  expiry: { suffix: "", hashPrefix: "expiry:" },
  removal: { suffix: "", hashPrefix: "removal:" },
  "terminal-runtime": { suffix: REPOSITORY_CLEANUP_TERMINAL_MARKER, hashPrefix: "" },
} as const;

export const REPOSITORY_CLEANUP_KEY_TAIL_PATTERN = `${REPOSITORY_CLEANUP_KEY_SEPARATOR}(${REPOSITORY_CLEANUP_TERMINAL_MARKER})?[0-9a-f]{64}$`;
export const REPOSITORY_CLEANUP_KEY_PATTERN = `^${REPOSITORY_CLEANUP_KEY_PREFIX}(${REVISION_ID_PATTERN})${REPOSITORY_CLEANUP_KEY_TAIL_PATTERN}`;
const REPOSITORY_CLEANUP_KEY = new RegExp(REPOSITORY_CLEANUP_KEY_PATTERN);

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

/** Cleanup dispatch and retry exemption require an exact immutable revision target. */
export function repositoryCleanupRevisionId(
  work: Pick<ControllerWork, "idempotencyKey" | "namespaceTarget" | "agentTarget">,
): string | undefined {
  if (work.namespaceTarget !== undefined || work.agentTarget !== undefined) {
    return undefined;
  }
  const key = REPOSITORY_CLEANUP_KEY.exec(work.idempotencyKey);
  return key?.[0] === work.idempotencyKey ? key[1] : undefined;
}

export function isRepositoryCleanupWork(
  work: Pick<
    ControllerWork,
    "idempotencyKey" | "agentId" | "revisionId" | "namespaceTarget" | "agentTarget"
  >,
): boolean {
  const revisionId = repositoryCleanupRevisionId(work);
  return (
    revisionId !== undefined &&
    ((work.revisionId === revisionId && isNonEmptyString(work.agentId)) ||
      (work.revisionId === undefined && work.agentId === undefined))
  );
}

/** Runtime retirement is distinct from session-only repair and rotation cleanup. */
export function isRepositoryRuntimeRetirementWork(
  work: Parameters<typeof isRepositoryCleanupWork>[0],
): boolean {
  return (
    isRepositoryCleanupWork(work) &&
    REPOSITORY_CLEANUP_KEY.exec(work.idempotencyKey)?.[2] === REPOSITORY_CLEANUP_TERMINAL_MARKER
  );
}

/** Expiry can withdraw Git alone. Terminal retirement can never become expiry cleanup. */
export function isRepositoryExpiryCleanupWork(
  work: Parameters<typeof isRepositoryCleanupWork>[0],
): boolean {
  const revisionId = repositoryCleanupRevisionId(work);
  return (
    revisionId !== undefined &&
    isRepositoryCleanupWork(work) &&
    (work.idempotencyKey === repositoryCleanupWorkKey(revisionId, "expiry") ||
      work.idempotencyKey === repositoryRemovalWorkKey(revisionId))
  );
}
