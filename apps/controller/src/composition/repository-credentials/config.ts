import { dirname, isAbsolute, join, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import type { Clock } from "../../drivers/repo/credentials/backend-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import { createGitHubStaticTokenOwner } from "../../drivers/repo/github/credentials/static-token.ts";
import { createGitHubDriverFactory } from "../../drivers/repo/github/credentials/factory.ts";
import {
  record,
  string,
  validateServiceConfig,
} from "../../drivers/repo/credentials/configuration.ts";
import { validateGitHubConfiguration } from "../../drivers/repo/github/credentials/config.ts";
import {
  GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
  validateGitHubRepositoryRegistry,
} from "../../drivers/repo/github/credentials/registry.ts";
import type { GitHubRepositoryRegistry } from "../../drivers/repo/github/credentials/registry.ts";
import type {
  GitHubStaticTokenOwner,
  GitHubDriverFactory,
  GitHubTokenConfiguration,
} from "../../drivers/repo/github/credentials/types.ts";
import { createProviderQueue } from "../../drivers/repo/credentials/provider-queue.ts";
import { loadPublicCa } from "./public-ca.ts";
import { readProtectedFile } from "./protected-file.ts";

export class RetiredGitHubAuthorityError extends Error {
  constructor() {
    super(
      "GitHub App signing gateway retired: stop admissions and drain accepted work on its original owner before switching; configure the worker Token Service and prepared Git delivery. Do not transfer keys or replay uncertain work.",
    );
  }
}

type SelectedBackend =
  | {
      readonly kind: "github-prepared-git-registry";
      readonly registry: GitHubRepositoryRegistry;
      readonly socketPath: string;
      readonly gitOrigin?: string;
      readonly apiOrigin?: string;
    }
  | { readonly kind: "github-token"; readonly configuration: GitHubTokenConfiguration };

/** Development-only static token sessions are capped at eight hours. */
const developmentTokenMaximumSeconds = 28800;
// 64 MiB: the development example value; the service default (256 MiB) would be buffered per push.
const developmentTokenPushInputBytes = 67108864;

async function readProtected(path: string, maximum: number, privateFile = true): Promise<Buffer> {
  const result = await readProtectedFile(path, maximum, privateFile);
  if (!result.ok) {
    throw new Error("invalid-configuration");
  }
  return result.bytes;
}

export async function loadConfiguration(
  path: string,
  clock: Clock,
  options: Readonly<{ developmentAuthority?: boolean }> = {},
): Promise<LoadedConfiguration> {
  let raw: Buffer | undefined;
  let token: Buffer | undefined;
  let registryBytes: Buffer | undefined;
  let cert: Buffer | undefined;
  let tlsKey: Buffer | undefined;
  let owner: GitHubStaticTokenOwner | undefined;
  let upstreamCa: Buffer | undefined;
  try {
    raw = await readProtected(path, 262144);
    const input: unknown = JSON.parse(raw.toString("utf8"));
    const root = record(input);
    const backendInput = record(root.backend);
    let selected: SelectedBackend;
    if (backendInput.kind === "github-app" || backendInput.kind === "github-app-registry") {
      throw new RetiredGitHubAuthorityError();
    }
    const config = validateServiceConfig(root);
    if (backendInput.kind === "github-prepared-git-registry") {
      if (
        Object.keys(backendInput).some(
          (key) =>
            ![
              "kind",
              "backendId",
              "registryFile",
              "socketPath",
              "gitOrigin",
              "apiOrigin",
              "gitCaFile",
            ].includes(key),
        )
      ) {
        throw new Error("invalid-configuration");
      }
      registryBytes = await readProtected(
        string(backendInput.registryFile),
        GITHUB_REPOSITORY_REGISTRY_MAX_BYTES,
        false,
      );
      const registry = validateGitHubRepositoryRegistry(
        JSON.parse(registryBytes.toString("utf8")),
        string(backendInput.backendId),
      );
      // Native sessions consume prepared material; installation-wide access uses the protected proxy.
      if (registry.installationAccess !== undefined) {
        throw new Error("installation-access-requires-protected-credential-proxy");
      }
      if (config.sessionPolicy.maximumDurationSeconds > registry.maximumDurationSeconds) {
        throw new Error("invalid-configuration");
      }
      const socketPath =
        backendInput.socketPath === undefined
          ? join(dirname(config.gateway.controlSocket), "prepared-git-use.sock")
          : string(backendInput.socketPath);
      if (
        !isAbsolute(socketPath) ||
        resolve(socketPath) !== socketPath ||
        Buffer.byteLength(socketPath) > 103 ||
        socketPath === config.gateway.controlSocket ||
        socketPath === join(dirname(config.gateway.controlSocket), "receipt.sock")
      ) {
        throw new Error("invalid-configuration");
      }
      // Optional private GitHub origin and its operator-mounted public CA.
      // Neither value is accepted from repository clients or from a Git request.
      const origin =
        backendInput.gitOrigin === undefined ? {} : { gitOrigin: string(backendInput.gitOrigin) };
      if (backendInput.gitCaFile !== undefined) {
        upstreamCa = await loadPublicCa(string(backendInput.gitCaFile));
      }
      selected = {
        kind: "github-prepared-git-registry",
        registry,
        socketPath,
        ...origin,
        ...(backendInput.apiOrigin === undefined
          ? {}
          : { apiOrigin: string(backendInput.apiOrigin) }),
      };
    } else {
      const configuration = validateGitHubConfiguration(backendInput);
      // Second explicit opt-in: the process flag, visible in argv and `docker inspect`.
      if (
        options.developmentAuthority !== true ||
        config.sessionPolicy.maximumDurationSeconds > developmentTokenMaximumSeconds ||
        config.limits.gitPushInputBytes > developmentTokenPushInputBytes
      ) {
        throw new Error("invalid-configuration");
      }
      selected = { kind: "github-token", configuration };
    }
    const gateway = record(root.gateway);
    for (const profile of config.sessionPolicy.allowedProfiles) {
      if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
        throw new Error("invalid-configuration");
      }
    }
    if (selected.kind === "github-token") {
      // One trailing LF or CRLF (as `gh auth token > file` writes) is not part of the token.
      token = await readProtected(
        selected.configuration.tokenFile,
        config.limits.accessTokenBytes + 2,
      );
      const newline = token.at(-1) !== 0x0a ? 0 : token.at(-2) === 0x0d ? 2 : 1;
      const length = token.length - newline;
      if (length < 1 || length > config.limits.accessTokenBytes) {
        throw new Error("invalid-configuration");
      }
      owner = createGitHubStaticTokenOwner({ token: token.subarray(0, length) });
    }
    cert = await readProtected(string(gateway.tlsCertFile), 131072, false);
    tlsKey = await readProtected(string(gateway.tlsKeyFile), 65536);
    createSecureContext({ cert, key: tlsKey, minVersion: "TLSv1.2" });
    const factoryOptions = {
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
    };
    let factory: LoadedConfiguration["factory"] &
      Pick<GitHubDriverFactory, "trustedUpstreamOrigins">;
    switch (selected.kind) {
      case "github-prepared-git-registry": {
        const { createPreparedGitHubRegistryFactory } =
          await import("../../drivers/repo/github/credentials/warm-registry-factory.ts");
        factory = createPreparedGitHubRegistryFactory({
          ...factoryOptions,
          registry: selected.registry,
          socketPath: selected.socketPath,
          ...(selected.gitOrigin === undefined ? {} : { gitOrigin: selected.gitOrigin }),
          ...(selected.apiOrigin === undefined ? {} : { apiOrigin: selected.apiOrigin }),
        });
        break;
      }
      case "github-token":
        factory = createGitHubDriverFactory({
          authority: owner!,
          ...factoryOptions,
          configuration: selected.configuration,
        });
        break;
    }
    const providerQueue = createProviderQueue(config.limits.providerQueue);
    const ownedCert = cert;
    const ownedTlsKey = tlsKey;
    const ownedAuthority = owner;
    return Object.freeze({
      config,
      tls: Object.freeze({ cert: ownedCert, key: ownedTlsKey }),
      factory,
      providerQueue,
      trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
      ...(upstreamCa === undefined ? {} : { upstreamCa }),
      ...(ownedAuthority?.kind === "github-token"
        ? { authority: "github-token-development" as const, tokenClass: ownedAuthority.tokenClass }
        : { authority: "github-prepared-git-registry" as const }),
      close() {
        ownedAuthority?.close();
        ownedCert.fill(0);
        ownedTlsKey.fill(0);
      },
    });
  } catch (error) {
    owner?.close();
    cert?.fill(0);
    tlsKey?.fill(0);
    if (error instanceof RetiredGitHubAuthorityError) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Input failures must not expose credentials or private file paths.
    throw new Error("invalid-configuration");
  } finally {
    raw?.fill(0);
    registryBytes?.fill(0);
    token?.fill(0);
  }
}
