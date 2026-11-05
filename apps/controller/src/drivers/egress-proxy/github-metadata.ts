import {
  credentialFreeMetadataGrant,
  credentialFreeMetadataType,
  credentialFreeProviderRef,
  githubMetadataGrant,
  preparedGitHubProviderRef,
  preparedGitHubType,
  type CredentialProviderDefinition,
  type EgressRoute,
  type EgressRequest,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import { isSameGitHubRepository } from "../repo/credentials/client-contracts.ts";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import { isGitHubWireCredential } from "../repo/github/credentials/wire-credential.ts";

function closedRequest(route: EgressRoute, request: EgressRequest): boolean {
  const { grant } = route.binding;
  if (
    (grant.kind !== "github_repository_metadata" &&
      grant.kind !== "credential_free_repository_metadata") ||
    grant.profile !== "metadata-read" ||
    grant.isolationId !== route.binding.execution.agentId ||
    grant.isolationId !== route.binding.isolationId ||
    route.method !== "GET" ||
    request.method !== "GET" ||
    request.body.byteLength !== 0 ||
    request.url !== route.origin + route.path ||
    route.path !== `/repos/${grant.repository}` ||
    request.headers.length > 32
  ) {
    return false;
  }
  const seen = new Set<string>();
  return request.headers.every(([name, value]) => {
    const key = name.toLowerCase();
    if (seen.has(key) || /[^\x20-\x7e]/.test(value)) {
      return false;
    }
    seen.add(key);
    if (key === "host") {
      return value === new URL(route.origin).host;
    }
    if (key === "content-length") {
      return value === "0";
    }
    if (key === "accept-encoding") {
      return value === "identity";
    }
    if (key === "connection") {
      return /^(?:close|keep-alive)$/i.test(value);
    }
    return value.length <= 1024 && ["accept", "user-agent"].includes(key);
  });
}

/** The complete protected operation, deliberately distinct from Git discovery, clone or push. */
export const githubMetadataProvider: CredentialProviderDefinition =
  Object.freeze<CredentialProviderDefinition>({
    ref: preparedGitHubProviderRef,
    schemaVersion: 1,
    sourceType: {
      type: preparedGitHubType,
      rotation: "none",
      config: [
        "app_id",
        "installation_id",
        "repository_id",
        "repository",
        "agent_id",
        "authority",
      ].map((name) => ({ name, required: true })),
      secrets: [{ name: "private_key", required: true }],
    },
    normalizeConfig(config) {
      githubMetadataGrant(config);
      return immutableCopy(config);
    },
    normalizeGrant(_models, config) {
      return githubMetadataGrant(config ?? {});
    },
    routes(source, binding) {
      const admitted = source.egress;
      if (
        (admitted?.adoption !== "prepared" && admitted?.adoption !== "credential_free") ||
        admitted.grant.kind === "prepared_scope" ||
        !isDeepStrictEqual(binding.grant, admitted.grant) ||
        binding.execution.agentId !== admitted.grant.isolationId
      ) {
        throw new Error("Protected repository metadata requires consent naming this exact Agent.");
      }
      return [
        immutableCopy({
          route: { id: binding.binding.id + "/metadata", generation: binding.binding.generation },
          binding,
          origin: admitted.origin,
          path: "/repos/" + admitted.grant.repository,
          method: "GET" as const,
          operationPolicy: { id: "github-bodyless-metadata-get", generation: 1 },
          responsePolicy: { id: "github-complete-repository-identity-only", generation: 1 },
          deadlineMs: 30_000,
        }),
      ];
    },
    classify(route, request) {
      const { grant } = route.binding;
      return closedRequest(route, request) &&
        grant.kind !== "inference" &&
        grant.kind !== "prepared_scope"
        ? { kind: grant.kind, repository: grant.repository, repositoryId: grant.repositoryId }
        : undefined;
    },
    inject(value) {
      if (!isGitHubWireCredential(value)) {
        throw new Error("Invalid prepared GitHub installation credential.");
      }
      return [["authorization", "Bearer " + value]];
    },
    // A status alone, including GitHub 401, does not prove a specific credential was rejected.
    credentialRejected() {
      return false;
    },
    protectResponse(response, _value, _request, operation) {
      const { trailers, headers } = response;
      const media = headers.filter(([name]) => name.toLowerCase() === "content-type");
      if (
        operation.kind === "inference" ||
        operation.kind === "prepared_scope" ||
        response.status !== 200 ||
        trailers?.length !== 0 ||
        response.body.byteLength > 64 * 1024 ||
        media.length !== 1 ||
        !/^application\/(?:vnd\.github\+)?json(?:;\s*charset=utf-8)?$/i.test(media[0]![1]) ||
        headers.some(([name]) =>
          ["content-encoding", "trailer", "upgrade", "location"].includes(name.toLowerCase()),
        )
      ) {
        return undefined;
      }
      try {
        const { id, full_name } = parseUnambiguousJson(
          new TextDecoder("utf8", { fatal: true }).decode(response.body),
        ) as Record<string, unknown>;
        // GitHub answers with the repository's own spelling; release the admitted one (finding 2239).
        if (
          id !== Number(operation.repositoryId) ||
          !isSameGitHubRepository(full_name, operation.repository)
        ) {
          return undefined;
        }
        return {
          status: 200,
          headers: [
            ["content-type", "application/json"],
            ["cache-control", "no-store"],
          ],
          body: Buffer.from(JSON.stringify({ id, full_name: operation.repository })),
          trailers: [],
        };
      } catch {
        return undefined;
      }
    },
  });

/** Same exact GET and complete response as the prepared profile, expressly without material. */
export const credentialFreeMetadataProvider: CredentialProviderDefinition =
  Object.freeze<CredentialProviderDefinition>({
    ...githubMetadataProvider,
    ref: credentialFreeProviderRef,
    sourceType: {
      type: credentialFreeMetadataType,
      rotation: "none",
      config: ["origin", "repository_id", "repository", "agent_id", "authority"].map((name) => ({
        name,
        required: true,
      })),
      secrets: [],
    },
    normalizeConfig(config) {
      credentialFreeMetadataGrant(config);
      return immutableCopy(config);
    },
    normalizeGrant(_models, config) {
      return credentialFreeMetadataGrant(config ?? {});
    },
    inject() {
      throw new Error("Credential-free metadata does not perform credential injection.");
    },
  });
