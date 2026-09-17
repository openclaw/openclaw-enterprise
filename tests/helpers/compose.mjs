import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));

export function commandPath(name) {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // PATH entries may be absent or inaccessible; continue like executable lookup.
    }
  }
  return "";
}

export function composeConfigurationProvider() {
  const cleanEnvironment = {
    PATH: process.env.PATH,
  };
  const docker = commandPath("docker");
  if (docker) {
    const result = spawnSync(
      docker,
      ["compose", "--env-file", "/dev/null", "config", "--format", "json"],
      {
        cwd: repository,
        env: cleanEnvironment,
        encoding: "utf8",
      },
    );
    if (result.status === 0) return { command: docker, prefix: ["compose"], format: "json" };
  }
  const podmanCompose = commandPath("podman-compose");
  const yq = commandPath("yq");
  assert.ok(
    podmanCompose,
    "Docker Compose or podman-compose is required for Compose packaging tests",
  );
  assert.ok(yq, "yq is required when Compose packaging tests use podman-compose");
  return { command: podmanCompose, prefix: [], format: "yaml", yq };
}

export function composeConfiguration(files = ["compose.yaml"], environment = {}) {
  const provider = composeConfigurationProvider();
  const args = [
    ...provider.prefix,
    ...files.flatMap((file) => ["--file", file]),
    "--env-file",
    "/dev/null",
    "config",
  ];
  if (provider.format === "json") args.push("--format", "json");
  const rendered = spawnSync(provider.command, args, {
    cwd: repository,
    env: { PATH: process.env.PATH, ...environment },
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  assert.equal(rendered.status, 0, rendered.error?.message ?? rendered.stderr);
  if (provider.format === "json") return JSON.parse(rendered.stdout);
  const converted = spawnSync(provider.yq, ["-o=json"], {
    input: rendered.stdout,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  assert.equal(converted.status, 0, converted.error?.message ?? converted.stderr);
  return JSON.parse(converted.stdout);
}
