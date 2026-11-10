import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientConfiguration } from "./config.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
  requireCurrentBinding,
  type RuntimeRepositoryBinding,
} from "./manifest.ts";
import { readPrivateFile } from "./private-files.ts";
import { selectGitCredential } from "./targets.ts";

async function readCredentialRequest(): Promise<ReadonlyMap<string, string>> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16 * 1024) {
      throw new Error("invalid-helper-request");
    }
  }
  if (
    [...input].some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 0x1f && code !== 0x0a) || code === 0x7f;
    }) ||
    !input.endsWith("\n")
  ) {
    throw new Error("invalid-helper-request");
  }
  const lines = input.split("\n");
  lines.pop();
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.some((line) => !line)) {
    throw new Error("invalid-helper-request");
  }
  const fields = new Map<string, string>();
  for (const line of lines) {
    const offset = line.indexOf("=");
    if (offset < 1 || line.includes("\r") || line.includes("\0")) {
      throw new Error("invalid-helper-request");
    }
    const key = line.slice(0, offset);
    if (fields.has(key) && key !== "capability[]" && key !== "wwwauth[]") {
      throw new Error("invalid-helper-request");
    }
    if (
      ![
        "protocol",
        "host",
        "path",
        "username",
        "password",
        "password_expiry_utc",
        "oauth_refresh_token",
        "capability[]",
        "wwwauth[]",
      ].includes(key)
    ) {
      throw new Error("invalid-helper-request");
    }
    fields.set(key, line.slice(offset + 1));
  }

  return fields;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const aggregate = args[0] === "manifest";
  const [directory, expectedGeneration, operation] = aggregate
    ? args.slice(1)
    : [args[0], undefined, args[1]];
  if (
    !directory ||
    args.length !== (aggregate ? 4 : 2) ||
    !["get", "store", "erase"].includes(operation ?? "")
  ) {
    throw new Error("invalid-helper-request");
  }
  // Git may ask to store or erase after an exchange. Neither operation changes authority.
  if (operation !== "get") {
    return;
  }
  const fields = await readCredentialRequest();
  let binding: RuntimeRepositoryBinding;
  if (aggregate) {
    const manifest = await readRuntimeRepositoryManifest(directory);
    if (expectedGeneration !== manifest.generation) {
      throw new Error("invalid-repository-selection");
    }
    binding = selectGitCredential(
      manifest,
      fields,
      inheritedRepositoryBinding(manifest, process.env),
    );
  } else {
    const configuration = await readClientConfiguration(directory);
    const single: RuntimeRepositoryBinding = {
      repositoryRef: "operator",
      sessionId: configuration.sessionId,
      deadlineWallMs: configuration.deadlineWallMs,
      directory: resolve(directory),
      materialDirectory: resolve(directory),
      client: configuration.client,
      configuration,
    };
    binding = selectGitCredential({ generation: "", bindings: [single] }, fields);
  }
  requireCurrentBinding(binding);
  const bytes = await readPrivateFile(join(binding.directory, "bearer"), 256);
  try {
    requireCurrentBinding(binding);
    const bearer = bytes.toString("utf8");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(bearer)) {
      throw new Error("invalid-client-bearer");
    }
    process.stdout.write(`username=${binding.client.gitUsername}\npassword=${bearer}\n\n`);
  } finally {
    bytes.fill(0);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timer = setTimeout(() => {
    process.stderr.write("credential-helper-timeout\n");
    process.exit(1);
  }, 5000);
  run()
    .catch(() => {
      process.stderr.write("credential-helper-failed\n");
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(timer));
}
