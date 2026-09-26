import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const documentPath = new URL("../packages/contracts/openapi/occ-api.openapi.json", import.meta.url);
const referenceDirectoryPath = new URL("../docs/reference/api/", import.meta.url);
const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

// Curated entity order and subdivisions; unmatched operations keep their OpenAPI tag.
const cheatSheetEntities = [
  { title: "Authentication accounts", tag: "Authentication", paths: ["/api/auth/accounts"] },
  {
    title: "Authentication sessions",
    tag: "Authentication",
    paths: ["/api/auth/session", "/api/auth/sign-in", "/api/auth/sign-out"],
  },
  { title: "Service API keys", tag: "Authentication", paths: ["/api/auth/service-keys"] },
  { title: "Installation" },
  { title: "Namespaces" },
  { title: "Agents" },
  { title: "Agent deployments" },
  { title: "Agent revisions" },
  { title: "Agent runtime credentials", tag: "Agents", paths: ["/runtime-credentials"] },
  { title: "Agent workspace files", tag: "Agents", paths: ["/workspace/files"] },
  { title: "Configurations" },
  { title: "IAM access bindings", tag: "IAM", paths: ["/iam/access-bindings"] },
  { title: "IAM roles", tag: "IAM", paths: ["/iam/roles"] },
  { title: "Secrets" },
  { title: "Service accounts" },
  {
    title: "Service account credentials",
    tag: "Service accounts",
    paths: ["/credential", "/credentials"],
  },
  { title: "Backends" },
];

function slugifySegment(value) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "operation"
  );
}

function tagAnchor(tag) {
  return slugifySegment(tag);
}

function operationAnchor(path, method) {
  const pathId = path
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return `${method.toLowerCase()}-${pathId}`;
}

function schemaType(schema, document) {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    return document.components?.schemas?.[name]?.title ?? name;
  }

  if (Object.hasOwn(schema, "const")) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" or ");
  }
  if (schema.anyOf) {
    return schema.anyOf.map((alternative) => schemaType(alternative, document)).join(" or ");
  }
  if (schema.type === "array") {
    return `array<${schemaType(schema.items ?? {}, document)}>`;
  }
  if (
    schema.type === "object" &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    return `object<string, ${schemaType(schema.additionalProperties, document)}>`;
  }

  return schema.format ? `${schema.type} (${schema.format})` : (schema.type ?? "any");
}

function resolveSchema(schema, document) {
  if (!schema?.$ref) {
    return schema;
  }

  if (!schema.$ref.startsWith("#/")) {
    return schema;
  }

  return (
    schema.$ref
      .slice(2)
      .split("/")
      .reduce(
        (value, segment) => value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
        document,
      ) ?? schema
  );
}

function schemaConstraints(schema) {
  const constraints = [];

  if (schema.minLength !== undefined) {
    constraints.push(`min length: ${schema.minLength}`);
  }
  if (schema.maxLength !== undefined) {
    constraints.push(`max length: ${schema.maxLength}`);
  }
  if (schema.minimum !== undefined) {
    constraints.push(`minimum: ${schema.minimum}`);
  }
  if (schema.maximum !== undefined) {
    constraints.push(`maximum: ${schema.maximum}`);
  }
  if (schema.minItems !== undefined) {
    constraints.push(`min items: ${schema.minItems}`);
  }
  if (schema.maxItems !== undefined) {
    constraints.push(`max items: ${schema.maxItems}`);
  }
  if (schema.pattern) {
    constraints.push(`pattern: \`${schema.pattern.replaceAll("|", "\\|")}\``);
  }
  if (schema.default !== undefined) {
    constraints.push(`default: ${JSON.stringify(schema.default)}`);
  }
  if (schema.description) {
    constraints.push(schema.description.replaceAll("|", "\\|"));
  }

  return constraints.join("; ") || "—";
}

function schemaRows(schema, document, parent = "") {
  const resolvedSchema = resolveSchema(schema, document);
  const rows = [];

  for (const [name, property] of Object.entries(resolvedSchema.properties ?? {})) {
    const resolvedProperty = resolveSchema(property, document);
    const field = parent ? `${parent}.${name}` : name;
    const required = resolvedSchema.required?.includes(name) ? "Yes" : "No";
    const columns = [
      `\`${field}\``,
      `\`${schemaType(property, document)}\``,
      required,
      schemaConstraints(resolvedProperty),
    ];
    rows.push(`| ${columns.join(" | ")} |`);

    if (resolvedProperty.type === "object" && resolvedProperty.properties) {
      rows.push(...schemaRows(resolvedProperty, document, field));
    } else if (resolvedProperty.type === "array") {
      const resolvedItems = resolveSchema(resolvedProperty.items, document);
      if (resolvedItems.properties) {
        rows.push(...schemaRows(resolvedItems, document, `${field}[]`));
      }
    }
  }

  return rows;
}

