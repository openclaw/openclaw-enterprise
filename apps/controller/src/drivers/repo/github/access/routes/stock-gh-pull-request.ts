import { createHash } from "node:crypto";
import type { RequestHead } from "../../../access/backend-contracts.ts";
import { isSameGitHubRepository, isWellFormedBranchRef } from "../../../access/client-contracts.ts";
import { parseUnambiguousJson } from "../../../access/json-members.ts";

type ReadOperation =
  | "repository-info"
  | "pull-request-for-branch"
  | "pull-request-by-number"
  | "pull-request-project-items";

export type StockGitHubPullAction =
  | { readonly operation: ReadOperation }
  | { readonly operation: "create-draft"; readonly nodeId: string }
  | { readonly operation: "edit-title"; readonly nodeId: string };

export type StockGitHubPullWrite = Extract<StockGitHubPullAction, { nodeId: string }>;

// SHA-256 of the complete decoded query string emitted by stock gh 2.103.2.
// The client omits operationName. Matching the entire document also fixes its
// aliases, fragments, selected fields, and number of operations.
const document = {
  repositoryInfo: "9cc1468fc39b340065b749e253c84fdc9b64e9030bdce36e76c24d7122352d44",
  pullRequestForBranch: "adc9d0ec385ce2fc0eb20094b15e0895869025e94be048c17233103257eddea3",
  pullRequestCreate: "5f2b97a70bee012f3245871462c8ae7cd840a70e549788d7d10c7e2321108e86",
  pullRequestByNumber: "c21a38ed0f94590d19d1bd6486f241236db90538c25d88c7a7cbe08c41d218e1",
  pullRequestProjectItems: "699a348b871307b4cf5d51134eb4fed3b1991e67fef56cbd3563852db35d7182",
  pullRequestUpdate: "d2ebd82ca9f731694b1aff72d30a1dd6c267dd826cf370bdad095a6a6181db80",
};

export function isGitHubNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/_-]{1,250}={0,2}$/.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function selected(owner: unknown, name: unknown, repository: string): boolean {
  return (
    typeof owner === "string" &&
    typeof name === "string" &&
    isSameGitHubRepository(owner + "/" + name, repository)
  );
}

function branch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 255 &&
    Buffer.from(value).toString() === value &&
    isWellFormedBranchRef("refs/heads/" + value)
  );
}

function validPrNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}

function validTitle(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    Buffer.from(value).toString() === value &&
    !/[\0\r\n]/.test(value)
  );
}

function write(input: Record<string, unknown>, create: boolean): StockGitHubPullWrite | undefined {
  if (!validTitle(input.title)) {
    return;
  }
  if (!create) {
    return exactKeys(input, ["pullRequestId", "title"]) && isGitHubNodeId(input.pullRequestId)
      ? { operation: "edit-title", nodeId: input.pullRequestId }
      : undefined;
  }
  if (
    exactKeys(input, [
      "repositoryId",
      "title",
      "body",
      "baseRefName",
      "headRefName",
      "draft",
      "maintainerCanModify",
    ]) &&
    isGitHubNodeId(input.repositoryId) &&
    branch(input.baseRefName) &&
    branch(input.headRefName) &&
    input.draft === true &&
    typeof input.maintainerCanModify === "boolean" &&
    typeof input.body === "string" &&
    Buffer.byteLength(input.body) <= 60 * 1024 &&
    Buffer.from(input.body).toString() === input.body
  ) {
    return { operation: "create-draft", nodeId: input.repositoryId };
  }
}

/** Classify a complete, normalized request after HTTPS origin and header validation. A write
 * still requires the provider to attest that the named node belongs to the admitted repository. */
export function selectStockGitHubPullRequest(
  head: Pick<RequestHead, "method" | "rawTarget" | "headers" | "contentEncoding">,
  bytes: Uint8Array,
  repository: string,
): StockGitHubPullAction | undefined {
  if (
    head.method !== "POST" ||
    head.rawTarget !== "/graphql" ||
    head.contentEncoding !== "identity" ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(head.headers["content-type"] ?? "") ||
    bytes.byteLength === 0 ||
    bytes.byteLength > 64 * 1024
  ) {
    return;
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = record(
      parseUnambiguousJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      ),
    );
  } catch {
    return;
  }
  if (!body || !exactKeys(body, ["query", "variables"]) || typeof body.query !== "string") {
    return;
  }
  const variables = record(body.variables);
  if (!variables) {
    return;
  }
  const digest = createHash("sha256").update(body.query).digest("hex");
  switch (digest) {
    case document.repositoryInfo:
      return exactKeys(variables, ["owner", "name"]) &&
        selected(variables.owner, variables.name, repository)
        ? { operation: "repository-info" }
        : undefined;
    case document.pullRequestForBranch:
      return exactKeys(variables, ["owner", "repo", "headRefName", "states"]) &&
        selected(variables.owner, variables.repo, repository) &&
        branch(variables.headRefName) &&
        Array.isArray(variables.states) &&
        variables.states.length === 1 &&
        variables.states[0] === "OPEN"
        ? { operation: "pull-request-for-branch" }
        : undefined;
    case document.pullRequestByNumber:
      return exactKeys(variables, ["owner", "repo", "pr_number"]) &&
        selected(variables.owner, variables.repo, repository) &&
        validPrNumber(variables.pr_number)
        ? { operation: "pull-request-by-number" }
        : undefined;
    case document.pullRequestProjectItems:
      return exactKeys(variables, ["owner", "name", "number", "endCursor"]) &&
        selected(variables.owner, variables.name, repository) &&
        validPrNumber(variables.number) &&
        (variables.endCursor === null ||
          (typeof variables.endCursor === "string" &&
            /^[A-Za-z0-9+/_-]{1,1024}={0,2}$/.test(variables.endCursor)))
        ? { operation: "pull-request-project-items" }
        : undefined;
    case document.pullRequestCreate:
    case document.pullRequestUpdate: {
      const input = exactKeys(variables, ["input"]) && record(variables.input);
      return input ? write(input, digest === document.pullRequestCreate) : undefined;
    }
  }
}
