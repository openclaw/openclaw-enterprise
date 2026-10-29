import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { classifyOpenShellGitHubTransport } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts";
import type { OpenShellOnlineHttpRequest } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";

// This tests classification only. It does not manufacture verified token scope, an
// authorization decision, or installed supervisor evidence.
function request(
  host: string,
  path: string,
  method: OpenShellOnlineHttpRequest["target"]["method"] = "GET",
  body = Buffer.alloc(0),
  headers: OpenShellOnlineHttpRequest["headers"] = [],
  query = "",
): OpenShellOnlineHttpRequest {
  return {
    sandboxId: "sandbox",
    bindingId: "binding",
    requestId: "request",
    workspace: "workspace",
    deadlineAt: new Date(Date.now() + 1000).toISOString(),
    target: { reportedScheme: "https", host, port: 443, method, path, query },
    body,
    headers,
  };
}

const classify = classifyOpenShellGitHubTransport;

test("provider-scoped transport classifies ordinary Git without imposing branch policy", () => {
  for (const repo of ["owner/selected", "owner/other"]) {
    // Both paths reach provider evaluation; this parser is not proof that B is denied.
    for (const service of ["upload", "receive"]) {
      assert.deepEqual(
        classify(
          request(
            "github.com",
            `/${repo}.git/info/refs`,
            "GET",
            undefined,
            [],
            `service=git-${service}-pack`,
          ),
        ),
        { selected: { operation: `advertise-${service}-pack` } },
      );
    }
    const command = `${"1".repeat(40)} ${"2".repeat(40)} refs/heads/main\0report-status\n`;
    const push = Buffer.from(
      (Buffer.byteLength(command) + 4).toString(16).padStart(4, "0") + command + "0000",
    );
    assert.deepEqual(
      classify(
        request("github.com", `/${repo}.git/git-receive-pack`, "POST", push, [
          ["content-type", "application/x-git-receive-pack-request"],
        ]),
      ),
      { selected: { operation: "receive-pack" } },
    );
    assert.deepEqual(
      classify(
        request(
          "github.com",
          `/${repo}.git/git-upload-pack`,
          "POST",
          gzipSync("opaque fetch body"),
          [
            ["content-type", "application/x-git-upload-pack-request"],
            ["content-encoding", "gzip"],
          ],
        ),
      ),
      { selected: { operation: "upload-pack" } },
    );
  }
});

test("provider-scoped transport classifies repository REST and GraphQL", () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const body =
      method === "GET" || method === "HEAD" ? undefined : Buffer.from('{"title":"collaboration"}');
    assert.deepEqual(
      classify(
        request(
          "api.github.com",
          "/repos/owner/selected/issues/12",
          method,
          body,
          body ? [["content-type", "application/json"]] : [],
        ),
      ),
      { selected: { operation: "github-rest" } },
    );
  }
  assert.deepEqual(
    classify(
      request(
        "api.github.com",
        "/graphql",
        "POST",
        Buffer.from('{"query":"mutation { __typename }"}'),
        [["content-type", "application/json"]],
      ),
    ),
    { selected: { operation: "github-graphql" } },
  );
});

test("shared transport preserves installation parsing and refuses ambiguous or credential routes", () => {
  // Org paths are existing installation behavior, not evidence that a repository token
  // has no organization permission. The issuer must verify that independently.
  assert.deepEqual(classify(request("api.github.com", "/orgs/owner/repos")), {
    selected: { operation: "github-rest" },
  });
  for (const q of [
    request("api.github.com", "/app/installations/1/access_tokens", "POST"),
    request("api.github.com", "/repos/owner/selected/../other"),
    request(
      "api.github.com",
      "/repos/owner/selected/issues",
      "GET",
      undefined,
      [],
      "page=1&page=2",
    ),
    request("api.github.com", "/graphql", "POST", Buffer.from('{"query":"a","query":"b"}'), [
      ["content-type", "application/json"],
    ]),
    request("github.com.evil.example", "/owner/selected.git/info/refs"),
    request("api.github.com", "/repos/owner/selected", "GET", undefined, [
      ["authorization", "Bearer rejected"],
    ]),
    request("github.com", "/owner/selected.git/git-receive-pack", "POST", gzipSync("push"), [
      ["content-type", "application/x-git-receive-pack-request"],
      ["content-encoding", "gzip"],
    ]),
  ]) {
    assert.ok("denied" in classify(q));
  }
});
