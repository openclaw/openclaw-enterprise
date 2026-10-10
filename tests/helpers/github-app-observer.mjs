import assert from "node:assert/strict";
import { constants, createPrivateKey, sign } from "node:crypto";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { registerQaSecret } from "./qa-secrets.mjs";

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const numericIdPattern = /^[1-9][0-9]{0,15}$/;
const refreshSkewMs = 5 * 60 * 1000;

function assertNumericId(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, numericIdPattern, `${label} must be a GitHub numeric id`);
  assert.ok(Number.isSafeInteger(Number(value)), `${label} must be a safe integer`);
  return value;
}

async function readPrivateFile(path, label) {
  assert.ok(path && isAbsolute(path), `${label} requires an absolute path`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    assert.ok(info.isFile() && info.nlink === 1, `${label} must be a private regular file`);
    assert.equal(info.mode & 0o077, 0, `${label} must be owner-readable only`);
    assert.ok(info.size > 0 && info.size <= 262144, `${label} has invalid size`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

function validateRegistry(raw, repository) {
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new Error("observer repository registry must be valid JSON");
  }
  assert.ok(registry && typeof registry === "object" && !Array.isArray(registry));
  assertNumericId(registry.appId, "observer registry appId");
  assertNumericId(registry.githubInstallationId, "observer registry githubInstallationId");
  assert.ok(Array.isArray(registry.repositories), "observer registry must contain repositories");
  assert.equal(registry.repositories.length, 1, "observer registry must contain one repository");
  const entry = registry.repositories[0];
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
  assertNumericId(entry.repositoryId, "observer registry repositoryId");
  assert.equal(
    String(entry.repository).toLowerCase(),
    repository.toLowerCase(),
    "observer registry must match the selected repository",
  );
  return {
    appId: registry.appId,
    installationId: registry.githubInstallationId,
    repositoryId: entry.repositoryId,
    repository: String(entry.repository).toLowerCase(),
  };
}

export async function loadGitHubAppObserverInput(inputDirectory, repository) {
  assert.ok(
    inputDirectory && isAbsolute(inputDirectory),
    "observer App input directory is required",
  );
  assert.match(repository, repositoryPattern, "observer repository must be owner/name");
  const [registryRaw, privateKeyRaw] = await Promise.all([
    readPrivateFile(join(inputDirectory, "registry.json"), "observer repository registry"),
    readPrivateFile(join(inputDirectory, "private-key.pem"), "observer GitHub App key"),
  ]);
  const registry = validateRegistry(registryRaw, repository);
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyRaw);
  } finally {
    registerQaSecret(privateKeyRaw);
  }
  assert.equal(privateKey.type, "private", "observer GitHub App key must be private");
  assert.equal(privateKey.asymmetricKeyType, "rsa", "observer GitHub App key must be RSA");
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  assert.ok(bits >= 2048 && bits <= 8192, "observer GitHub App key must have supported size");
  return { ...registry, privateKey };
}

function createJwt(input, now) {
  const seconds = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 300, iss: input.appId }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), {
    key: input.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64url")}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub observer received invalid JSON");
  }
}

function validatePermissions(permissions) {
  assert.ok(permissions && typeof permissions === "object" && !Array.isArray(permissions));
  const allowed = new Set(["contents", "pull_requests", "metadata"]);
  assert.equal(permissions.contents, "write", "observer token must have contents write");
  assert.equal(permissions.pull_requests, "write", "observer token must have pull requests write");
  if (Object.hasOwn(permissions, "metadata")) {
    assert.equal(permissions.metadata, "read", "observer token metadata permission must be read");
  }
  for (const [name, value] of Object.entries(permissions)) {
    assert.ok(allowed.has(name), `observer token has unexpected ${name} permission`);
    assert.ok(value === "read" || value === "write", `observer token has invalid ${name} grant`);
  }
}

function validateRepositoryScope(data, input) {
  assert.ok(Array.isArray(data.repositories), "observer token response must include repositories");
  assert.equal(data.repositories.length, 1, "observer token must be scoped to one repository");
  const [repository] = data.repositories;
  assert.equal(String(repository.id), input.repositoryId, "observer token repository id mismatch");
  assert.equal(
    typeof repository.full_name,
    "string",
    "observer token response must include repository full_name",
  );
  assert.equal(
    repository.full_name.toLowerCase(),
    input.repository,
    "observer token repository name mismatch",
  );
}

export async function mintGitHubAppObserverToken(input, options = {}) {
  const now = options.now?.() ?? Date.now();
  const origin = options.githubApiOrigin ?? "https://api.github.com";
  const response = await fetch(
    `${origin}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createJwt(input, now)}`,
        "content-type": "application/json",
        "user-agent": "openclaw-enterprise-qa-observer",
        "x-github-api-version": "2026-03-10",
      },
      body: JSON.stringify({
        repository_ids: [Number(input.repositoryId)],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  const data = await readJsonResponse(response);
  assert.equal(response.status, 201, `GitHub observer token mint returned ${response.status}`);
  assert.equal(typeof data?.token, "string", "GitHub observer token response is missing token");
  const expiresAt = Date.parse(data.expires_at);
  assert.ok(Number.isFinite(expiresAt), "GitHub observer token response is missing expiry");
  assert.ok(expiresAt > now + 60_000, "GitHub observer token expires too soon");
  validatePermissions(data.permissions);
  validateRepositoryScope(data, input);
  registerQaSecret(data.token);
  return { token: data.token, expiresAt };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function createGitHubAppRepositoryObserver({
  inputDirectory,
  repository,
  run,
  githubApiOrigin,
  now = () => Date.now(),
}) {
  const input = await loadGitHubAppObserverInput(inputDirectory, repository);
  const prefix = `repos/${repository}`;
  let current;
  let refreshing;
  const currentToken = async () => {
    if (current && current.expiresAt > now() + refreshSkewMs) {
      return current.token;
    }
    refreshing ??= mintGitHubAppObserverToken(input, { githubApiOrigin, now }).finally(() => {
      refreshing = undefined;
    });
    current = await refreshing;
    return current.token;
  };
  const observe = async (method, suffix = "", body, expected = 200) => {
    assert.ok(!suffix.includes("..") && !suffix.startsWith("/"));
    const token = await currentToken();
    const response = await fetch(
      `${githubApiOrigin ?? "https://api.github.com"}/${prefix}${suffix ? `/${suffix}` : ""}`,
      {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "openclaw-enterprise-qa-observer",
          "x-github-api-version": "2026-03-10",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    assert.ok(
      [].concat(expected).includes(response.status),
      `GitHub ${method} returned ${response.status}`,
    );
    return { status: response.status, data: await readJsonResponse(response) };
  };
  observe.deleteBranch = async (branch, sha) => {
    assert.match(sha, /^[a-f0-9]{40}$/);
    await run("git", ["check-ref-format", `refs/heads/${branch}`]);
    const helper = fileURLToPath(
      new URL("../../scripts/ci/github-app-observer-credential-helper.mjs", import.meta.url),
    );
    const credentialHelper = `!${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(inputDirectory)} ${shellQuote(repository)}`;
    await run(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${credentialHelper}`,
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${branch}:${sha}`,
        `https://github.com/${repository}.git`,
        `:refs/heads/${branch}`,
      ],
      { timeout: 60000, env: { GIT_TERMINAL_PROMPT: "0" }, privateFailureOutput: true },
    );
  };
  return observe;
}
