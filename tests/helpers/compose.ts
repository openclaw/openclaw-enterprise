import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { asRecord } from "../../packages/utils/src/index.ts";

type ComposeConfigurationProvider =
  | { command: string; prefix: ["compose"]; format: "json" }
  | { command: string; prefix: []; format: "yaml"; yq: string };

interface ComposeConfiguration extends Record<string, unknown> {
  services?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}

export const browserEnvironment = {
  OCC_DEVELOPMENT_BROWSER_ORIGIN: "https://console.development.oce.localhost:8443",
  OCC_DEVELOPMENT_AGENT_NATIVE_ADMIN_DOMAIN: "agents.development.oce.localhost",
};

const repository = fileURLToPath(new URL("../..", import.meta.url));

export function commandPath(name: string): string {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // PATH entries may be absent or inaccessible; continue like executable lookup.
    }
  }
  return "";
}

export function composeConfigurationProvider(): ComposeConfigurationProvider {
  const cleanEnvironment = {
    PATH: process.env.PATH,
    ...browserEnvironment,
    OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: "/tmp/occ-packaging-admin-password",
    OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: "/tmp/occ-packaging-admin-service-key",
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
    if (result.status === 0) {
      return { command: docker, prefix: ["compose"], format: "json" };
    }
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

function isComposeConfiguration(value: unknown): value is ComposeConfiguration {
  const document = asRecord(value);
  return (
    document !== undefined &&
    (document.services === undefined || asRecord(document.services) !== undefined) &&
    (document.volumes === undefined || asRecord(document.volumes) !== undefined)
  );
}

export function composeConfiguration(
  files: readonly string[] = ["compose.yaml"],
  environment: NodeJS.ProcessEnv = {},
): ComposeConfiguration {
  const provider = composeConfigurationProvider();
  const args = [
    ...provider.prefix,
    ...files.flatMap((file) => ["--file", file]),
    "--env-file",
    "/dev/null",
    "config",
  ];
  if (provider.format === "json") {
    args.push("--format", "json");
  }
  const rendered = spawnSync(provider.command, args, {
    cwd: repository,
    env: {
      PATH: process.env.PATH,
      ...browserEnvironment,
      OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: "/tmp/occ-packaging-admin-password",
      OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: "/tmp/occ-packaging-admin-service-key",
      ...environment,
    },
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  assert.equal(rendered.status, 0, rendered.error?.message ?? rendered.stderr);
  let json = rendered.stdout;
  if (provider.format === "yaml") {
    const converted = spawnSync(provider.yq, ["-o=json"], {
      input: rendered.stdout,
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
    assert.equal(converted.status, 0, converted.error?.message ?? converted.stderr);
    json = converted.stdout;
  }
  const configuration: unknown = JSON.parse(json);
  assert.ok(isComposeConfiguration(configuration), "Expected a rendered Compose configuration");
  return configuration;
}
