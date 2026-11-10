#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  loadGitHubAppObserverInput,
  mintGitHubAppObserverToken,
} from "../../tests/helpers/github-app-observer.mjs";

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function parseCredentialRequest(input) {
  return Object.fromEntries(
    input
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        assert.ok(separator > 0, "invalid Git credential request");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function normalizePath(path) {
  return String(path ?? "")
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function assertCredentialRequest(request, repository) {
  assert.equal(request.protocol, "https", "observer credential helper requires HTTPS");
  assert.equal(
    String(request.host ?? "").toLowerCase(),
    "github.com",
    "observer credential helper requires github.com",
  );
  assert.equal(
    normalizePath(request.path),
    repository.toLowerCase(),
    "observer credential helper request path must match the selected repository",
  );
}

function testOnlyApiOrigin() {
  const origin = process.env.OCC_TEST_QA_GITHUB_API_ORIGIN;
  if (!origin) {
    return undefined;
  }
  assert.equal(
    process.env.NODE_ENV,
    "test",
    "OCC_TEST_QA_GITHUB_API_ORIGIN is allowed only in tests",
  );
  const url = new URL(origin);
  assert.equal(url.protocol, "http:", "test GitHub API origin must use http");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "test GitHub API origin must be loopback",
  );
  return origin;
}

const [, , inputDirectory, repository, operation] = process.argv;
if (!operation || !inputDirectory || !repository) {
  throw new Error(
    "usage: github-app-observer-credential-helper <input-directory> <repository> <get|store|erase>",
  );
}
assert.match(repository, repositoryPattern, "observer repository must be owner/name");

if (operation === "store" || operation === "erase") {
  await readStdin();
  process.exit(0);
}
assert.equal(operation, "get", "unsupported Git credential helper operation");

const request = parseCredentialRequest(await readStdin());
assertCredentialRequest(request, repository);
const input = await loadGitHubAppObserverInput(inputDirectory, repository);
const { token } = await mintGitHubAppObserverToken(input, {
  githubApiOrigin: testOnlyApiOrigin(),
});
process.stdout.write(`username=x-access-token\npassword=${token}\n`);
