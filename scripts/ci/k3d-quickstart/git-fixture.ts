// Short-lived observer and teardown tokens stay on the runner. The Agent gets its own token from OCE.
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type FixturePermissions = {
  contents: "read" | "write";
  metadata: "read";
};

type InstallationTokenRequest =
  | {
      method: "POST";
      body: { repository_ids: number[]; permissions: FixturePermissions };
    }
  | { method: "DELETE" };

const repositoryId = 1412618387;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const [action, mode] = process.argv.slice(2);
assert.ok(action === "issue" || action === "revoke");
assert.ok(mode === "read" || mode === "cleanup");
const directory = process.env.RUN_DIR;
assert.ok(directory !== undefined, "RUN_DIR is required");
const file = join(directory, `git-${mode}.token`);

async function api(token: string, request: InstallationTokenRequest): Promise<unknown> {
  const { method } = request;
  const path =
    method === "POST" ? "/app/installations/170000975/access_tokens" : "/installation/token";
  const response = await fetch("https://api.github.com" + path, {
    method,
    redirect: "error",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(request.body) } : {}),
  });
  // An expired or already revoked token cannot authenticate to this endpoint.
  if (method === "DELETE" && response.status === 401) {
    return;
  }
  assert.ok(response.ok, `GitHub ${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

if (action === "revoke") {
  const token = readFileSync(file, "utf8");
  assert.ok(token.length > 0);
  await api(token, { method: "DELETE" });
  unlinkSync(file);
} else {
  const encode = (object: Record<string, string | number>) =>
    Buffer.from(JSON.stringify(object)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const msg =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iss: 5258029, iat: now - 60, exp: now + 300 });
  const keyFile = process.env.GITHUB_APP_KEY_FILE;
  assert.ok(keyFile !== undefined, "GITHUB_APP_KEY_FILE is required");
  const signature = sign("RSA-SHA256", Buffer.from(msg), readFileSync(keyFile)).toString(
    "base64url",
  );
  const permissions: FixturePermissions = {
    contents: mode === "read" ? "read" : "write",
    metadata: "read",
  };
  // Reserve a private file first. Never overwrite an outstanding token.
  const fd = openSync(file, "wx", 0o600);
  try {
    const result = record(
      await api(msg + "." + signature, {
        method: "POST",
        body: {
          repository_ids: [repositoryId],
          permissions,
        },
      }),
    );
    assert.ok(typeof result.token === "string" && result.token.length > 0);
    writeFileSync(fd, result.token);
    assert.deepEqual(result.permissions, permissions);
    const repositories: unknown = result.repositories;
    assert.ok(Array.isArray(repositories));
    const entries: unknown[] = repositories;
    assert.deepEqual(
      entries.map((entry) => {
        const { id, full_name } = record(entry);
        return [id, full_name];
      }),
      [[repositoryId, "oce-test/oce-app-test"]],
    );
  } finally {
    closeSync(fd);
  }
}
