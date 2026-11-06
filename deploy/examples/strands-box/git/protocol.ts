import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PreparedGitHubRepositoryUseRequest } from "@openclaw-enterprise/contracts";

export const GIT_ORIGIN = "https://github.com";
export const API_ORIGIN = "https://api.github.com";
export const BODY_LIMIT = 8 * 1024 * 1024;
export const REPLY_LIMIT = 16 * 1024 * 1024;

type Operation = PreparedGitHubRepositoryUseRequest["operation"];

export interface RepositorySelection {
  readonly repository: string;
  readonly repositoryId: string;
  readonly installationId: string;
  /** Ref names without the refs/heads/ prefix. */
  readonly head: string;
  readonly base: string;
}

interface Plan {
  readonly operation: Operation;
  readonly method: "GET" | "POST";
  readonly origin: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly expectedContentType: string;
}

export function repositorySelection(input: RepositorySelection): RepositorySelection {
  const branch = (name: string) =>
    /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(name) && name.length <= 128;
  if (
    !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository) ||
    /\/(?:\.|\.\.)$/.test(input.repository) ||
    !/^[1-9][0-9]{0,15}$/.test(input.repositoryId) ||
    !/^[1-9][0-9]{0,15}$/.test(input.installationId) ||
    !branch(input.head) ||
    !branch(input.base) ||
    input.head === input.base
  ) {
    throw new Error("One exact GitHub repository and distinct head/base branches are required.");
  }
  return Object.freeze({ ...input });
}

function header(message: IncomingMessage, name: string): string | undefined {
  const values = message.headersDistinct[name];
  if (values !== undefined && values.length !== 1) {
    throw new Error("Ambiguous HTTP header.");
  }
  return values?.[0];
}

export async function boundedBody(
  message: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = header(message, "content-length");
  if (declared !== undefined && (!/^[0-9]{1,9}$/.test(declared) || Number(declared) > limit)) {
    throw new Error("Body limit.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const cancel = () => message.destroy();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of message) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > limit) {
        throw new Error("Body limit.");
      }
      chunks.push(chunk);
    }
    if (!message.complete || (declared !== undefined && bytes !== Number(declared))) {
      throw new Error("Incomplete body.");
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function githubHeaders(origin: string, type?: string, size?: number, gitProtocol?: string) {
  return Object.freeze({
    host: new URL(origin).host,
    connection: "close",
    "user-agent": "openclaw-fixed-repository-sender",
    "accept-encoding": "identity",
    ...(type === undefined ? {} : { "content-type": type, "content-length": String(size) }),
    ...(gitProtocol === undefined ? {} : { "git-protocol": gitProtocol }),
    ...(origin === API_ORIGIN ? { accept: "application/vnd.github+json" } : {}),
  });
}

export async function planRequest(
  message: IncomingMessage,
  repository: RepositorySelection,
  signal: AbortSignal,
): Promise<Plan | undefined> {
  if (
    message.httpVersion !== "1.1" ||
    header(message, "authorization") !== undefined ||
    header(message, "content-encoding") !== undefined
  ) {
    return;
  }
  if (message.url === "/draft-pull" && message.method === "POST") {
    if (
      header(message, "content-type") !== "application/json" ||
      header(message, "git-protocol") !== undefined
    ) {
      return;
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBody(message, 2_048, signal),
    );
    // Exactly one literal key; duplicates and extra caller-supplied routing fields are invalid.
    if (
      !/^\s*\{\s*"title"\s*:\s*"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"\s*\}\s*$/.test(
        raw,
      )
    ) {
      return;
    }
    const input: unknown = JSON.parse(raw);
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "title" ||
      !("title" in input) ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 200 ||
      /[\x00-\x1f\x7f]/.test(input.title)
    ) {
      return;
    }
    const body = Buffer.from(
      JSON.stringify({
        title: input.title,
        head: repository.head,
        base: repository.base,
        draft: true,
      }),
    );
    return {
      operation: "github-rest",
      method: "POST",
      origin: API_ORIGIN,
      path: `/repos/${repository.repository}/pulls`,
      body,
      headers: githubHeaders(API_ORIGIN, "application/json", body.length),
      expectedContentType: "application/json",
    };
  }
  const git =
    /^\/repository\.git\/(?:info\/refs\?service=(git-(?:upload|receive)-pack)|(git-(?:upload|receive)-pack))$/.exec(
      message.url ?? "",
    );
  if (git === null) {
    return;
  }
  const service = git[1] ?? git[2];
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return;
  }
  const discover = git[1] !== undefined;
  const upload = service === "git-upload-pack";
  const method = discover ? "GET" : "POST";
  const type = discover ? undefined : `application/x-${service}-request`;
  const gitProtocol = header(message, "git-protocol");
  if (
    message.method !== method ||
    header(message, "content-type") !== type ||
    (gitProtocol !== undefined && gitProtocol !== "version=1" && gitProtocol !== "version=2")
  ) {
    return;
  }
  const body = await boundedBody(message, discover ? 0 : BODY_LIMIT, signal);
  if (!discover && body.length === 0) {
    return;
  }
  return {
    operation: upload
      ? discover
        ? "advertise-upload-pack"
        : "upload-pack"
      : discover
        ? "advertise-receive-pack"
        : "receive-pack",
    method,
    origin: GIT_ORIGIN,
    path: `/${repository.repository}.git/${discover ? `info/refs?service=${service}` : service}`,
    headers: githubHeaders(GIT_ORIGIN, type, body.length, gitProtocol),
    body,
    expectedContentType: `application/x-${service}-${discover ? "advertisement" : "result"}`,
  };
}

export type PlannedRequest = NonNullable<Awaited<ReturnType<typeof planRequest>>>;

export function requestDigest(plan: PlannedRequest): string {
  // Authorize the exact normalized request. The injected credential is bound
  // by its independently installed attempt and version, not placed in a digest.
  return createHash("sha256")
    .update(
      JSON.stringify([plan.method, plan.origin, plan.path, Object.entries(plan.headers).sort()]),
    )
    .update(plan.body)
    .digest("hex");
}

function object(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : undefined;
}

export function confirmedDraft(
  bytes: Buffer,
  repo: RepositorySelection,
): { id: string; number: number; url: string; draft: true; state: "open" } {
  const input = object(JSON.parse(bytes.toString("utf8")));
  if (!input) throw new Error("Unverified draft result.");
  const { id, number, draft, state, html_url: url } = input;
  const match = (value: unknown, ref: string) => {
    const entry = object(value);
    const source = object(entry?.repo);
    return (
      entry?.ref === ref &&
      String(source?.id) === repo.repositoryId &&
      source?.full_name === repo.repository
    );
  };
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    draft !== true ||
    state !== "open" ||
    url !== `${GIT_ORIGIN}/${repo.repository}/pull/${number}` ||
    !match(input.head, repo.head) ||
    !match(input.base, repo.base)
  ) {
    throw new Error("Unverified draft result.");
  }
  return { id: String(id), number, url, draft, state };
}
