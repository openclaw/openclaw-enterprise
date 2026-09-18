import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import { createFastifyApp } from "../apps/controller/src/index.ts";
import {
  generateApiReferenceOutputs,
  removeGeneratedApiReferenceDirectory,
  unexpectedApiReferenceFiles,
} from "./generate-occ-api-reference.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = fileURLToPath(
  new URL("../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
);
const documentationInstallationId = "ins_6054d30d-0f89-4cd0-aa56-2b76e3c5fb52";

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

async function generateDocument() {
  const app = createFastifyApp({
    development: {
      enabled: true,
      installationId: documentationInstallationId,
    },
    maxBodyBytes: 64 * 1024,
  });

  let document;
  try {
    await app.ready();
    document = app.swagger();
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
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
  throw new Error("Usage: node scripts/generate-occ-openapi.mjs [--check]");
}

const document = await generateDocument();
const referenceOutputs = generateApiReferenceOutputs(JSON.parse(document));
const outputs = [
  { label: "OpenAPI contract", path: outputPath, content: document },
  ...referenceOutputs.map((output) => ({
    label: output.label,
    path: resolve(repositoryRoot, output.path),
    content: output.content,
  })),
];

if (arguments_[0] !== "--check") {
  await removeGeneratedApiReferenceDirectory();
}

for (const output of outputs) {
  const outputName = relative(repositoryRoot, output.path);

  if (arguments_[0] === "--check") {
    let existing;
    try {
      existing = await readFile(output.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Missing ${outputName}; run pnpm openapi:generate.`);
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

if (arguments_[0] === "--check") {
  const unexpected = await unexpectedApiReferenceFiles(referenceOutputs);
  if (unexpected.length) {
    throw new Error(
      `Unexpected generated API reference file: ${unexpected.join(", ")}; run pnpm openapi:generate.`,
    );
  }
}
