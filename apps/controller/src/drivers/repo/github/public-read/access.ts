import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";

export type PublicGithubReadPolicy =
  { mode: "all" } | { mode: "repositories"; repositories: readonly string[] };

export interface PublicGithubReadAuthorization {
  installationId: string;
  namespaceId: string;
  agentId: string;
  revisionId: string;
  tokenSha256: string;
  policy: PublicGithubReadPolicy;
  validUntil: string;
}
export type PublicGithubReadAuthorizationRegistry = Record<string, PublicGithubReadAuthorization>;
export interface PublicGithubReadAuthorizationSnapshot {
  authorizations: PublicGithubReadAuthorizationRegistry;
  digest: string;
}
export interface ReaderOptions {
  policy?:
    PublicGithubReadPolicy | (() => PublicGithubReadPolicy | Promise<PublicGithubReadPolicy>);
  loadAuthorizations?: () =>
    | PublicGithubReadAuthorizationRegistry
    | PublicGithubReadAuthorizationSnapshot
    | Promise<PublicGithubReadAuthorizationRegistry | PublicGithubReadAuthorizationSnapshot>;
  tls?: { cert: string | Buffer; key: string | Buffer };
}

export function canonicalPublicGithubRepository(value: string): string | undefined {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/(?!\.{1,2}$)[a-z\d._-]{1,100}$/i.test(value)) {
    return;
  }
  return value.toLowerCase();
}

export function publicGithubReadPolicy(value: unknown): PublicGithubReadPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A public GitHub read policy is required.");
  }
  const policy = value as Record<string, unknown>;
  if (policy.mode === "all" && Object.keys(policy).length === 1) {
    return { mode: "all" };
  }
  if (
    policy.mode !== "repositories" ||
    !Array.isArray(policy.repositories) ||
    policy.repositories.length > 256 ||
    Object.keys(policy).some((key) => key !== "mode" && key !== "repositories")
  ) {
    throw new Error("Invalid public GitHub read policy.");
  }
  const repositories = policy.repositories.map((repository: unknown) => {
    const canonical = typeof repository === "string" && canonicalPublicGithubRepository(repository);
    if (!canonical) {
      throw new Error("Invalid public GitHub repository.");
    }
    return canonical;
  });
  return { mode: "repositories", repositories: [...new Set(repositories)].sort() };
}

export function publicGithubReadAllowed(
  policy: PublicGithubReadPolicy,
  repository: string,
): boolean {
  const canonical = canonicalPublicGithubRepository(repository);
  return (
    canonical !== undefined && (policy.mode === "all" || policy.repositories.includes(canonical))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function authorizationSnapshot(
  options: ReaderOptions,
): Promise<PublicGithubReadAuthorizationSnapshot> {
  if (!options.loadAuthorizations) {
    throw new Error("Public GitHub read authorization is unavailable.");
  }
  const loaded: unknown = await options.loadAuthorizations();
  const snapshot =
    record(loaded) && Object.hasOwn(loaded, "authorizations") && Object.hasOwn(loaded, "digest");
  const registry = snapshot ? loaded.authorizations : loaded;
  if (
    !record(registry) ||
    (snapshot && (typeof loaded.digest !== "string" || !/^[a-f\d]{64}$/.test(loaded.digest)))
  ) {
    throw new Error("Invalid public GitHub read authorization registry.");
  }
  const authorizations: PublicGithubReadAuthorizationRegistry = Object.create(null);
  for (const [revisionId, value] of Object.entries(registry)) {
    if (
      !record(value) ||
      !/^[a-z\d_-]{1,128}$/i.test(revisionId) ||
      value.revisionId !== revisionId ||
      ![value.installationId, value.namespaceId, value.agentId].every(
        (identity) => typeof identity === "string" && /^[a-z\d_-]{1,128}$/i.test(identity),
      ) ||
      typeof value.tokenSha256 !== "string" ||
      !/^[a-f\d]{64}$/.test(value.tokenSha256) ||
      typeof value.validUntil !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.validUntil) ||
      !Number.isFinite(Date.parse(value.validUntil))
    ) {
      throw new Error("Invalid public GitHub read authorization entry.");
    }
    authorizations[revisionId] = {
      installationId: value.installationId as string,
      namespaceId: value.namespaceId as string,
      agentId: value.agentId as string,
      revisionId,
      tokenSha256: value.tokenSha256,
      policy: publicGithubReadPolicy(value.policy),
      validUntil: value.validUntil,
    };
  }
  return {
    authorizations,
    digest: snapshot
      ? (loaded.digest as string)
      : createHash("sha256").update(JSON.stringify(loaded)).digest("hex"),
  };
}

/** A revision observation is stable while unrelated reader leases change. */
export function publicGithubReadAuthorizationDigest(
  authorization: PublicGithubReadAuthorization | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify(authorization ?? null))
    .digest("hex");
}

// Every caller is checked before joining shared API work. Neither addresses nor
// request identity headers grant authority; only the current mounted verifier does.
export async function authorizePublicGithubRead(
  options: ReaderOptions,
  header: string | undefined,
  repository: string,
): Promise<200 | 401 | 403 | 503> {
  const token = header?.match(/^Bearer ([a-z\d_-]{1,128})\.([A-Za-z\d_-]{43})$/i);
  if (!token || Buffer.from(token[2]!, "base64url").toString("base64url") !== token[2]) {
    return 401;
  }
  try {
    if (!options.policy) {
      return 503;
    }
    const snapshot = await authorizationSnapshot(options);
    const authorization = Object.hasOwn(snapshot.authorizations, token[1]!)
      ? snapshot.authorizations[token[1]!]
      : undefined;
    const digest = createHash("sha256").update(header!.slice(7)).digest();
    if (
      !authorization ||
      !timingSafeEqual(digest, Buffer.from(authorization.tokenSha256, "hex")) ||
      Date.parse(authorization.validUntil) <= Date.now()
    ) {
      return 401;
    }
    const ceiling = publicGithubReadPolicy(
      typeof options.policy === "function" ? await options.policy() : options.policy,
    );
    return publicGithubReadAllowed(ceiling, repository) &&
      publicGithubReadAllowed(authorization.policy, repository)
      ? 200
      : 403;
  } catch {
    return 503;
  }
}

// The descriptor is opened afresh, including after an atomic volume replacement.
async function readPublicGithubReadBytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > limit) {
      throw new Error("Public GitHub read configuration exceeds its byte limit.");
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function loadPublicGithubReadTls(
  certPath: string,
  keyPath: string,
): Promise<NonNullable<ReaderOptions["tls"]>> {
  const [cert, key] = await Promise.all([
    readPublicGithubReadBytes(certPath, 64 * 1024),
    readPublicGithubReadBytes(keyPath, 64 * 1024),
  ]);
  return { cert, key };
}

export async function loadPublicGithubReadJson(
  path: string,
): Promise<{ value: unknown; digest: string }> {
  const content = await readPublicGithubReadBytes(path, 1024 * 1024);
  return {
    value: JSON.parse(content.toString("utf8")),
    digest: createHash("sha256").update(content).digest("hex"),
  };
}
