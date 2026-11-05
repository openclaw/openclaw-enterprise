import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Entry = {
  anchor: string;
  method: string;
  operation: unknown;
  operationId: unknown;
  path: string;
  tag: unknown;
};
type ValidEntry = Entry & { operationId: string; summary: string };
type Group = { title: unknown; anchor: string; operations: Entry[] };
type Output = { label: string; path: string; content: string };

function hasFields(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
function fields(value: unknown): Record<string, unknown> {
  if (value == null) {
    throw new TypeError("Cannot read nullish value");
  }
  const boxed: unknown = Object(value);
  if (!hasFields(boxed)) {
    throw new TypeError("Expected object");
  }
  return boxed;
}
function field(value: unknown, key: string): unknown {
  return fields(value)[key];
}
function optionalField(value: unknown, key: string): unknown {
  return value == null ? undefined : field(value, key);
}
function entries(value: unknown): [string, unknown][] {
  return Object.entries(fields(value));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected array");
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected string");
  }
  return value;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const documentPath = new URL("../packages/contracts/openapi/occ-api.openapi.json", import.meta.url);
const referenceDirectoryPath = new URL("../docs/reference/api/", import.meta.url);
export const httpMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

// Curated entity order and subdivisions; unmatched operations keep their OpenAPI tag.
const cheatSheetEntities: { title: string; tag?: string; paths?: string[] }[] = [
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
  { title: "IAM service principals", tag: "IAM", paths: ["/iam/service-principals"] },
  { title: "Secrets" },
  { title: "Service accounts" },
  {
    title: "Service account credentials",
    tag: "Service accounts",
    paths: ["/credential", "/credentials"],
  },
  { title: "Backends" },
];

function slugifySegment(value: unknown) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "operation"
  );
}

function tagAnchor(tag: unknown) {
  return slugifySegment(tag);
}

function operationAnchor(path: string, method: string) {
  const pathId = path
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return `${method.toLowerCase()}-${pathId}`;
}

function schemaType(schema: unknown, document: unknown): unknown {
  const ref = field(schema, "$ref");
  if (ref) {
    const name = text(ref).split("/").at(-1);
    return (
      optionalField(
        optionalField(optionalField(optionalField(document, "components"), "schemas"), name ?? ""),
        "title",
      ) ?? name
    );
  }
  if (Object.hasOwn(fields(schema), "const")) {
    return JSON.stringify(field(schema, "const"));
  }
  const values = field(schema, "enum");
  if (values) {
    return array(values)
      .map((value) => JSON.stringify(value))
      .join(" or ");
  }
  const anyOf = field(schema, "anyOf");
  if (anyOf) {
    return array(anyOf)
      .map((value) => schemaType(value, document))
      .join(" or ");
  }
  const type = field(schema, "type");
  if (type === "array") {
    return `array<${schemaType(field(schema, "items") ?? {}, document)}>`;
  }
  const additional = field(schema, "additionalProperties");
  if (type === "object" && additional && typeof additional === "object") {
    return `object<string, ${schemaType(additional, document)}>`;
  }
  const format = field(schema, "format");
  return format ? `${type} (${format})` : (type ?? "any");
}

