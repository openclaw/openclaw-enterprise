import { createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { Clock } from "../../drivers/repo/credentials/backend-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
  createGitHubStaticTokenOwner,
} from "../../drivers/repo/github/credentials/index.ts";
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
  GitHubAppConfiguration,
  GitHubAuthority,
  GitHubDriverFactory,
  GitHubTokenConfiguration,
} from "../../drivers/repo/github/credentials/types.ts";
import { createGitHubRegistryDriverFactory } from "../../drivers/repo/github/credentials/registry-factory.ts";
import { createProviderQueue } from "../../drivers/repo/credentials/provider-queue.ts";
import { createGitHubRepositoryDescriptions } from "../../drivers/repo/github/credentials/descriptions.ts";
import { readProtectedFile } from "./protected-file.ts";

interface AppKey {
  readonly appId: string;
  readonly privateKeyFile: string;
}
type SelectedBackend =
  | {
      readonly kind: "github-app-registry";
      readonly registry: GitHubRepositoryRegistry;
      readonly key: AppKey;
    }
  | { readonly kind: "github-app"; readonly configuration: GitHubAppConfiguration; key: AppKey }
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
  let pem: Buffer | undefined;
  let token: Buffer | undefined;
  let registryBytes: Buffer | undefined;
  let cert: Buffer | undefined;
  let tlsKey: Buffer | undefined;
  let owner: GitHubAuthority | undefined;
  try {
    raw = await readProtected(path, 262144);
    const input: unknown = JSON.parse(raw.toString("utf8"));
    const root = record(input);
    const config = validateServiceConfig(root);
    const backendInput = record(root.backend);
    let selected: SelectedBackend;
    if (backendInput.kind === "github-app-registry") {
      if (
        Object.keys(backendInput).some(
          (key) => !["kind", "backendId", "registryFile", "privateKeyFile"].includes(key),
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
      if (config.sessionPolicy.maximumDurationSeconds > registry.maximumDurationSeconds) {
        throw new Error("invalid-configuration");
      }
      selected = {
        kind: "github-app-registry",
        registry,
        key: {
          privateKeyFile: string(backendInput.privateKeyFile),
          appId: registry.appId,
        },
      };
    } else {
      const configuration = validateGitHubConfiguration(backendInput);
      if (configuration.kind === "github-token") {
        // Second explicit opt-in: the process flag, visible in argv and `docker inspect`.
        if (
          options.developmentAuthority !== true ||
          config.sessionPolicy.maximumDurationSeconds > developmentTokenMaximumSeconds ||
          // Token pushes are buffered in memory for the receive-pack inspector.
          config.limits.gitPushInputBytes > developmentTokenPushInputBytes
        ) {
          throw new Error("invalid-configuration");
        }
        selected = { kind: "github-token", configuration };
      } else {
        selected = {
          kind: "github-app",
          configuration,
          key: {
            privateKeyFile: configuration.privateKeyFile,
            appId: configuration.appId,
          },
        };
      }
    }
    const gateway = record(root.gateway);
    for (const profile of config.sessionPolicy.allowedProfiles) {
      if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
        throw new Error("invalid-configuration");
      }
    }
    let keyOwner: ReturnType<typeof createGitHubKeyOwner> | undefined;
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
    } else {
      pem = await readProtected(selected.key.privateKeyFile, config.limits.privateKeyBytes);
      keyOwner = createGitHubKeyOwner({
        privateKey: createPrivateKey(pem),
        appId: selected.key.appId,
        clock,
      });
      owner = keyOwner;
    }
    cert = await readProtected(string(gateway.tlsCertFile), 131072, false);
    tlsKey = await readProtected(string(gateway.tlsKeyFile), 65536);
    createSecureContext({ cert, key: tlsKey, minVersion: "TLSv1.2" });
    const factoryOptions = {
      authority: owner,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
    };
    let factory: GitHubDriverFactory;
    switch (selected.kind) {
      case "github-app-registry":
        factory = createGitHubRegistryDriverFactory({
          ...factoryOptions,
          registry: selected.registry,
          privateKeyFile: selected.key.privateKeyFile,
        });
        break;
      case "github-app":
      case "github-token":
        factory = createGitHubDriverFactory({
          ...factoryOptions,
          configuration: selected.configuration,
        });
        break;
    }
    const providerQueue = createProviderQueue(config.limits.providerQueue);
    const repositoryDescriptions =
      selected.kind === "github-app-registry" && keyOwner
        ? createGitHubRepositoryDescriptions({
            registry: selected.registry,
            privateKeyFile: selected.key.privateKeyFile,
            key: keyOwner,
            config,
            clock,
            providerQueue,
          })
        : undefined;
    const ownedCert = cert;
    const ownedTlsKey = tlsKey;
    const ownedAuthority = owner;
    return Object.freeze({
      config,
      tls: Object.freeze({ cert: ownedCert, key: ownedTlsKey }),
      factory,
      providerQueue,
      ...(repositoryDescriptions === undefined ? {} : { repositoryDescriptions }),
      trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
      ...(ownedAuthority.kind === "github-token"
        ? { authority: "github-token-development" as const, tokenClass: ownedAuthority.tokenClass }
        : {
            authority:
              selected.kind === "github-app-registry"
                ? ("github-app-registry" as const)
                : ("github-app" as const),
          }),
      close() {
        ownedAuthority.close();
        ownedCert.fill(0);
        ownedTlsKey.fill(0);
      },
    });
  } catch {
    owner?.close();
    cert?.fill(0);
    tlsKey?.fill(0);
    throw new Error("invalid-configuration");
  } finally {
    raw?.fill(0);
    registryBytes?.fill(0);
    pem?.fill(0);
    token?.fill(0);
  }
}
