import assert from "node:assert/strict";
import { randomBytes, verify, createHash, type KeyObject } from "node:crypto";
import { fixtureAppId, fixtureRepositoryId } from "./metadata.ts";

export type WallClock = { wallNow(): number };
export type Permissions = Readonly<Record<string, string>>;
type RepositoryId = string | number;

type TokenAuthorityOptions = {
  clock: WallClock;
  publicKey: KeyObject;
  lifetimeMs: number | ((index: number) => number);
  repositoryId?: string;
  expectedRepositoryIds?: readonly RepositoryId[];
  additionalPermissions?: readonly Permissions[];
  installationAccess?: boolean;
};

type Token = {
  index: number;
  expires: number;
  revoked: boolean;
  uses: number;
  attempts: number;
  permissions: Permissions;
  repositoryIds?: string[] | "installation";
  static?: true;
};

type Issuance = {
  index: number;
  jwtDigest: string;
  claims: Record<string, unknown>;
  permissions: Permissions;
  repositoryIds: RepositoryId[] | "installation";
  expires: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRepositoryId(value: unknown): value is RepositoryId {
  return typeof value === "string" || typeof value === "number";
}

function isPermissions(value: unknown): value is Permissions {
  return (
    isObject(value) && Object.values(value).every((permission) => typeof permission === "string")
  );
}

function decodeJwtObject(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString());
  assert.ok(isObject(value), "expected an App JWT object");
  return value;
}

export function createTokenAuthority({
  clock,
  publicKey,
  /** Milliseconds, or a function of the 1-based token index. */
  lifetimeMs,
  repositoryId = fixtureRepositoryId,
  expectedRepositoryIds = [repositoryId],
  additionalPermissions = [],
  installationAccess = false,
}: TokenAuthorityOptions) {
  const tokens = new Map<string, Token>();
  const issuesOfTokens: Issuance[] = [];
  const authenticationAttempts: { tokenIndex: number | undefined; boundary: string }[] = [];

  function tokenFrom(authorization: string | undefined) {
    if (authorization?.startsWith("Basic ")) {
      return Buffer.from(authorization.slice(6), "base64").toString().split(":").slice(1).join(":");
    }
    return authorization?.replace(/^(Bearer|token) /, "");
  }
  function findToken(authorization: string | undefined) {
    const key = tokenFrom(authorization);
    return key === undefined ? undefined : tokens.get(key);
  }

  function authorize(authorization: string | undefined, boundary = "api") {
    const token = findToken(authorization);
    authenticationAttempts.push({ tokenIndex: token?.index, boundary });
    if (token) {
      token.attempts++;
    }
    if (!token || token.revoked || token.expires <= clock.wallNow()) {
      return false;
    }
    token.uses++;
    return true;
  }
  function issue(authorization: string | undefined, body: unknown) {
    const jwt = tokenFrom(authorization);
    const [header, payload, signature, extra] = jwt?.split(".") ?? [];
    assert.ok(
      jwt !== undefined && header && payload && signature && extra === undefined,
      "expected an App JWT",
    );
    assert.ok(decodeJwtObject(header).alg === "RS256", "expected RS256");
    assert.ok(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      "invalid App JWT signature",
    );
    const claims = decodeJwtObject(payload);
    assert.ok(
      claims.iss === fixtureAppId || claims.iss === Number(fixtureAppId),
      "unexpected App issuer",
    );
    const { iat, exp } = claims;
    assert.ok(typeof iat === "number" && typeof exp === "number", "expected numeric JWT times");
    assert.ok(iat <= clock.wallNow() / 1000);
    assert.ok(exp > clock.wallNow() / 1000);
    assert.ok(exp - iat <= 600);

    assert.ok(isObject(body), "invalid issuance body");
    const installation = installationAccess && Object.keys(body).length === 0;
    let repositoryIds: RepositoryId[] | "installation" = "installation";
    let permissions: Permissions = { metadata: "read", contents: "write" };
    if (!installation) {
      const { repository_ids: ids, permissions: selectedPermissions } = body;
      assert.ok(Array.isArray(ids) && ids.every(isRepositoryId), "expected repository IDs");
      assert.deepEqual(ids.map(String), expectedRepositoryIds.map(String));
      assert.ok(isPermissions(selectedPermissions), "expected permissions");
      repositoryIds = ids;
      permissions = selectedPermissions;
    }
    const acceptedPermissions: readonly Permissions[] = [
      ...additionalPermissions,
      { metadata: "read" },
      { metadata: "read", contents: "write" },
      {
        metadata: "read",
        contents: "read",
        issues: "read",
        pull_requests: "read",
        checks: "read",
        statuses: "read",
      },
      {
        metadata: "read",
        contents: "write",
        issues: "read",
        pull_requests: "write",
        checks: "read",
        statuses: "read",
      },
      {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        statuses: "read",
      },
    ];
    assert.ok(
      acceptedPermissions.some(
        (allowed) =>
          Object.keys(permissions).length === Object.keys(allowed).length &&
          Object.entries(allowed).every(([name, value]) => permissions[name] === value),
      ),
      "issuance requires an exact supported permission map",
    );
    const token = `fixture_access_${randomBytes(24).toString("hex")}`;
    const index = tokens.size + 1;
    const expires =
      clock.wallNow() + (typeof lifetimeMs === "function" ? lifetimeMs(index) : lifetimeMs);
    tokens.set(token, {
      index,
      expires,
      revoked: false,
      uses: 0,
      attempts: 0,
      permissions: { ...permissions },
      repositoryIds: repositoryIds === "installation" ? repositoryIds : repositoryIds.map(String),
    });
    issuesOfTokens.push({
      index,
      jwtDigest: createHash("sha256").update(jwt).digest("hex"),
      claims,
      permissions: { ...permissions },
      repositoryIds: repositoryIds === "installation" ? repositoryIds : [...repositoryIds],
      expires,
    });
    return { token, expires, permissions };
  }
  // A preloaded personal or OAuth token: GitHub never issued it to the service,
  // it does not expire on the fixture clock, and it carries its owner's access.
  function acceptStatic(token: string) {
    const index = tokens.size + 1;
    tokens.set(token, {
      index,
      expires: Infinity,
      revoked: false,
      uses: 0,
      attempts: 0,
      static: true,
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        statuses: "read",
      },
    });
    return index;
  }
  function revoke(authorization: string | undefined) {
    const token = findToken(authorization);
    assert.ok(token, "retirement uses an owned provider token");
    token.revoked = true;
  }
  function permitsRepository(authorization: string | undefined, repositoryId: RepositoryId) {
    const token = findToken(authorization);
    return (
      token?.static === true ||
      token?.repositoryIds === "installation" ||
      token?.repositoryIds?.includes(String(repositoryId)) === true
    );
  }
  return {
    permitsRepository,
    issue,
    authorize,
    authorizeRepository(authorization: string | undefined, repositoryId: RepositoryId) {
      if (!authorize(authorization, `repository:${repositoryId}`)) {
        return false;
      }
      return permitsRepository(authorization, repositoryId);
    },
    acceptStatic,
    revoke,
    issuesOfTokens,
    authenticationAttempts,
    tokenIndex: (authorization: string | undefined) => findToken(authorization)?.index,
    permissions: (authorization: string | undefined) => findToken(authorization)?.permissions,
    tokenState: () => [...tokens.values()].map((token) => ({ ...token })),
  };
}
