import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

import {
  generateApiReferenceOutputs,
  httpMethods,
} from "../../scripts/generate-occ-api-reference.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A path item also holds path-level keys (`parameters`, `summary`); only HTTP
// methods are operations, as in the generator.
function contractOperations(document) {
  return Object.values(document.paths).flatMap((pathItem) =>
    Object.entries(pathItem)
      .filter(([method]) => httpMethods.has(method))
      .map(([, operation]) => operation),
  );
}

test("generated API reference stays on the approved single page", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const outputs = generateApiReferenceOutputs(document);
  // Legal path-level keys are not operations and must not change the reference.
  const [firstPath] = Object.keys(document.paths);
  Object.assign(document.paths[firstPath], { summary: "Path-level summary", parameters: [] });
  assert.deepEqual(generateApiReferenceOutputs(document), outputs);

  assert.deepEqual(
    outputs.map((output) => output.path),
    ["docs/reference/api.md", "docs/reference/cheatsheets/api.md"],
  );

  const page = outputs[0].content;
  // The Resources table counts each tag's operations from the contract, singular for one.
  const operationsByTag = new Map();
  for (const operation of contractOperations(document)) {
    const tag = operation.tags?.[0] ?? "Untagged";
    operationsByTag.set(tag, (operationsByTag.get(tag) ?? 0) + 1);
  }
  assert.ok(operationsByTag.get("Agents") > 1);
  assert.ok(
    [...operationsByTag.values()].includes(1),
    "No tag has exactly one operation, so the singular label is untested",
  );
  for (const [tag, count] of operationsByTag) {
    const label = count === 1 ? "1 operation" : `${count} operations`;
    assert.match(
      page,
      new RegExp(`^\\| \\[${escapeRegExp(tag)}\\]\\(#[^)]+\\) \\| ${label} \\|$`, "m"),
    );
  }
  assert.match(
    page,
    /\[`GET \/namespaces\/\{namespaceId\}\/agents\/\{agentId\}\/workspace\/files\/\{name\}`\]\(#get-namespacesnamespaceidagentsagentidworkspacefilesname\)/,
  );
  assert.match(
    page,
    /^#### `GET \/namespaces\/\{namespaceId\}\/agents\/\{agentId\}\/workspace\/files\/\{name\}`/m,
  );
  assert.match(
    page,
    /<span id="get-namespacesnamespaceidagentsagentidworkspacefilesname"><\/span>/,
  );
  assert.doesNotMatch(page, /api\/agents-workspace\.md/);

  const operationIds = contractOperations(document).map((operation) => operation.operationId);
  for (const operationId of operationIds) {
    const matches =
      page.match(new RegExp(`\\*\\*Operation ID:\\*\\* \`${escapeRegExp(operationId)}\``, "g")) ??
      [];
    assert.equal(matches.length, 1, `${operationId} appears ${matches.length} times`);
  }
});

test("every operation with a request body documents 413 and 415", async () => {
  // The controller answers an oversized body 413 and a non-JSON media type 415 on every
  // route that reads a body; updateCredentialSource and the /api/auth/* operations
  // documented neither.
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const missing = contractOperations(document)
    .filter((operation) => operation.requestBody !== undefined)
    .filter((operation) => !("413" in operation.responses && "415" in operation.responses))
    .map((operation) => operation.operationId);
  assert.deepEqual(missing, []);
});

test("AccessBinding creation documents request body target read permissions", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const operation =
    document.paths["/namespaces/{namespaceId}/iam/access-bindings"]?.post ?? undefined;
  assert.ok(operation, "createIAMAccessBinding OpenAPI operation is missing");

  // Every bindable target kind requires read on the exact request body target.
  const targets = [
    "agent",
    "agent_revision",
    "configuration",
    "credential_source",
    "namespace",
    "preset",
    "secret",
    "service_account",
  ];
  assert.deepEqual(operation["x-openclaw-permissions"], [
    { action: "administer", resourceKind: "installation", scope: "requested" },
    { action: "read", resourceKind: "namespace", scope: "requested" },
    ...targets.map((resourceKind) => ({
      action: "read",
      resourceKind,
      scope: "request_body",
      condition: "iam_binding_target",
    })),
  ]);
});

test("Agent plugin and first deployment operations document conditional grants", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const agentPath = "/namespaces/{namespaceId}/agents/{agentId}";
  const capabilities =
    document.paths[`${agentPath}/plugins/capabilities`]?.get?.["x-openclaw-permissions"];
  const discovery = document.paths[`${agentPath}/plugins`]?.post?.["x-openclaw-permissions"];
  const details = document.paths[`${agentPath}/plugins/details`]?.post?.["x-openclaw-permissions"];
  const deploy = document.paths[`${agentPath}/deploy`]?.post?.["x-openclaw-permissions"];

  const agentRead = { action: "read", resourceKind: "agent", scope: "requested" };
  const hostedSecret = {
    action: "operate",
    resourceKind: "secret",
    scope: "requested",
    condition: "authenticated_plugin_discovery",
  };
  assert.ok(capabilities.some((permission) => permission.action === "update"));
  assert.ok(capabilities.some((permission) => isDeepStrictEqual(permission, agentRead)));
  for (const permissions of [discovery, details]) {
    assert.ok(permissions.some((permission) => isDeepStrictEqual(permission, agentRead)));
    assert.ok(permissions.some((permission) => isDeepStrictEqual(permission, hostedSecret)));
  }
  for (const action of ["read", "operate"]) {
    assert.ok(
      deploy.some((permission) =>
        isDeepStrictEqual(permission, {
          action,
          resourceKind: "agent",
          scope: "requested",
          condition: "missing_runtime_credentials",
        }),
      ),
    );
  }
});

