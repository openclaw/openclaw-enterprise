import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateApiReferenceOutputs } from "../../scripts/generate-occ-api-reference.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = fileURLToPath(
  new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("generated API reference stays on the approved single page", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const outputs = generateApiReferenceOutputs(document);

  assert.deepEqual(
    outputs.map((output) => output.path),
    ["docs/reference/api.md", "docs/reference/cheatsheets/api.md"],
  );

  const page = outputs[0].content;
  assert.match(page, /\| \[Agents\]\(#agents\) \| 15 operations \|/);
  assert.match(page, /\| \[Backends\]\(#backends\) \| 1 operation \|/);
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

  const operationIds = Object.values(document.paths)
    .flatMap((operations) => Object.values(operations))
    .map((operation) => operation.operationId);
  for (const operationId of operationIds) {
    const matches =
      page.match(new RegExp(`\\*\\*Operation ID:\\*\\* \`${escapeRegExp(operationId)}\``, "g")) ??
      [];
    assert.equal(matches.length, 1, `${operationId} appears ${matches.length} times`);
  }
});

test("AccessBinding creation documents request body target read permissions", async () => {
  const document = JSON.parse(await readFile(contractPath, "utf8"));
  const operation =
    document.paths["/namespaces/{namespaceId}/iam/access-bindings"]?.post ?? undefined;
  assert.ok(operation, "createIAMAccessBinding OpenAPI operation is missing");

  assert.deepEqual(operation["x-openclaw-permissions"], [
    { action: "administer", resourceKind: "installation", scope: "requested" },
    { action: "read", resourceKind: "namespace", scope: "requested" },
    {
      action: "read",
      resourceKind: "agent",
      scope: "request_body",
      condition: "iam_binding_target",
    },
    {
      action: "read",
      resourceKind: "agent_revision",
      scope: "request_body",
      condition: "iam_binding_target",
    },
    {
      action: "read",
      resourceKind: "configuration",
      scope: "request_body",
      condition: "iam_binding_target",
    },
    {
      action: "read",
      resourceKind: "secret",
      scope: "request_body",
      condition: "iam_binding_target",
    },
    {
      action: "read",
      resourceKind: "service_account",
      scope: "request_body",
      condition: "iam_binding_target",
    },
  ]);
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
