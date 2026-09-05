import { STATUS_CODES } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const documentPath = new URL("../packages/contracts/openapi/occ-api.openapi.json", import.meta.url);
const referencePath = new URL("../docs/reference/api.md", import.meta.url);

function schemaType(schema, document) {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    return document.components?.schemas?.[name]?.title ?? name;
  }

  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" or ");
  if (schema.anyOf) {
    return schema.anyOf.map((alternative) => schemaType(alternative, document)).join(" or ");
  }
  if (schema.type === "array") return `array<${schemaType(schema.items ?? {}, document)}>`;
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
  if (!schema?.$ref) return schema;

  if (!schema.$ref.startsWith("#/")) return schema;

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

  if (schema.minLength !== undefined) constraints.push(`min length: ${schema.minLength}`);
  if (schema.maxLength !== undefined) constraints.push(`max length: ${schema.maxLength}`);
  if (schema.minimum !== undefined) constraints.push(`minimum: ${schema.minimum}`);
  if (schema.maximum !== undefined) constraints.push(`maximum: ${schema.maximum}`);
  if (schema.minItems !== undefined) constraints.push(`min items: ${schema.minItems}`);
  if (schema.maxItems !== undefined) constraints.push(`max items: ${schema.maxItems}`);
  if (schema.pattern) constraints.push(`pattern: \`${schema.pattern.replaceAll("|", "\\|")}\``);
  if (schema.default !== undefined) constraints.push(`default: ${JSON.stringify(schema.default)}`);
  if (schema.description) constraints.push(schema.description.replaceAll("|", "\\|"));

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
      if (resolvedItems.properties) rows.push(...schemaRows(resolvedItems, document, `${field}[]`));
    }
  }

  return rows;
}

function schemaTable(schema, document) {
  const resolvedSchema = resolveSchema(schema, document);
  const rows = schemaRows(resolvedSchema, document);
  if (rows.length === 0) return `Schema: \`${schemaType(schema, document)}\`.`;

  return ["| Field | Type | Required | Constraints |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

function operationReference(path, method, operation, document) {
  const sections = [
    `### \`${method.toUpperCase()} ${path}\``,
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
      "#### Parameters",
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
      "#### Request body",
      `**Required:** ${operation.requestBody.required ? "Yes" : "No"}`,
    );

    for (const [contentType, content] of Object.entries(operation.requestBody.content ?? {})) {
      sections.push(`**Content type:** \`${contentType}\``, schemaTable(content.schema, document));
    }
  }

  sections.push(
    "#### Responses",
    [
      "| Status | Meaning |",
      "| --- | --- |",
      ...Object.keys(operation.responses).map((status) => {
        const meaning = STATUS_CODES[status] ?? operation.responses[status].description;
        return `| \`${status}\` | ${meaning} |`;
      }),
    ].join("\n"),
  );

  for (const [status, response] of Object.entries(operation.responses)) {
    if (!status.startsWith("2")) continue;

    for (const [contentType, content] of Object.entries(response.content ?? {})) {
      sections.push(
        `**\`${status}\` response body:** \`${contentType}\``,
        schemaTable(content.schema, document),
      );
    }
  }

  return sections.join("\n\n");
}

export function generateApiReference(document) {
  const operationsByTag = new Map();

  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const tag = operation.tags?.[0] ?? "Other operations";
      if (!operationsByTag.has(tag)) operationsByTag.set(tag, []);
      operationsByTag.get(tag).push(operationReference(path, method, operation, document));
    }
  }

  const sections = [
    `# ${document.info.title} reference`,
    "<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->",
    `Version \`${document.info.version}\`; OpenAPI \`${document.openapi}\`.`,
    [
      "This reference is generated from the",
      "[checked-in OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).",
      "Run `pnpm openapi:generate` after changing an API route or schema;",
      "`pnpm openapi:check` verifies both generated artifacts.",
    ].join("\n"),
    [
      "The exported contract comes from the development-enabled OCC app, which is",
      "why the generated title is `Development OCC API`. Use",
      "`POST /installation/bootstrap` only for development or bootstrap flows",
      "that create the first Installation; production bootstraps through the",
      "[Helm initialization Job](../guides/deploy.md#provision-system-secrets-and-install)",
      "before serving requests.",
      "After bootstrap, production uses the same authenticated controller resource",
      "operations through the selected Drivers and settings described in",
      "[settings](settings.md).",
    ].join("\n"),
    "See [authentication](authentication.md) for supported credentials and their scope.",
  ];

  const errorSchema =
    Object.values(document.paths)
      .flatMap((operations) => Object.values(operations))
      .flatMap((operation) => Object.entries(operation.responses))
      .find(([status, response]) => {
        const schema = resolveSchema(response.content?.["application/json"]?.schema, document);
        return !status.startsWith("2") && schema.properties?.error?.properties?.details;
      })
      ?.at(1).content["application/json"].schema ??
    Object.values(document.paths)
      .flatMap((operations) => Object.values(operations))
      .flatMap((operation) => Object.entries(operation.responses))
      .find(([status, response]) => {
        return !status.startsWith("2") && response.content?.["application/json"]?.schema;
      })
      ?.at(1).content["application/json"].schema;

  if (errorSchema) {
    sections.push(
      "## Error responses",
      [
        "Non-success JSON responses use the following envelope.",
        "Each operation lists its supported status codes.",
      ].join("\n"),
      schemaTable(errorSchema, document),
    );
  }

  for (const [tag, operations] of operationsByTag) {
    sections.push(`## ${tag}`, ...operations);
  }

  if (Object.keys(document.components?.schemas ?? {}).length) {
    sections.push("## Shared schemas");

    for (const [name, schema] of Object.entries(document.components.schemas)) {
      sections.push(
        `### \`${schema.title ?? name}\``,
        `Type: \`${schemaType(schema, document)}\`.`,
      );
    }
  }

  return `${sections.join("\n\n")}\n`;
}

async function run() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
    throw new Error("Usage: node scripts/generate-occ-api-reference.mjs [--check]");
  }

  const document = JSON.parse(await readFile(documentPath, "utf8"));
  const reference = generateApiReference(document);

  if (arguments_[0] === "--check") {
    let existing;
    try {
      existing = await readFile(referencePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("Missing docs/reference/api.md; run pnpm openapi:generate.");
      }
      throw error;
    }

    if (existing !== reference) {
      throw new Error("docs/reference/api.md is out of date; run pnpm openapi:generate.");
    }
    process.stdout.write("API reference is current: docs/reference/api.md\n");
  } else {
    await writeFile(referencePath, reference, "utf8");
    process.stdout.write("Generated API reference: docs/reference/api.md\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await run();
}
