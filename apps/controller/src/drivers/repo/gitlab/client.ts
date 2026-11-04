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

export interface GitLabProject {
  readonly id: number;
  readonly pathWithNamespace: string;
  readonly defaultBranch?: string;
  readonly visibility?: string;
}

export interface GitLabBranch {
  readonly name: string;
  readonly default: boolean;
  readonly commit: { readonly id: string };
}

export interface GitLabIssue {
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly webUrl?: string;
}

export interface GitLabMergeRequest {
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly webUrl?: string;
}

export interface GitLabPipeline {
  readonly id: number;
  readonly status: string;
  readonly ref: string;
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
  const draftTitle = /^draft\b/iu.test(title) ? title : `Draft: ${title}`;
  return Object.freeze({
    method: "POST",
    path: "/merge_requests",
    body: Object.freeze({
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title: draftTitle,
      ...(input.description === undefined ? {} : { description: input.description }),
    }),
  });
}

type Fetch = typeof fetch;

export interface GitLabClientOptions {
  readonly projectPath: string;
  readonly profile: GitLabProfile;
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly fetch?: Fetch;
  readonly origin?: string;
}

/**
 * Service-side GitLab.com API client. The token stays in this process; requests are bound to the
 * fixed origin and the configured project. A caller cannot select another host or project.
 */
export class GitLabRepositoryClient {
  readonly projectPath: string;
  readonly profile: GitLabProfile;
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #origin: string;
  readonly #signal: AbortSignal | undefined;

  constructor(options: GitLabClientOptions) {
    this.projectPath = normalizeGitLabProjectPath(options.projectPath);
    this.profile = options.profile;
    const token = options.token.trim();
    if (token.length === 0) {
      throw new GitLabProviderError("A GitLab token is required.", { operation: "project.read" });
    }
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#origin = options.origin ?? GITLAB_ORIGIN;
    this.#signal = options.signal;
  }

  #require(operation: GitLabOperation): void {
    if (!gitLabOperationAllowed(this.profile, operation)) {
      throw new GitLabProviderError(`The ${this.profile} profile does not allow ${operation}.`, {
        operation,
      });
    }
  }

  #url(path: string): string {
    return `${this.#origin}/api/v4/projects/${encodeURIComponent(this.projectPath)}${path}`;
  }

  async #request<T>(
    operation: GitLabOperation,
    method: "GET" | "POST",
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    this.#require(operation);
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path), {
        method,
        headers: {
          "PRIVATE-TOKEN": this.#token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect could carry the token to another host.
        redirect: "error",
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
    } catch {
      throw new GitLabProviderError("The GitLab request did not complete.", {
        operation,
        // A write that failed in transport may still have been accepted upstream.
        possiblySent: method === "POST",
      });
    }
    if (!response.ok) {
      throw new GitLabProviderError(`GitLab refused the ${operation} request.`, {
        operation,
        status: response.status,
        possiblySent: method === "POST" && response.status >= 500,
      });
    }
    return (await response.json()) as T;
  }

  async project(): Promise<GitLabProject> {
    const raw = await this.#request<Record<string, unknown>>("project.read", "GET", "");
    return Object.freeze({
      id: Number(raw.id),
      pathWithNamespace: String(raw.path_with_namespace),
      ...(typeof raw.default_branch === "string" ? { defaultBranch: raw.default_branch } : {}),
      ...(typeof raw.visibility === "string" ? { visibility: raw.visibility } : {}),
    });
  }

  async branches(): Promise<readonly GitLabBranch[]> {
    const raw = await this.#request<readonly Record<string, unknown>[]>(
      "branches.read",
      "GET",
      "/repository/branches?per_page=100",
    );
    return Object.freeze(
      raw.map((branch) =>
        Object.freeze({
          name: String(branch.name),
          default: branch.default === true,
          commit: Object.freeze({ id: String((branch.commit as Record<string, unknown>).id) }),
        }),
      ),
    );
  }

  async issues(state: "opened" | "closed" | "all" = "opened"): Promise<readonly GitLabIssue[]> {
    const raw = await this.#request<readonly Record<string, unknown>[]>(
      "issues.read",
      "GET",
      `/issues?state=${state}&per_page=100`,
    );
    return Object.freeze(
      raw.map((issue) =>
        Object.freeze({
          iid: Number(issue.iid),
          title: String(issue.title),
          state: String(issue.state),
          ...(typeof issue.web_url === "string" ? { webUrl: issue.web_url } : {}),
        }),
      ),
    );
  }

  async mergeRequests(
    state: "opened" | "closed" | "all" = "opened",
  ): Promise<readonly GitLabMergeRequest[]> {
    const raw = await this.#request<readonly Record<string, unknown>[]>(
      "mergeRequests.read",
      "GET",
      `/merge_requests?state=${state}&per_page=100`,
    );
    return Object.freeze(
      raw.map((mergeRequest) =>
        Object.freeze({
          iid: Number(mergeRequest.iid),
          title: String(mergeRequest.title),
          state: String(mergeRequest.state),
          sourceBranch: String(mergeRequest.source_branch),
          targetBranch: String(mergeRequest.target_branch),
          ...(typeof mergeRequest.web_url === "string" ? { webUrl: mergeRequest.web_url } : {}),
        }),
      ),
    );
  }

  async pipelines(): Promise<readonly GitLabPipeline[]> {
    const raw = await this.#request<readonly Record<string, unknown>[]>(
      "pipelines.read",
      "GET",
      "/pipelines?per_page=100",
    );
    return Object.freeze(
      raw.map((pipeline) =>
        Object.freeze({
          id: Number(pipeline.id),
          status: String(pipeline.status),
          ref: String(pipeline.ref),
        }),
      ),
    );
  }

  async createDraftMergeRequest(input: DraftMergeRequestInput): Promise<GitLabMergeRequest> {
    const request = draftMergeRequestRequest(input);
    const raw = await this.#request<Record<string, unknown>>(
      "mergeRequest.draft.create",
      request.method,
      request.path,
      request.body,
    );
    return Object.freeze({
      iid: Number(raw.iid),
      title: String(raw.title),
      state: String(raw.state),
      sourceBranch: String(raw.source_branch),
      targetBranch: String(raw.target_branch),
      ...(typeof raw.web_url === "string" ? { webUrl: raw.web_url } : {}),
    });
  }

  async addMergeRequestNote(iid: number, body: string): Promise<void> {
    await this.#request("mergeRequest.note", "POST", `/merge_requests/${iid}/notes`, { body });
  }

  async createIssue(title: string, description?: string): Promise<GitLabIssue> {
    const raw = await this.#request<Record<string, unknown>>("issue.create", "POST", "/issues", {
      title,
      ...(description === undefined ? {} : { description }),
    });
    return Object.freeze({
      iid: Number(raw.iid),
      title: String(raw.title),
      state: String(raw.state),
      ...(typeof raw.web_url === "string" ? { webUrl: raw.web_url } : {}),
    });
  }

  async addIssueNote(iid: number, body: string): Promise<void> {
    await this.#request("issue.note", "POST", `/issues/${iid}/notes`, { body });
  }
}
