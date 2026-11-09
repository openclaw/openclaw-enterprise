import { createHash } from "node:crypto";

/** Stable, revision-owned finite binding removal; distinct from expiry and terminal retirement. */
export function repositoryRemovalWorkKey(revisionId: string): string {
  return `agent_revision:${revisionId}:repository_cleanup:${createHash("sha256")
    .update("removal:" + revisionId, "utf8")
    .digest("hex")}`;
}

/** Terminal retirement always supersedes a Git-only removal, including after completion. */
export function repositoryRetirementWorkKey(revisionId: string): string {
  return `agent_revision:${revisionId}:repository_cleanup:retire:${createHash("sha256")
    .update(revisionId, "utf8")
    .digest("hex")}`;
}
