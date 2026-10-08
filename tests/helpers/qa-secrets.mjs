import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const protectedValues = new Set();

export function registerQaSecret(value) {
  protectedValues.add(value);
}

export function redactQaError(error) {
  for (const field of ["message", "stack"]) {
    if (typeof error[field] === "string") {
      for (const secret of protectedValues) {
        error[field] = error[field].replaceAll(secret, "[REDACTED]");
      }
    }
  }
  return error;
}

export async function protectedText(path, label) {
  assert.ok(path, `${label} path is required`);
  // Check and read the same opened file; never follow a substituted symlink.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    assert.ok(
      info.isFile() && (info.mode & 0o077) === 0,
      `${label} must be a private regular file`,
    );
    const value = (await file.readFile("utf8")).trim();
    assert.ok(value.length > 0, `${label} must not be empty`);
    registerQaSecret(value);
    return value;
  } finally {
    await file.close();
  }
}

export async function grantQaSecret(f, agent, secretId, name) {
  const base = `/namespaces/${agent.namespaceId}`;
  const role = await f.api("POST", `${base}/iam/roles`, {
    name,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await f.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secretId,
  });
}
