import { hasControlCharacter } from "../credentials/client-contracts.ts";

/** GitLab.com request policy shared by the configured Repo Driver and route owner. */
export type GitLabProfile = "git-read" | "git-write" | "git-full";

export type GitLabOperation =
  | "project.read"
  | "branches.read"
  | "issues.read"
  | "mergeRequests.read"
  | "pipelines.read"
  | "mergeRequest.draft.create"
  | "mergeRequest.note"
  | "issue.create"
  | "issue.note";

const READ_OPERATIONS: readonly GitLabOperation[] = [
  "project.read",
  "branches.read",
  "issues.read",
  "mergeRequests.read",
  "pipelines.read",
];

const WRITE_OPERATIONS: readonly GitLabOperation[] = [
  ...READ_OPERATIONS,
  "mergeRequest.draft.create",
  "mergeRequest.note",
];

const FULL_OPERATIONS: readonly GitLabOperation[] = [
  ...WRITE_OPERATIONS,
  "issue.create",
  "issue.note",
];

const PROFILE_OPERATIONS: Readonly<Record<GitLabProfile, readonly GitLabOperation[]>> =
  Object.freeze({
    "git-read": Object.freeze(READ_OPERATIONS),
    "git-write": Object.freeze(WRITE_OPERATIONS),
    "git-full": Object.freeze(FULL_OPERATIONS),
  });

export function gitLabProfileOperations(profile: GitLabProfile): readonly GitLabOperation[] {
  return PROFILE_OPERATIONS[profile];
}

export function gitLabOperationAllowed(
  profile: GitLabProfile,
  operation: GitLabOperation,
): boolean {
  return PROFILE_OPERATIONS[profile].includes(operation);
}

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
    this.possiblySent = options.possiblySent === true;
  }
}

/** Canonical `group/project` identity; hosts, schemes, credentials and dot segments are refused. */
export function normalizeGitLabProjectPath(value: string): string {
  const path = value.trim();
  if (path.length === 0 || path.length > 255) {
    throw new GitLabProviderError("GitLab project path must be a nonempty relative path.", {
      operation: "project.read",
    });
  }
  if (hasControlCharacter(path) || /[?#]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path)) {
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

/** GitLab quick actions could turn a comment or draft description into an unintended effect. */
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
  if (
    name.length === 0 ||
    hasControlCharacter(name) ||
    /[~^:?*[\\]/u.test(name) ||
    name.includes("..")
  ) {
    throw new GitLabProviderError(`GitLab ${field} must be a valid branch name.`, {
      operation: "mergeRequest.draft.create",
    });
  }
  return name;
}

export function draftMergeRequestRequest(input: DraftMergeRequestInput): DraftMergeRequestRequest {
  const sourceBranch = branchName(input.sourceBranch, "source branch");
  const targetBranch = branchName(input.targetBranch, "target branch");
  if (sourceBranch === targetBranch) {
    throw new GitLabProviderError(
      "A draft merge request needs different source and target branches.",
      { operation: "mergeRequest.draft.create" },
    );
  }
  const title = input.title.trim();
  if (title.length === 0) {
    throw new GitLabProviderError("A draft merge request needs a title.", {
      operation: "mergeRequest.draft.create",
    });
  }
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
