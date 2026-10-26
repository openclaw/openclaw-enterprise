import type {
  PreparedGitHubPullProjection,
  PreparedGitHubPullScope,
} from "@openclaw-enterprise/contracts";
import type { Denied, RequestHead, RequestPlan } from "../../credentials/backend-contracts.ts";
import type { JsonValue } from "../../credentials/json-value.ts";
import { parseJsonMembers, parseUnambiguousJson } from "../../credentials/json-members.ts";
import { isGitHubPullUrl } from "../../credentials/client-contracts.ts";

export const draftOperationId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumBody = 64 * 1024;
const refuse = (): never => {
  throw new Error("invalid-draft-pull");
};
type Target = Omit<PreparedGitHubPullScope, "operationId"> & { repositoryId: string };

function canonicalBody(bytes: Uint8Array, target: Target) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const q = parseUnambiguousJson(text) as Record<string, unknown>;
  const { title, head, base, body = "", draft } = q;
  if (
    Object.keys(q).some((k) => !["title", "head", "base", "body", "draft"].includes(k)) ||
    head !== target.head ||
    base !== target.base ||
    draft !== true ||
    typeof title !== "string" ||
    !title.trim() ||
    Buffer.byteLength(title) > 256 ||
    /[\0\r\n]/.test(title) ||
    Buffer.from(title).toString() !== title ||
    typeof body !== "string" ||
    Buffer.byteLength(body) > 60 * 1024 ||
    Buffer.from(body).toString() !== body
  ) {
    return refuse();
  }
  const result = Buffer.from(
    JSON.stringify({ title, head, base, body, draft, maintainer_can_modify: false }),
  );
  if (result.length > maximumBody) {
    return refuse();
  }
  return result;
}

/** Reconstruct the allowlist, including at the State receipt boundary. Never store raw GitHub JSON. */
export function validateDraftProjection(
  p: PreparedGitHubPullProjection,
  target: Target,
): PreparedGitHubPullProjection {
  const { id, number, url, state, draft } = p;
  if (
    typeof id !== "string" ||
    !/^[1-9][0-9]{0,39}$/.test(id) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    state !== "open" ||
    draft !== true ||
    // GitHub's spelling of the lowercased name; stored lowercase URLs still match (finding 2236).
    !isGitHubPullUrl(url, target.repository, number)
  ) {
    return refuse();
  }
  const side = (key: "head" | "base") => {
    const { repositoryId, ref, sha } = p[key];
    if (
      repositoryId !== target.repositoryId ||
      ref !== target[key] ||
      typeof sha !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)
    ) {
      return refuse();
    }
    return { repositoryId, ref, sha };
  };
  return { id, number, url, state, draft, head: side("head"), base: side("base") };
}

function project(value: JsonValue, target: Target): JsonValue {
  type Branch = { repo: { id: string }; ref: string; sha: string };
  const p = value as unknown as PreparedGitHubPullProjection & {
    html_url: string;
    head: Branch;
    base: Branch;
  };
  const side = ({ repo, ref, sha }: Branch) => ({ repositoryId: repo.id, ref, sha });
  return validateDraftProjection(
    {
      id: p.id,
      number: p.number,
      url: p.html_url,
      state: p.state,
      draft: p.draft,
      head: side(p.head),
      base: side(p.base),
    },
    target,
  ) as unknown as JsonValue;
}

/** A different protocol from generic GitHub REST. Recognize precisely the admitted draft-create. */
export function planDraftPull(
  head: RequestHead,
  target: Target,
  remember: (p: RequestPlan, scope: PreparedGitHubPullScope) => void,
): RequestPlan | Denied {
  const path = "/repos/" + target.repository + "/pulls";
  const h = head.headers;
  const operationId = h["x-oce-operation-id"];
  if (
    head.rawTarget !== path ||
    head.method !== "POST" ||
    head.contentEncoding !== "identity" ||
    h["content-type"] !== "application/json" ||
    !operationId ||
    !draftOperationId.test(operationId) ||
    Object.keys(h).some(
      (k) =>
        !["content-type", "x-oce-operation-id", "user-agent", "accept", "accept-encoding"].includes(
          k,
        ),
    )
  ) {
    return { kind: "denied", status: 400, code: "unsupported-request" };
  }

  const { apiOrigin, repository, head: source, base, repositoryId } = target;
  const plan = {
    origin: apiOrigin,
    method: "POST",
    target: path,
    category: "api",
    effect: "write",
    requestHeaders: {
      "user-agent": "openclaw-enterprise-repository-credentials",
      "content-type": "application/json",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
    },
    bindRequestDigest: true,
    digestScope: ["draft-pull-v1", repositoryId, source, base],
    limits: {
      inputWireBytes: maximumBody,
      inputDecodedBytes: maximumBody,
      responseBytes: 1024 * 1024,
      totalMs: 30000,
      inputMs: 10000,
      firstHeaderMs: 20000,
      stallMs: 10000,
      connectMs: 5000,
    },
    inputPolicy(bytes: Uint8Array) {
      try {
        return { body: canonicalBody(bytes, target) };
      } catch {
        return false;
      }
    },
    responsePolicy: {
      body: "bounded-json",
      trailers: "forbid",
      headers(status: number, headers: Readonly<Record<string, string>>) {
        if (
          status !== 201 ||
          headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
        ) {
          return refuse();
        }
        return { "content-type": "application/json" };
      },
      // The JSON reviver's original number token avoids rounding 64-bit GitHub IDs.
      parseJson: (text: string) =>
        parseJsonMembers(text, refuse, (key, value, context) =>
          key === "id" && typeof value === "number" ? context?.source : value,
        ),
      rewriteJson: (v: JsonValue) => project(v, target),
    },
  } as unknown as RequestPlan;
  remember(plan, { operationId, apiOrigin, repository, head: source, base });
  return plan;
}
