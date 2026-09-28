import { createPrivateKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { Clock } from "../../drivers/repo/credentials/backend-contracts.ts";
import type { LoadedConfiguration } from "./contracts.ts";
import {
  createGitHubDriverFactory,
  createGitHubKeyOwner,
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
  GitHubConfiguration,
  GitHubDriverFactory,
} from "../../drivers/repo/github/credentials/types.ts";
import { createGitHubRegistryDriverFactory } from "../../drivers/repo/github/credentials/registry-factory.ts";
import { readProtectedFile } from "./protected-file.ts";

type SelectedBackend = {
  readonly key: {
    readonly appId: string;
    readonly privateKeyFile: string;
  };
} & (
  | { readonly kind: "github-app-registry"; readonly registry: GitHubRepositoryRegistry }
  | { readonly kind: "github-app"; readonly configuration: GitHubConfiguration }
);

async function readProtected(path: string, maximum: number, privateFile = true): Promise<Buffer> {
  const result = await readProtectedFile(path, maximum, privateFile);
  if (!result.ok) {
    throw new Error("invalid-configuration");
  }
  return result.bytes;
}

export async function loadConfiguration(path: string, clock: Clock): Promise<LoadedConfiguration> {
  let raw: Buffer | undefined;
  let pem: Buffer | undefined;
  let registryBytes: Buffer | undefined;
  let cert: Buffer | undefined;
  let tlsKey: Buffer | undefined;
  let owner: ReturnType<typeof createGitHubKeyOwner> | undefined;
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
      selected = {
        kind: "github-app",
        configuration,
        key: {
          privateKeyFile: configuration.privateKeyFile,
          appId: configuration.appId,
        },
      };
    }
    const gateway = record(root.gateway);
    for (const profile of config.sessionPolicy.allowedProfiles) {
      if (profile !== "git-read" && profile !== "git-write" && profile !== "git-full") {
        throw new Error("invalid-configuration");
      }
    }
    pem = await readProtected(selected.key.privateKeyFile, config.limits.privateKeyBytes);
    owner = createGitHubKeyOwner({
      privateKey: createPrivateKey(pem),
      appId: selected.key.appId,
      clock,
    });
    cert = await readProtected(string(gateway.tlsCertFile), 131072, false);
    tlsKey = await readProtected(string(gateway.tlsKeyFile), 65536);
    createSecureContext({ cert, key: tlsKey, minVersion: "TLSv1.2" });
    const factoryOptions = {
      key: owner,
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
        factory = createGitHubDriverFactory({
          ...factoryOptions,
          configuration: selected.configuration,
        });
        break;
    }
    const ownedCert = cert;
    const ownedTlsKey = tlsKey;
    const ownedKey = owner;
    return Object.freeze({
      config,
      tls: Object.freeze({ cert: ownedCert, key: ownedTlsKey }),
      factory,
      trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
      close() {
        ownedKey.close();
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
  }
}
