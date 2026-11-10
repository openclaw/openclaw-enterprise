import { request } from "node:https";
import { isSameGitHubRepository } from "../../../access/client-contracts.ts";
import { parseUnambiguousJson } from "../../../access/json-members.ts";
import { githubProviderOrigin } from "../origin.ts";
import { isGitHubNodeId, type StockGitHubPullWrite } from "../routes/stock-gh-pull-request.ts";
import { isGitHubWireCredential } from "../wire-credential.ts";

const maximumResponseBytes = 16 * 1024;
const repositoryQuery =
  "query RepositoryWriteTarget($id:ID!){node(id:$id){__typename id ... on Repository{databaseId nameWithOwner}}}";
const pullQuery =
  "query PullRequestWriteTarget($id:ID!){node(id:$id){__typename id ... on PullRequest{repository{databaseId nameWithOwner}}}}";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type Repository = Readonly<{ repositoryId: string; repository: string }>;

function matchesTarget(bytes: Buffer, action: StockGitHubPullWrite, selected: Repository): boolean {
  const response = record(
    parseUnambiguousJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)),
  );
  const node = record(record(response?.data)?.node);
  const draft = action.operation === "create-draft";
  if (
    !response ||
    Object.hasOwn(response, "errors") ||
    !node ||
    node.id !== action.nodeId ||
    node.__typename !== (draft ? "Repository" : "PullRequest")
  ) {
    return false;
  }
  const repository = draft ? node : record(node.repository);
  return (
    Number.isSafeInteger(repository?.databaseId) &&
    String(repository?.databaseId) === selected.repositoryId &&
    isSameGitHubRepository(repository?.nameWithOwner, selected.repository)
  );
}

/** Query only fixed read documents at the configured provider origin, using the exact selected-repo
 * bearer. The caller rechecks its live grant and installed recipient before releasing that bearer. */
export function createGitHubPullTargetReader(
  config: Readonly<{ origin: string; ca?: Uint8Array }>,
) {
  const origin = new URL(githubProviderOrigin(config.origin));
  const ca = config.ca && Buffer.from(config.ca);
  return (
    authorization: string,
    selected: Repository,
    action: StockGitHubPullWrite,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      signal.aborted ||
      !isGitHubWireCredential(authorization) ||
      !isGitHubNodeId(action.nodeId)
    ) {
      return Promise.resolve(false);
    }
    const body = JSON.stringify({
      query: action.operation === "create-draft" ? repositoryQuery : pullQuery,
      variables: { id: action.nodeId },
    });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    return new Promise<boolean>((resolve) => {
      const req = request(
        new URL("/graphql", origin),
        {
          method: "POST",
          signal: deadline,
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: 32768,
          ...(ca && { ca }),
          headers: {
            authorization: `Bearer ${authorization}`,
            accept: "application/json",
            "accept-encoding": "identity",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "user-agent": "openclaw-enterprise-repository-credentials",
            "x-github-api-version": "2022-11-28",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.once("error", () => resolve(false));
          response.once("aborted", () => resolve(false));
          if (
            response.statusCode !== 200 ||
            response.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json" ||
            ![undefined, "identity"].includes(response.headers["content-encoding"])
          ) {
            response.destroy();
            resolve(false);
            return;
          }
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumResponseBytes) {
              response.destroy();
              resolve(false);
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            try {
              resolve(
                response.complete &&
                  size <= maximumResponseBytes &&
                  !deadline.aborted &&
                  matchesTarget(Buffer.concat(chunks), action, selected),
              );
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.once("error", () => resolve(false));
      req.end(body);
    }).catch(() => false);
  };
}
