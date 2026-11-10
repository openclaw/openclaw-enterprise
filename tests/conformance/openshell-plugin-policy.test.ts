import assert from "node:assert/strict";
import test from "node:test";
import { googleRequestPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-plugin-policy.ts";

// OpenShell REST globs: `*` is one segment (`/repos/*/pulls/*/reviews`) and `**` crosses
// segments (`/repos/**`). `{+param}` is the multi-segment form.
function restGlobMatches(pattern: string, path: string): boolean {
  const expression = pattern
    .split("/")
    .map((segment) => {
      if (segment === "**") {
        return ".*";
      }
      if (segment === "*") {
        return "[^/]*";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp("^" + expression + "$").test(path);
}

function allowPaths(
  scope: Parameters<typeof googleRequestPolicy>[0],
): readonly { method: string; path: string }[] {
  const policy = googleRequestPolicy(scope);
  return policy.networks["oce-google-requests"].endpoints.flatMap((endpoint) =>
    endpoint.host === scope.host ? endpoint.rules.map((rule) => rule.allow) : [],
  );
}

test("multi-segment Google resource names stay reachable in the sandbox rule", () => {
  const adsense = allowPaths({
    host: "adsense.googleapis.com",
    port: 443,
    path: "/v2/**",
    scopes: ["https://www.googleapis.com/auth/adsense.readonly"],
  });
  const account = "/v2/accounts/pub-1";
  const childAccounts = "/v2/accounts/pub-1:listChildAccounts";
  for (const path of [account, childAccounts]) {
    assert.equal(
      adsense.some((allow) => allow.method === "GET" && restGlobMatches(allow.path, path)),
      true,
      `no GET rule matches ${path}: ${adsense
        .filter((allow) => allow.method === "GET" && allow.path.startsWith("/v2/"))
        .map((allow) => allow.path)
        .join(", ")}`,
    );
  }
  assert.equal(
    adsense.some((allow) => allow.path.includes("*:")),
    false,
  );
  // The accounts collection is a literal route and stays exact.
  assert.ok(adsense.some((allow) => allow.method === "GET" && allow.path === "/v2/accounts"));

  const directory = allowPaths({
    host: "admin.googleapis.com",
    port: 443,
    path: "/admin/directory/v1/**",
    scopes: ["https://www.googleapis.com/auth/admin.directory.orgunit.readonly"],
  });
  const nested = "/admin/directory/v1/customer/my_customer/orgunits/Engineering/Platform";
  assert.equal(
    directory.some((allow) => allow.method === "GET" && restGlobMatches(allow.path, nested)),
    true,
    `no GET rule matches ${nested}`,
  );
  assert.ok(
    directory.some(
      (allow) => allow.method === "GET" && allow.path === "/admin/directory/v1/customer/*/orgunits",
    ),
  );
});
