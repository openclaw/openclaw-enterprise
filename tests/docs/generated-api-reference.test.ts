import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

import { documentApiExamples } from "../../scripts/document-api-examples.ts";
import {
  generateApiReferenceOutputs,
  httpMethods,
} from "../../scripts/generate-occ-api-reference.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readContract(): Promise<unknown> {
  const document: unknown = JSON.parse(await readFile(contractPath, "utf8"));
  return document;
}

function record(value: unknown, context: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), context);
  return value as Record<string, unknown>;
}

function contractPaths(document: unknown) {
  return record(record(document, "OpenAPI document").paths, "OpenAPI paths");
}

function permissionsFor(operation: Record<string, unknown>): unknown[] {
  const permissions = operation["x-openclaw-permissions"];
  assert.ok(Array.isArray(permissions), `${String(operation.operationId)} permissions are missing`);
  return permissions;
}

// A path item also holds path-level keys (`parameters`, `summary`); only HTTP
// methods are operations, as in the generator.
function contractOperations(document: unknown) {
  return Object.entries(contractPaths(document)).flatMap(([path, pathItem]) =>
    Object.entries(record(pathItem, path))
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => record(operation, `${method} ${path}`)),
  );
}

test("example enrichment preserves the generated contract and rejects duplicate operations", async () => {
  const document = await readContract();
  const original = structuredClone(document);
  assert.equal(documentApiExamples(document), document);
  assert.deepEqual(document, original);

  const operations = contractOperations(document);
  const [first, second] = operations;
  assert.ok(first && second);
  second.operationId = first.operationId;
  assert.throws(() => documentApiExamples(document), /Missing or duplicate operationId/);
});

test("generated API reference stays on the approved single page", async () => {
  const document = await readContract();
  const outputs = generateApiReferenceOutputs(document);
  // Legal path-level keys are not operations and must not change the reference.
  const [firstPath] = Object.entries(contractPaths(document));
  assert.ok(firstPath);
  Object.assign(record(firstPath[1], firstPath[0]), {
    summary: "Path-level summary",
    parameters: [],
  });
  assert.deepEqual(generateApiReferenceOutputs(document), outputs);

  assert.deepEqual(
    outputs.map((output) => output.path),
    ["docs/reference/api.md", "docs/reference/cheatsheets/api.md"],
  );

  const page = outputs[0].content;
  // The Resources table counts each tag's operations from the contract, singular for one.
  const operationsByTag = new Map<string, number>();
  for (const operation of contractOperations(document)) {
    const { tags } = operation;
    assert.ok(tags === undefined || Array.isArray(tags));
    const tag: unknown = tags?.[0] ?? "Untagged";
    assert.ok(typeof tag === "string");
    operationsByTag.set(tag, (operationsByTag.get(tag) ?? 0) + 1);
  }
  assert.ok((operationsByTag.get("Agents") ?? 0) > 1);
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
    assert.ok(typeof operationId === "string");
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
  const document = await readContract();
  const missing = contractOperations(document)
    .filter((operation) => operation.requestBody !== undefined)
    .filter((operation) => {
      const responses = record(operation.responses, "operation responses");
      return !("413" in responses && "415" in responses);
    })
    .map((operation) => operation.operationId);
  assert.deepEqual(missing, []);
});

test("AccessBinding creation documents request body target read permissions", async () => {
  const document = await readContract();
  const path = "/namespaces/{namespaceId}/iam/access-bindings";
  const pathItem = record(contractPaths(document)[path], path);
  const operation = record(pathItem.post, "createIAMAccessBinding OpenAPI operation is missing");

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
  const document = await readContract();
  const agentPath = "/namespaces/{namespaceId}/agents/{agentId}";
  const paths = contractPaths(document);
  const permissions = (suffix: string, method: string) => {
    const path = `${agentPath}${suffix}`;
    const pathItem = record(paths[path], path);
    return permissionsFor(record(pathItem[method], `${method} ${path}`));
  };
  const capabilities = permissions("/plugins/capabilities", "get");
  const discovery = permissions("/plugins", "post");
  const details = permissions("/plugins/details", "post");
  const deploy = permissions("/deploy", "post");

  const agentRead = { action: "read", resourceKind: "agent", scope: "requested" };
  const hostedSecret = {
    action: "operate",
    resourceKind: "secret",
    scope: "requested",
    condition: "authenticated_plugin_discovery",
  };
  assert.ok(
    capabilities.some((permission) => record(permission, "permission").action === "update"),
  );
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

test("Agent and CredentialSource operations document the permissions they check", async () => {
  const document = await readContract();
  const operations = new Map(
    contractOperations(document).map((operation) => [operation.operationId, operation]),
  );
  const permissions = (operationId: string) => {
    const operation = operations.get(operationId);
    assert.ok(operation, `${operationId} OpenAPI operation is missing`);
    return permissionsFor(operation);
  };
  const installationGrants = (operationId: string) =>
    permissions(operationId).filter(
      (permission) => record(permission, "permission").resourceKind === "installation",
    );
  for (const [operationId, condition] of [
    ["createAgent", "gateway_managed_mode_disabled"],
    ["validateAgentCreate", "gateway_managed_mode_disabled"],
    ["updateAgent", "gateway_managed_mode_changed"],
  ] as const) {
    assert.deepEqual(
      installationGrants(operationId),
      [{ action: "administer", resourceKind: "installation", scope: "installation", condition }],
      operationId,
    );
  }
  // Deploy applies the mode already authorized on the saved draft.
  assert.deepEqual(installationGrants("deployAgent"), []);

  const sourceOperate = (scope: string) => ({
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
      (permission) => record(permission, "permission").resourceKind === "credential_source",
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
  const fixture = await temporaryDirectory(t, "occ-api-reference-check-");

  await mkdir(join(fixture, "scripts"), { recursive: true });
  for (const file of [
    "generate-occ-openapi.mjs",
    "generate-occ-api-reference.ts",
    "document-api-examples.ts",
    "api-examples.ts",
  ]) {
    await copyFile(join(repositoryRoot, "scripts", file), join(fixture, "scripts", file));
  }
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
  const document = await readContract();
  const listed = contractOperations(document)
    .filter((operation) => operation.requestBody === undefined)
    .filter((operation) => {
      const responses = record(operation.responses, "operation responses");
      return "413" in responses || "415" in responses;
    })
    .map((operation) => operation.operationId);
  assert.deepEqual(listed, []);
});

test("every operation with a request body documents 400", async () => {
  // Every body is validated against its operation's schema before the handler runs. Eleven
  // /api/auth/* operations, whose schemas are inline rather than in the shared route
  // contract, once omitted the 400 that validation answers.
  const document = await readContract();
  const missing = contractOperations(document)
    .filter((operation) => operation.requestBody !== undefined)
    .filter((operation) => !("400" in record(operation.responses, "operation responses")))
    .map((operation) => operation.operationId);
  assert.deepEqual(missing, []);
});

test("the error envelope table documents the shared ErrorResponse, not an inline copy", async () => {
  // Inline /api/auth/* error schemas also carry `details` so schema 400s keep their field
  // pointers. The reference introduction must still describe the shared envelope's codes
  // and limits, which those inline copies do not repeat.
  const document = await readContract();
  const page = generateApiReferenceOutputs(document)[0].content;
  const section = page.slice(page.indexOf("## Error responses"), page.indexOf("## Resources"));
  assert.match(section, /^\| `error\.code` \| `"INVALID_REQUEST" or /m);
  assert.match(
    section,
    /^\| `error\.message` \| `string` \| Yes \| min length: 1; max length: 256 \|$/m,
  );
});