function resolveSchema(schema: unknown, document: unknown): unknown {
  const ref = optionalField(schema, "$ref");
  if (!ref || !text(ref).startsWith("#/")) {
    return schema;
  }
  let value: unknown = document;
  for (const segment of text(ref).slice(2).split("/")) {
    value = optionalField(value, segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return value ?? schema;
}

function schemaConstraints(schema: unknown) {
  const constraints: string[] = [];
  for (const [key, label] of [
    ["minLength", "min length"],
    ["maxLength", "max length"],
    ["minimum", "minimum"],
    ["maximum", "maximum"],
    ["minItems", "min items"],
    ["maxItems", "max items"],
  ] as const) {
    const value = field(schema, key);
    if (value !== undefined) {
      constraints.push(`${label}: ${value}`);
    }
  }
  const pattern = field(schema, "pattern");
  if (pattern) {
    constraints.push(`pattern: \`${text(pattern).replaceAll("|", "\\|")}\``);
  }
  const defaultValue = field(schema, "default");
  if (defaultValue !== undefined) {
    constraints.push(`default: ${JSON.stringify(defaultValue)}`);
  }
  const description = field(schema, "description");
  if (description) {
    constraints.push(text(description).replaceAll("|", "\\|"));
  }
  return constraints.join("; ") || "—";
}

function schemaRows(schema: unknown, document: unknown, parent = ""): string[] {
  const resolvedSchema = resolveSchema(schema, document);
  const rows: string[] = [];
  for (const [name, property] of entries(field(resolvedSchema, "properties") ?? {})) {
    const resolvedProperty = resolveSchema(property, document);
    const fieldName = parent ? `${parent}.${name}` : name;
    const required = optionalField(resolvedSchema, "required");
    const isRequired =
      required == null
        ? false
        : typeof required === "string"
          ? required.includes(name)
          : array(required).includes(name);
    rows.push(
      `| \`${fieldName}\` | \`${schemaType(property, document)}\` | ${isRequired ? "Yes" : "No"} | ${schemaConstraints(resolvedProperty)} |`,
    );
    const type = field(resolvedProperty, "type");
    if (type === "object" && field(resolvedProperty, "properties")) {
      rows.push(...schemaRows(resolvedProperty, document, fieldName));
    } else if (type === "array") {
      const items = resolveSchema(field(resolvedProperty, "items"), document);
      if (field(items, "properties")) {
        rows.push(...schemaRows(items, document, `${fieldName}[]`));
      }
    }
  }
  return rows;
}

function schemaTable(schema: unknown, document: unknown) {
  const rows = schemaRows(resolveSchema(schema, document), document);
  if (!rows.length) {
    return `Schema: \`${schemaType(schema, document)}\`.`;
  }
  return ["| Field | Type | Required | Constraints |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

const permissionScopeQualifiers: Record<string, string> = {
  associated_service_account: " (when associated)",
  existing_namespace: " (when selecting an existing namespace)",
  bound_secret: " (when bound)",
  bound_credential_source: " (when bound)",
  read_logs_alternative: " (instead of `read_logs`)",
  provisioning_work: " (once created)",
  gateway_managed_mode_disabled: " (when `gatewayManagedMode` is `false`)",
  gateway_managed_mode_changed: " (when the request changes `gatewayManagedMode`)",
  saved_sandbox_policy_additions: " (when saved network policy additions exist)",
};

function renderedExamples(content: unknown, contentType: string) {
  return entries(field(content, "examples") ?? {}).map(([, example]) =>
    [
      field(example, "summary") ?? "Example",
      contentType === "text/plain" ? "```text" : "```json",
      contentType === "text/plain"
        ? field(example, "value")
        : JSON.stringify(field(example, "value"), null, 2),
      "```",
    ].join("\n"),
  );
}

function operationReference(
  path: string,
  method: string,
  operation: unknown,
  document: unknown,
  { headingLevel = 2 }: { headingLevel?: number } = {},
) {
  const childHeading = "#".repeat(Math.min(headingLevel + 1, 6));
  const sections: unknown[] = [
    `${"#".repeat(headingLevel)} \`${method.toUpperCase()} ${path}\``,
    `<span id="${operationAnchor(path, method)}"></span>`,
    field(operation, "summary") ?? "No summary.",
    `**Operation ID:** \`${field(operation, "operationId") ?? `${method}_${path}`}\``,
    `**Permissions:** ${field(operation, "description") ?? "No IAM permission required."}`,
  ];
  const permissions = field(operation, "x-openclaw-permissions");
  if (optionalField(permissions, "length")) {
    sections.push(
      [
        "| Action | Resource | Scope |",
        "| --- | --- | --- |",
        ...array(permissions).map((permission) => {
          const condition = field(permission, "condition");
          const qualifier = permissionScopeQualifiers[String(condition)] ?? "";
          return `| \`${field(permission, "action")}\` | \`${field(permission, "resourceKind")}\` | \`${field(permission, "scope")}\`${qualifier} |`;
        }),
      ].join("\n"),
    );
  }
  const parameters = field(operation, "parameters");
  if (optionalField(parameters, "length")) {
    sections.push(
      `${childHeading} Parameters`,
      [
        "| Name | In | Type | Required | Constraints | Example |",
        "| --- | --- | --- | --- | --- | --- |",
        ...array(parameters).map((parameter) => {
          const schema = field(parameter, "schema");
          const value = optionalField(
            optionalField(field(parameter, "examples"), "example"),
            "value",
          );
          return `| ${[`\`${field(parameter, "name")}\``, field(parameter, "in"), `\`${schemaType(schema, document)}\``, field(parameter, "required") ? "Yes" : "No", schemaConstraints(schema), JSON.stringify(value)?.replaceAll("|", "\\|") ?? "—"].join(" | ")} |`;
        }),
      ].join("\n"),
    );
  }
  const requestBody = field(operation, "requestBody");
  if (requestBody) {
    sections.push(
      `${childHeading} Request body`,
      `**Required:** ${field(requestBody, "required") ? "Yes" : "No"}`,
    );
    for (const [contentType, content] of entries(field(requestBody, "content") ?? {})) {
      sections.push(
        `**Content type:** \`${contentType}\``,
        schemaTable(field(content, "schema"), document),
        ...renderedExamples(content, contentType),
      );
    }
  }
  const responses = entries(field(operation, "responses"));
  sections.push(
    `${childHeading} Responses`,
    [
      "| Status | Meaning |",
      "| --- | --- |",
      ...responses.map(([status, response]) => {
        const description = field(response, "description");
        const meaning =
          description && description !== "Default Response"
            ? description
            : (STATUS_CODES[status] ?? description);
        return `| \`${status}\` | ${meaning == null ? undefined : text(meaning).replaceAll("|", "\\|")} |`;
      }),
    ].join("\n"),
  );
  for (const [status, response] of responses) {
    if (!status.startsWith("2")) {
      continue;
    }
    for (const [contentType, content] of entries(field(response, "content") ?? {})) {
      sections.push(
        `**\`${status}\` response body:** \`${contentType}\``,
        schemaTable(field(content, "schema"), document),
        ...renderedExamples(content, contentType),
      );
    }
  }
  return sections.join("\n\n");
}

function operationRows(operations: Entry[]) {
  return [
    "| Operation | Summary |",
    "| --- | --- |",
    ...operations.map(
      ({ anchor, method, operation, path }) =>
        `| [\`${method.toUpperCase()} ${path}\`](#${anchor}) | ${field(operation, "summary") ?? "No summary."} |`,
    ),
  ].join("\n");
}

function errorSchema(document: unknown, operationList: Entry[]) {
  const schemas = operationList
    .flatMap(({ operation }) => entries(field(operation, "responses")))
    .filter(
      ([status, response]) =>
        !status.startsWith("2") &&
        optionalField(
          optionalField(optionalField(response, "content"), "application/json"),
          "schema",
        ),
    )
    .map(([, response]) => field(field(field(response, "content"), "application/json"), "schema"));
  const detailed = schemas.filter((schema) =>
    optionalField(
      optionalField(
        optionalField(optionalField(resolveSchema(schema, document), "properties"), "error"),
        "properties",
      ),
      "details",
    ),
  );
  return detailed.find((schema) => field(schema, "$ref")) ?? detailed[0] ?? schemas[0];
}

function generatedComment() {
  return "<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->";
}

function tableOfContents(titles: unknown[]) {
  const links = titles.map((title) => `- [${title}](#${tagAnchor(title)})`);
  return `## Table of contents\n\n${links.join("\n")}`;
}

function introduction(document: unknown) {
  return [
    `Version \`${field(field(document, "info"), "version")}\`; OpenAPI \`${field(document, "openapi")}\`.`,
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

function operationEntries(document: unknown): Entry[] {
  return entries(field(document, "paths")).flatMap(([path, operations]) =>
    entries(operations)
      .filter(([method]) => httpMethods.has(method))
      .map(([method, operation]) => ({
        anchor: operationAnchor(path, method),
        method,
        operation,
        operationId: field(operation, "operationId"),
        path,
        tag: optionalField(field(operation, "tags"), "0") ?? "Untagged",
      })),
  );
}

function referenceGroups(entries: Entry[]): Group[] {
  const groups: Group[] = [];
  const byTag = new Map<unknown, Group>();
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

function referencePage(document: unknown, groups: Group[], operationList: Entry[]) {
  const sections = [];
  const schema = errorSchema(document, operationList);

  if (schema) {
    sections.push(
      "## Error responses",
      [
        "Non-success JSON responses use the following envelope.",
        "Each operation lists its supported status codes.",
        "A NUL character or an unpaired UTF-16 surrogate in any request body string,",
        "object key or path parameter is refused with `400 INVALID_REQUEST`.",
        "A JSON body with a value more than 24 levels below its root is refused",
        "with `400 INVALID_REQUEST` and a `TOO_DEEP` detail before it is parsed,",
        "so that answer comes before any other body error.",
        "Operations that take a request body list `413` and `415`. Any request whose",
        "declared body size exceeds the route's limit is refused with",
        "`413 PAYLOAD_TOO_LARGE`, and any POST, PUT, PATCH or DELETE request with a",
        "body that is not JSON with `415 UNSUPPORTED_MEDIA_TYPE`, even on an",
        "operation that takes no body. A query string sent to an operation that lists",
        "no query parameters is refused with `400 INVALID_REQUEST`, except on the",
        "sign-in, sign-out, session and provider operations under `/api/auth`, which",
        "do not refuse one; most operations that take no body refuse a JSON body the",
        "same way.",
        "A detail path longer than 512 characters is cut to its leading whole",
        "segments (or the start of a long first key, keeping whole `~0` and `~1`",
        "escapes). When whole segments were dropped, a contract validation message",
        "says that the cut path contains the offending field. To fit the",
        "256-character message cap, a message cuts long paths (ending them with `…`)",
        "and shows fewer problems before it cuts any problem wording; `details` keeps",
        "the paths.",
      ].join("\n"),
      schemaTable(schema, document),
    );
  }

  sections.push(
    "[Browse interactive examples in the API explorer](api-explorer.md).",
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

  const schemas = entries(optionalField(optionalField(document, "components"), "schemas") ?? {});
  if (schemas.length) {
    sections.push(
      "## Shared schemas",
      "Reusable schema names are referenced by operation request and response tables.",
      [
        "| Schema | Type |",
        "| --- | --- |",
        ...schemas.map(
          ([name, schema]) =>
            `| \`${field(schema, "title") ?? name}\` | \`${schemaType(schema, document)}\` |`,
        ),
      ].join("\n"),
    );
  }

  const titles = sections
    .filter((section) => section.startsWith("## "))
    .map((heading) => heading.slice(3));
  const page = [
    "---\ntags: [nolimit]\n---",
    `# ${field(field(document, "info"), "title")} reference`,
    generatedComment(),
    ...introduction(document),
    tableOfContents(titles),
    ...sections,
  ];
  return `${page.join("\n\n")}\n`;
}

function cheatSheetEntityOrder(title: unknown) {
  const index = cheatSheetEntities.findIndex((entity) => entity.title === title);
  if (index !== -1) {
    return index;
  }

  let lastSibling = -1;
  for (let i = cheatSheetEntities.length - 1; i >= 0; i--) {
    if (cheatSheetEntities[i]?.tag === title) {
      lastSibling = i;
      break;
    }
  }
  return lastSibling === -1 ? cheatSheetEntities.length : lastSibling + 0.5;
}

function cheatSheetOperationOrder({ method, operationId, path }: ValidEntry) {
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

function cheatSheetPage(entries: Entry[]) {
  const groups = new Map<unknown, ValidEntry[]>();
  const operationIds = new Set<string>();
  const operationAnchors = new Map<string, string>();

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
    const operationSummary = field(entry.operation, "summary");
    if (typeof operationSummary !== "string" || !operationSummary.trim()) {
      throw new Error(`Missing OpenAPI summary for ${route}.`);
    }
    const summary = operationSummary.trim().replace(/\s+/g, " ");

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
    groups.get(title)?.push({ ...entry, operationId: entry.operationId, summary });
  }

  const entities = [...groups].sort(
    ([left], [right]) => cheatSheetEntityOrder(left) - cheatSheetEntityOrder(right),
  );
  const sections = [
    "# API cheat sheet",
    generatedComment(),
    tableOfContents(entities.map(([title]) => title)),
    "## Operations",
  ];
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

export function generateApiReferenceOutputs(document: unknown): [Output, Output] {
  const entries = operationEntries(document);
  const groups = referenceGroups(entries);
  const outputs: [Output, Output] = [
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

export function generateApiReference(document: unknown) {
  return generateApiReferenceOutputs(document)[0].content;
}

async function walkMarkdown(directoryUrl: URL): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directoryUrl, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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

export async function unexpectedApiReferenceFiles(outputs: Output[]) {
  const expectedPaths = new Set(outputs.map((output) => output.path));
  return (await walkMarkdown(referenceDirectoryPath)).filter((path) => !expectedPaths.has(path));
}

export async function removeGeneratedApiReferenceDirectory() {
  await rm(referenceDirectoryPath, { recursive: true, force: true });
}

async function run() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
    throw new Error("Usage: node scripts/generate-occ-api-reference.ts [--check]");
  }

  const document: unknown = JSON.parse(await readFile(documentPath, "utf8"));
  const outputs = generateApiReferenceOutputs(document);

  if (arguments_[0] === "--check") {
    for (const output of outputs) {
      const path = resolve(repositoryRoot, output.path);
      let existing;
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(`Missing ${output.path}; run pnpm openapi:generate.`, { cause: error });
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
