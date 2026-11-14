import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import { createRouteGenerationApp } from "../apps/controller/src/route-generation-app.ts";
import { documentApiExamples } from "./document-api-examples.ts";
import {
  generateApiReferenceOutputs,
  removeGeneratedApiReferenceDirectory,
  unexpectedApiReferenceFiles,
} from "./generate-occ-api-reference.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = fileURLToPath(
  new URL("../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
);

// Copy nested values before stringifying so JSON keeps its usual integer-key ordering.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map(sortKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => {
        if (left < right) {
          return -1;
        }
        return left > right ? 1 : 0;
      })
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

async function generateDocument() {
  const app = createRouteGenerationApp(64 * 1024);

  let document;
  try {
    await app.ready();
    document = documentApiExamples(app.swagger());
  } finally {
    await app.close();
  }

  const options = (await resolveConfig(outputPath)) ?? {};
  return format(JSON.stringify(sortKeys(document)), {
    ...options,
    filepath: outputPath,
    parser: "json",
  });
}

const arguments_ = process.argv.slice(2);
const check = arguments_[0] === "--check";
if (arguments_.length > 1 || (arguments_.length === 1 && !check)) {
  throw new Error("Usage: node scripts/generate-occ-openapi.ts [--check]");
}

const document = await generateDocument();
const parsedDocument: unknown = JSON.parse(document);
const referenceOutputs = generateApiReferenceOutputs(parsedDocument);
const outputs = [
  { label: "OpenAPI contract", path: outputPath, content: document },
  ...referenceOutputs.map((output) => ({
    label: output.label,
    path: resolve(repositoryRoot, output.path),
    content: output.content,
  })),
];

if (!check) {
  await removeGeneratedApiReferenceDirectory();
}

for (const output of outputs) {
  const outputName = relative(repositoryRoot, output.path);

  if (check) {
    let existing: string;
    try {
      existing = await readFile(output.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Missing ${outputName}; run pnpm openapi:generate.`, { cause: error });
      }
      throw error;
    }

    if (existing !== output.content) {
      throw new Error(`${outputName} is out of date; run pnpm openapi:generate.`);
    }
    process.stdout.write(`${output.label} is current: ${outputName}\n`);
  } else {
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, output.content, "utf8");
    process.stdout.write(`Generated ${output.label}: ${outputName}\n`);
  }
}

if (check) {
  const unexpected = await unexpectedApiReferenceFiles(referenceOutputs);
  if (unexpected.length) {
    throw new Error(
      `Unexpected generated API reference file: ${unexpected.join(", ")}; run pnpm openapi:generate.`,
    );
  }
}