function schemaTable(schema, document) {
  const resolvedSchema = resolveSchema(schema, document);
  const rows = schemaRows(resolvedSchema, document);
  if (rows.length === 0) {
    return `Schema: \`${schemaType(schema, document)}\`.`;
  }

  return ["| Field | Type | Required | Constraints |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

function operationReference(path, method, operation, document, { headingLevel = 2 } = {}) {
  const childHeading = "#".repeat(Math.min(headingLevel + 1, 6));
  const sections = [
    `${"#".repeat(headingLevel)} \`${method.toUpperCase()} ${path}\``,
    `<span id="${operationAnchor(path, method)}"></span>`,
    operation.summary ?? "No summary.",
    `**Operation ID:** \`${operation.operationId ?? `${method}_${path}`}\``,
    `**Permissions:** ${operation.description ?? "No IAM permission required."}`,
  ];

  if (operation["x-openclaw-permissions"]?.length) {
    sections.push(
      [
        "| Action | Resource | Scope |",
        "| --- | --- | --- |",
        ...operation["x-openclaw-permissions"].map(({ action, resourceKind, scope, condition }) => {
          const qualifier =
            condition === "associated_service_account"
              ? " (when associated)"
              : condition === "existing_namespace"
                ? " (when selecting an existing namespace)"
                : condition === "bound_secret"
                  ? " (when bound)"
                  : "";
          return `| \`${action}\` | \`${resourceKind}\` | \`${scope}\`${qualifier} |`;
        }),
      ].join("\n"),
    );
  }

  if (operation.parameters?.length) {
    sections.push(
      `${childHeading} Parameters`,
      [
        "| Name | In | Type | Required | Constraints |",
        "| --- | --- | --- | --- | --- |",
        ...operation.parameters.map((parameter) => {
          const columns = [
            `\`${parameter.name}\``,
            parameter.in,
            `\`${schemaType(parameter.schema, document)}\``,
            parameter.required ? "Yes" : "No",
            schemaConstraints(parameter.schema),
          ];
          return `| ${columns.join(" | ")} |`;
        }),
      ].join("\n"),
    );
  }

  if (operation.requestBody) {
    sections.push(
      `${childHeading} Request body`,
      `**Required:** ${operation.requestBody.required ? "Yes" : "No"}`,
    );

    for (const [contentType, content] of Object.entries(operation.requestBody.content ?? {})) {
      sections.push(`**Content type:** \`${contentType}\``, schemaTable(content.schema, document));
    }
  }

  sections.push(
    `${childHeading} Responses`,
    [
      "| Status | Meaning |",
      "| --- | --- |",
      ...Object.keys(operation.responses).map((status) => {
        const description = operation.responses[status].description;
        const meaning =
          description && description !== "Default Response"
            ? description
            : (STATUS_CODES[status] ?? description);
        return `| \`${status}\` | ${meaning?.replaceAll("|", "\\|")} |`;
      }),
    ].join("\n"),
  );

  for (const [status, response] of Object.entries(operation.responses)) {
    if (!status.startsWith("2")) {
      continue;
    }

    for (const [contentType, content] of Object.entries(response.content ?? {})) {
      sections.push(
        `**\`${status}\` response body:** \`${contentType}\``,
        schemaTable(content.schema, document),
      );
    }
  }

  return sections.join("\n\n");
}

function operationRows(operations) {
  return [
    "| Operation | Summary |",
    "| --- | --- |",
    ...operations.map(({ anchor, method, operation, path }) => {
      return `| [\`${method.toUpperCase()} ${path}\`](#${anchor}) | ${operation.summary ?? "No summary."} |`;
    }),
  ].join("\n");
}

function errorSchema(document, entries) {
  const operations = entries.map(({ operation }) => operation);
  return (
    operations
      .flatMap((operation) => Object.entries(operation.responses))
      .find(([status, response]) => {
        const schema = resolveSchema(response.content?.["application/json"]?.schema, document);
        return !status.startsWith("2") && schema.properties?.error?.properties?.details;
      })
      ?.at(1).content["application/json"].schema ??
    operations
      .flatMap((operation) => Object.entries(operation.responses))
      .find(([status, response]) => {
        return !status.startsWith("2") && response.content?.["application/json"]?.schema;
      })
      ?.at(1).content["application/json"].schema
  );
}

function generatedComment() {
  return "<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->";
}

function introduction(document) {
  return [
    `Version \`${document.info.version}\`; OpenAPI \`${document.openapi}\`.`,
    [
      "This reference is generated from the",
      "[checked-in OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).",
      "Run `pnpm openapi:generate` after changing an API route or schema;",
      "`pnpm openapi:check` verifies the generated contract, this reference,",
      "and the [API cheat sheet](cheatsheets/api.md).",
    ].join("\n"),
    [
      "The exported contract comes from the development-enabled OCC app, which is",
      "why the generated title is `Development OCC API`. Use",
      "`POST /installation/bootstrap` only for development or bootstrap flows",
      "that create the first Installation; production bootstraps through the",
      "[Helm initialization Job](../guides/deploy/production-installation.md#provision-system-secrets-and-install)",
      "before serving requests.",
      "After bootstrap, production uses the same authenticated controller resource",
      "operations through the selected Drivers and settings described in",
      "[settings](settings.md).",
    ].join("\n"),
    "See [authentication](authentication.md) for supported credentials and their scope.",
  ];
}

function operationEntries(document) {
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.entries(operations)
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => ({
        anchor: operationAnchor(path, method),
        method,
        operation,
        operationId: operation.operationId,
        path,
        tag: operation.tags?.[0] ?? "Untagged",
      })),
  );
}

