import type { KeyObject } from "node:crypto";
import { isIP } from "node:net";

import { startSkipperPrivateGitOrigin } from "../fixtures/skipper-private-git-origin.mjs";

interface OriginOptions {
  host: string;
  port?: number;
  repository: string;
  repositoryRef: string;
  repositoryId: string;
  permissions: Readonly<Record<string, "read" | "write">>;
  appPublicKey: KeyObject;
  tls: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer };
}

/** The installed worker owns the App private key. This upstream fixture only
 * verifies its requests and records nonsecret issuance and Git observations. */
export async function startInstalledGrantGitHubOrigin(options: OriginOptions) {
  const {
    host,
    port = 0,
    repository,
    repositoryRef,
    repositoryId,
    permissions,
    appPublicKey,
    tls,
  } = options;
  const privateHost =
    isIP(host) === 4 && /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/u.test(host);
  if (
    !privateHost ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    appPublicKey.type !== "public" ||
    appPublicKey.asymmetricKeyType !== "rsa" ||
    (appPublicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    !/^[a-zA-Z0-9_-]+$/u.test(repositoryRef) ||
    !/^[1-9][0-9]*$/u.test(repositoryId) ||
    !Number.isSafeInteger(Number(repositoryId)) ||
    permissions.metadata !== "read" ||
    Object.entries(permissions).some(
      ([name, level]) => !/^[a-z_]+$/u.test(name) || !["read", "write"].includes(level),
    )
  ) {
    throw new Error("Invalid GitHub fixture address, App key, or repository scope.");
  }
  const origin = await startSkipperPrivateGitOrigin({
    host,
    port,
    advertisedHost: "github.com",
    repository,
    repositoryRef,
    repositoryId,
    tls,
    installedGrant: {
      apiHost: "api.github.com",
      gitHost: "github.com",
      permissions: { ...permissions },
      signingPublicKey: appPublicKey,
    },
  });
  return {
    origin: origin.origin,
    port: Number(new URL(origin.origin).port || "443"),
    appId: origin.appId,
    installationId: origin.installationId,
    repository,
    repositoryRef,
    repositoryId,
    initialSha: origin.initialSha,
    snapshot: origin.snapshot,
    gitRequests: origin.gitRequests,
    publishFreshCommit: origin.publishFreshCommit,
    readRefs: origin.readRefs,
    close: origin.close,
  };
}
