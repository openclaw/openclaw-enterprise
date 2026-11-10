// Short-lived observer and teardown tokens stay on the runner. The Agent gets its own token from OCE.
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [action, mode] = process.argv.slice(2);
assert.ok(["issue", "revoke"].includes(action));
assert.ok(["read", "cleanup"].includes(mode));
const file = join(process.env.RUN_DIR, `git-${mode}.token`);
const api = async (path, token, method, body) => {
  const response = await fetch("https://api.github.com" + path, {
    method,
    redirect: "error",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  // An expired or already revoked token cannot authenticate to this endpoint.
  if (method === "DELETE" && response.status === 401) {
    return;
  }
  assert.ok(response.ok, `GitHub ${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const retire = (token) => api("/installation/token", token, "DELETE");
if (action === "revoke") {
  const token = readFileSync(file, "utf8");
  assert.ok(token.length > 0);
  await retire(token);
  unlinkSync(file);
} else {
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const msg =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iss: 5258029, iat: now - 60, exp: now + 300 });
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(msg),
    readFileSync(process.env.GITHUB_APP_KEY_FILE),
  ).toString("base64url");
  const permissions = { contents: mode === "read" ? "read" : "write", metadata: "read" };
  // Reserve a private file first. Never overwrite an outstanding token.
  const fd = openSync(file, "wx", 0o600);
  try {
    const result = await api(
      "/app/installations/170000975/access_tokens",
      msg + "." + signature,
      "POST",
      {
        repository_ids: [1412618387],
        permissions,
      },
    );
    assert.ok(typeof result.token === "string" && result.token.length > 0);
    writeFileSync(fd, result.token);
    assert.deepEqual(result.permissions, permissions);
    assert.deepEqual(
      result.repositories.map(({ id, full_name }) => [id, full_name]),
      [[1412618387, "oce-test/oce-app-test"]],
    );
  } finally {
    closeSync(fd);
  }
}
