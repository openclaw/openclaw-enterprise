/**
 * GitLab.com repository provider identity.
 *
 * The provider owns the origin and the project identity: callers never supply a host, and the
 * canonical project path is the only project selector. Profiles map to the same read/branch/
 * merge-request/issue intent the GitHub provider exposes; merge, approval, project administration,
 * and pipeline control are not operations this provider can express.
 */

export const GITLAB_ORIGIN = "https://gitlab.com";

export type GitLabProfile = "git-read" | "git-write" | "git-full";

/** A provider refusal the caller can report without retrying a write. */
export class GitLabProviderError extends Error {
  readonly operation: string;
  readonly status: number | undefined;
  readonly possiblySent: boolean;

  constructor(
    message: string,
    options: { operation: string; status?: number; possiblySent?: boolean },
  ) {
    super(message);
    this.name = "GitLabProviderError";
    this.operation = options.operation;
    this.status = options.status;
    // A network failure or a 5xx after a write may have reached GitLab. Callers must retain the
    // operation identity and reconcile; they must never repeat the request automatically.
    this.possiblySent = options.possiblySent === true;
  }
}

/**
 * Canonical `group/project` (subgroups allowed). Refuse anything that is not a relative path:
 * no scheme, host, credentials, query, fragment, empty or dot segments, or trailing slash.
 */
export function normalizeGitLabProjectPath(value: string): string {
  const path = value.trim();
  if (path.length === 0 || path.length > 255) {
    throw new GitLabProviderError("GitLab project path must be a nonempty relative path.", {
      operation: "project.read",
    });
  }
  if (/[\0-\x20\x7f]/u.test(path) || /[?#]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path)) {
    throw new GitLabProviderError(
      "GitLab project path must not contain a scheme, host, query, or fragment.",
      { operation: "project.read" },
    );
  }
  if (path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    throw new GitLabProviderError("GitLab project path must be a canonical relative path.", {
      operation: "project.read",
    });
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new GitLabProviderError("GitLab project path must be a canonical relative path.", {
      operation: "project.read",
    });
  }
  return segments.join("/");
}

export interface DraftMergeRequestInput {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description?: string;
}

export interface DraftMergeRequestRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * GitLab executes quick actions in note bodies and descriptions. Those commands can ready,
 * approve, merge, close, or relabel a merge request or issue, which this provider must never do.
 * Refuse a line whose first non-space character starts a command rather than treating a note as a
 * comment-only effect.
 */
export function refuseGitLabQuickActions(value: string, field: string): string {
  if (/^[ \t]*\//mu.test(value)) {
    throw new GitLabProviderError(`GitLab ${field} must not contain a quick action line.`, {
      operation: "mergeRequest.note",
    });
  }
  return value;
}

function branchName(value: string, field: string): string {
  const name = value.trim();
  if (name.length === 0 || /[\0-\x20\x7f~^:?*[\\]/u.test(name) || name.includes("..")) {
    throw new GitLabProviderError(`GitLab ${field} must be a valid branch name.`, {
      operation: "mergeRequest.draft.create",
    });
  }
  return name;
}

/**
 * The request a draft create sends. The create never pushes a branch, creates a fork, or asks
 * GitLab to merge: it only opens a draft merge request between branches that already exist.
 */
export function draftMergeRequestRequest(input: DraftMergeRequestInput): DraftMergeRequestRequest {
  const sourceBranch = branchName(input.sourceBranch, "source branch");
  const targetBranch = branchName(input.targetBranch, "target branch");
  if (sourceBranch === targetBranch) {
    throw new GitLabProviderError(
      "A draft merge request needs different source and target branches.",
      {
        operation: "mergeRequest.draft.create",
      },
    );
  }
  const title = input.title.trim();
  if (title.length === 0) {
    throw new GitLabProviderError("A draft merge request needs a title.", {
      operation: "mergeRequest.draft.create",
    });
  }
  // GitLab recognizes Draft:, Draft -, [Draft], and (Draft). An ordinary word such as
  // "Draft release notes" is not a draft marker, so it must be prefixed.
  const draftTitle = /^(?:draft\s*:|draft\s+-|\[draft\]|\(draft\))/iu.test(title)
    ? title
    : `Draft: ${title}`;
  return Object.freeze({
    method: "POST",
    path: "/merge_requests",
    body: Object.freeze({
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title: draftTitle,
      ...(input.description === undefined
        ? {}
        : {
            description: refuseGitLabQuickActions(input.description, "merge request description"),
          }),
    }),
  });
}