test("credential source grants appear on the Agent and source operations that check them", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const operations = new Map(
    contractOperations(document).map((operation) => [operation.operationId, operation]),
  );
  const permissions = (operationId) => {
    const operation = operations.get(operationId);
    assert.ok(operation, `${operationId} OpenAPI operation is missing`);
    return operation["x-openclaw-permissions"];
  };
  const sourceOperate = (scope) => ({
    action: "operate",
    resourceKind: "credential_source",
    scope,
    condition: "bound_credential_source",
  });
  // OCC authorizes the caller's operate on every listed or Harness source.
  assert.ok(
    permissions("createAgent").some((permission) =>
      isDeepStrictEqual(permission, sourceOperate("request_body")),
    ),
  );
  for (const operationId of ["updateAgent", "deployAgent"]) {
    assert.ok(
      permissions(operationId).some((permission) =>
        isDeepStrictEqual(permission, sourceOperate("requested")),
      ),
      operationId,
    );
  }
  // Guided provisioning refuses credential sources outright.
  assert.ok(
    !permissions("provisionAgent").some(
      (permission) => permission.resourceKind === "credential_source",
    ),
  );
  // Registration and update read each referenced Secret's value for the gateway.
  assert.deepEqual(permissions("createCredentialSource"), [
    { action: "create", resourceKind: "credential_source", scope: "namespace" },
    { action: "operate", resourceKind: "secret", scope: "request_body", condition: "bound_secret" },
  ]);
  assert.deepEqual(permissions("updateCredentialSource"), [
    { action: "update", resourceKind: "credential_source", scope: "requested" },
    { action: "operate", resourceKind: "secret", scope: "requested", condition: "bound_secret" },
  ]);

  const page = generateApiReferenceOutputs(document)[0].content;
  assert.match(page, /^\| `operate` \| `credential_source` \| `requested` \(when bound\) \|$/m);
  assert.match(
    page,
    /Agent service principal to have operate permission on each bound Secret and on each CredentialSource the Agent lists\./,
  );
});

test("OpenAPI check rejects unexpected generated API child pages in an isolated CLI fixture", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "occ-api-reference-check-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  await mkdir(join(fixture, "scripts"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "scripts/generate-occ-openapi.mjs"),
    join(fixture, "scripts/generate-occ-openapi.mjs"),
  );
  await copyFile(
    join(repositoryRoot, "scripts/generate-occ-api-reference.mjs"),
    join(fixture, "scripts/generate-occ-api-reference.mjs"),
  );
  await copyFile(join(repositoryRoot, "package.json"), join(fixture, "package.json"));
  await symlink(join(repositoryRoot, "apps"), join(fixture, "apps"));
  await symlink(join(repositoryRoot, "node_modules"), join(fixture, "node_modules"));
  await mkdir(join(fixture, "packages/contracts/openapi"), { recursive: true });
  await copyFile(contractPath, join(fixture, "packages/contracts/openapi/occ-api.openapi.json"));

  const generateResult = spawnSync(process.execPath, ["scripts/generate-occ-openapi.mjs"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(generateResult.status, 0, generateResult.stderr + generateResult.stdout);

  await mkdir(join(fixture, "docs/reference/api"), { recursive: true });
  await writeFile(
    join(fixture, "docs/reference/api/unexpected-ci-check.md"),
    "# Unexpected API page\n",
  );

  const result = spawnSync(process.execPath, ["scripts/generate-occ-openapi.mjs", "--check"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.notEqual(result.status, 0, "OpenAPI check accepted an unexpected generated page");
  assert.match(
    result.stderr + result.stdout,
    /Unexpected generated API reference file: docs\/reference\/api\/unexpected-ci-check\.md/,
  );
});

test("operations without a request body do not list 413 or 415", async () => {
  // The reference introduction says when any request answers 413 or 415; an operation
  // lists them only when it takes a body. Three bodiless operations listed them.
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const listed = contractOperations(document)
    .filter((operation) => operation.requestBody === undefined)
    .filter((operation) => "413" in operation.responses || "415" in operation.responses)
    .map((operation) => operation.operationId);
  assert.deepEqual(listed, []);
});

test("every operation with a request body documents 400", async () => {
  // Every body is validated against its operation's schema before the handler runs. Eleven
  // /api/auth/* operations, whose schemas are inline rather than in the shared route
  // contract, once omitted the 400 that validation answers.
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const missing = contractOperations(document)
    .filter((operation) => operation.requestBody !== undefined)
    .filter((operation) => !("400" in operation.responses))
    .map((operation) => operation.operationId);
  assert.deepEqual(missing, []);
});

test("the error envelope table documents the shared ErrorResponse, not an inline copy", async () => {
  // Inline /api/auth/* error schemas also carry `details` so schema 400s keep their field
  // pointers. The reference introduction must still describe the shared envelope's codes
  // and limits, which those inline copies do not repeat.
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const page = generateApiReferenceOutputs(document)[0].content;
  const section = page.slice(page.indexOf("## Error responses"), page.indexOf("## Resources"));
  assert.match(section, /^\| `error\.code` \| `"INVALID_REQUEST" or /m);
  assert.match(
    section,
    /^\| `error\.message` \| `string` \| Yes \| min length: 1; max length: 256 \|$/m,
  );
});
