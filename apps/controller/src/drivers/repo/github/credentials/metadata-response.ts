import type { ResponsePolicy } from "../../credentials/backend-contracts.ts";

/** Closed metadata reads release configured identity, never provider display data. */
export function createMetadataResponsePolicy(
  repository: string,
  repositoryId: string,
): ResponsePolicy {
  const id = Number(repositoryId);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== repositoryId) {
    throw new Error("invalid-repository-identity");
  }
  return Object.freeze<ResponsePolicy>({
    body: "bounded-json",
    trailers: "forbid",
    headers(status: number) {
      if (status !== 200) {
        throw new Error("invalid-upstream");
      }
      return { "content-type": "application/json", "cache-control": "no-store" };
    },
    rewriteJson(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.id !== id ||
        value.full_name !== repository
      ) {
        throw new Error("invalid-upstream");
      }
      return { id, full_name: repository };
    },
  });
}
