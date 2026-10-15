import assert from "node:assert/strict";
import { randomBytes, verify, createHash } from "node:crypto";
import { fixtureAppId, fixtureRepositoryId } from "./metadata.mjs";

export function createTokenAuthority({
  clock,
  publicKey,
  lifetimeMs,
  repositoryId = fixtureRepositoryId,
}) {
  const tokens = new Map();
  const issuesOfTokens = [];
  const authenticationAttempts = [];
  function tokenFrom(authorization) {
    if (authorization?.startsWith("Basic ")) {
      return Buffer.from(authorization.slice(6), "base64").toString().split(":").slice(1).join(":");
    }
    return authorization?.replace(/^(Bearer|token) /, "");
  }
  function authorize(authorization, boundary = "api") {
    const token = tokens.get(tokenFrom(authorization));
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
  function issue(authorization, body) {
    const jwt = tokenFrom(authorization);
    const [header, payload, signature] = jwt.split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
    assert.equal(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(String(claims.iss), fixtureAppId);
    assert.ok(claims.iat <= clock.wallNow() / 1000);
    assert.ok(claims.exp > clock.wallNow() / 1000);
    assert.ok(claims.exp - claims.iat <= 600);
    assert.deepEqual(body.repository_ids.map(String), [String(repositoryId)]);
    const permissions = body.permissions;
    const acceptedPermissions = [
      { metadata: "read" },
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
    const expires = clock.wallNow() + lifetimeMs;
    const index = tokens.size + 1;
    tokens.set(token, {
      index,
      expires,
      revoked: false,
      uses: 0,
      attempts: 0,
      permissions: { ...permissions },
    });
    issuesOfTokens.push({
      index,
      jwtDigest: createHash("sha256").update(jwt).digest("hex"),
      claims,
      permissions: { ...permissions },
      repositoryIds: [...body.repository_ids],
      expires,
    });
    return { token, expires, permissions };
  }
  // A preloaded personal or OAuth token: GitHub never issued it to the service,
  // it does not expire on the fixture clock, and it carries its owner's access.
  function acceptStatic(token) {
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
  function revoke(authorization) {
    const token = tokens.get(tokenFrom(authorization));
    assert.ok(token, "retirement uses an owned provider token");
    token.revoked = true;
  }
  return {
    issue,
    authorize,
    acceptStatic,
    revoke,
    issuesOfTokens,
    authenticationAttempts,
    tokenIndex: (authorization) => tokens.get(tokenFrom(authorization))?.index,
    permissions: (authorization) => tokens.get(tokenFrom(authorization))?.permissions,
    tokenState: () => [...tokens.values()].map((token) => ({ ...token })),
  };
}