function referenceGroups(entries) {
  const groups = [];
  const byTag = new Map();
  for (const entry of entries) {
    let group = byTag.get(entry.tag);
    if (!group) {
      group = {
        title: entry.tag,
        anchor: tagAnchor(entry.tag),
        operations: [],
      };
      byTag.set(entry.tag, group);
      groups.push(group);
    }
    group.operations.push(entry);
  }
  return groups;
}

function referencePage(document, groups, entries) {
  const sections = [
    `# ${document.info.title} reference`,
    generatedComment(),
    ...introduction(document),
  ];
  const schema = errorSchema(document, entries);

  if (schema) {
    sections.push(
      "## Error responses",
      [
        "Non-success JSON responses use the following envelope.",
        "Each operation lists its supported status codes.",
      ].join("\n"),
      schemaTable(schema, document),
    );
  }

  sections.push(
    "## Resources",
    [
      "| Resource | Operations |",
      "| --- | --- |",
      ...groups.map((group) => {
        const operations =
          group.operations.length === 1 ? "1 operation" : `${group.operations.length} operations`;
        return `| [${group.title}](#${group.anchor}) | ${operations} |`;
      }),
    ].join("\n"),
  );

  sections.push("## Operations");
  for (const group of groups) {
    sections.push(
      `<span id="${group.anchor}"></span>`,
      `### ${group.title}`,
      operationRows(group.operations),
      ...group.operations.map((entry) =>
        operationReference(entry.path, entry.method, entry.operation, document, {
          headingLevel: 4,
        }),
      ),
    );
  }

  const schemas = Object.entries(document.components?.schemas ?? {});
  if (schemas.length) {
    sections.push(
      "## Shared schemas",
      "Reusable schema names are referenced by operation request and response tables.",
      [
        "| Schema | Type |",
        "| --- | --- |",
        ...schemas.map(
          ([name, schema]) =>
            `| \`${schema.title ?? name}\` | \`${schemaType(schema, document)}\` |`,
        ),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function cheatSheetEntityOrder(title) {
  const index = cheatSheetEntities.findIndex((entity) => entity.title === title);
  if (index !== -1) {
    return index;
  }

  const lastSibling = cheatSheetEntities.findLastIndex((entity) => entity.tag === title);
  return lastSibling === -1 ? cheatSheetEntities.length : lastSibling + 0.5;
}

function cheatSheetOperationOrder({ method, operationId, path }) {
  // Keep native administration after Agent lifecycle operations in the compact index.
  if (method === "get" && path.endsWith("/native-admin")) {
    return 5;
  }
  if (method === "get") {
    return operationId.startsWith("list") ? 0 : 1;
  }
  if (method === "post" && /^(?:create|bootstrap|provision)/.test(operationId)) {
    return 2;
  }
  if (method === "patch" || method === "put") {
    return 3;
  }
  if (method === "delete") {
    return 6;
  }
  return 4;
}

function cheatSheetPage(entries) {
  const groups = new Map();
  const operationIds = new Set();
  const operationAnchors = new Map();

  for (const entry of entries) {
    if (typeof entry.operationId !== "string" || !entry.operationId.trim()) {
      throw new Error(
        `Missing OpenAPI operationId for ${entry.method.toUpperCase()} ${entry.path}.`,
      );
    }
    if (operationIds.has(entry.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${entry.operationId}.`);
    }
    operationIds.add(entry.operationId);

    const route = `${entry.method.toUpperCase()} ${entry.path}`;
    if (typeof entry.operation.summary !== "string" || !entry.operation.summary.trim()) {
      throw new Error(`Missing OpenAPI summary for ${route}.`);
    }
    const summary = entry.operation.summary.trim().replace(/\s+/g, " ");

    if (operationAnchors.has(entry.anchor)) {
      throw new Error(
        `Duplicate API reference anchor ${entry.anchor} for ${operationAnchors.get(entry.anchor)} and ${route}.`,
      );
    }
    operationAnchors.set(entry.anchor, route);

    const entity = cheatSheetEntities.find(
      ({ tag, paths }) =>
        tag === entry.tag &&
        paths?.some((path) => entry.path.endsWith(path) || entry.path.includes(`${path}/`)),
    );
    const title = entity?.title ?? entry.tag;
    if (!groups.has(title)) {
      groups.set(title, []);
    }
    groups.get(title).push({ ...entry, summary });
  }

  const sections = ["# API cheat sheet", generatedComment(), "## Operations"];
  const entities = [...groups].sort(
    ([left], [right]) => cheatSheetEntityOrder(left) - cheatSheetEntityOrder(right),
  );
  for (const [title, operations] of entities) {
    operations.sort(
      (left, right) =>
        cheatSheetOperationOrder(left) - cheatSheetOperationOrder(right) ||
        left.operationId.localeCompare(right.operationId, "en"),
    );
    sections.push(
      `### ${title}`,
      operations
        .map(
          ({ anchor, operationId, summary }) =>
            `- [\`${operationId}\`](../api.md#${anchor}): ${summary}${/[.!?]$/.test(summary) ? "" : "."}`,
        )
        .join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export function generateApiReferenceOutputs(document) {
  const entries = operationEntries(document);
  const groups = referenceGroups(entries);
  const outputs = [
    {
      label: "API reference",
      path: "docs/reference/api.md",
      content: referencePage(document, groups, entries),
    },
    {
      label: "API cheat sheet",
      path: "docs/reference/cheatsheets/api.md",
      content: cheatSheetPage(entries),
    },
  ];
  return outputs;
}

export function generateApiReference(document) {
  return generateApiReferenceOutputs(document).find(
    (output) => output.path === "docs/reference/api.md",
  ).content;
}

async function walkMarkdown(directoryUrl) {
  let entries;
  try {
    entries = await readdir(directoryUrl, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(url)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative(repositoryRoot, fileURLToPath(url)).split("\\").join("/"));
    }
  }
  return files;
}

export async function unexpectedApiReferenceFiles(outputs) {
  const expectedPaths = new Set(outputs.map((output) => output.path));
  return (await walkMarkdown(referenceDirectoryPath)).filter((path) => !expectedPaths.has(path));
}

export async function removeGeneratedApiReferenceDirectory() {
  await rm(referenceDirectoryPath, { recursive: true, force: true });
}

async function run() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
    throw new Error("Usage: node scripts/generate-occ-api-reference.mjs [--check]");
  }

  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const outputs = generateApiReferenceOutputs(document);

  if (arguments_[0] === "--check") {
    for (const output of outputs) {
      const path = resolve(repositoryRoot, output.path);
      let existing;
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`Missing ${output.path}; run pnpm openapi:generate.`);
        }
        throw error;
      }

      if (existing !== output.content) {
        throw new Error(`${output.path} is out of date; run pnpm openapi:generate.`);
      }
    }

    const unexpected = await unexpectedApiReferenceFiles(outputs);
    if (unexpected.length) {
      throw new Error(
        `Unexpected generated API reference file: ${unexpected.join(", ")}; run pnpm openapi:generate.`,
      );
    }

    process.stdout.write(`API reference is current: ${outputs.length} generated pages\n`);
  } else {
    await removeGeneratedApiReferenceDirectory();
    for (const output of outputs) {
      const path = resolve(repositoryRoot, output.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, output.content, "utf8");
      process.stdout.write(`Generated ${output.label}: ${output.path}\n`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await run();
}
