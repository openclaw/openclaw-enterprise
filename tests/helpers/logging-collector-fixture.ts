import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { asRecord } from "../../packages/utils/src/index.ts";
import { readDefaultCollectorImage } from "../../scripts/ci/logging.ts";
import { completeJsonLines, selectedCollectorSmoke as selected } from "./ci-logging.ts";

const exec = promisify(execFile);
const nodeImage = process.env.OCC_TEST_LOGGING_NODE_IMAGE ?? "docker.io/library/node:24-bookworm";
const root = new URL("../../", import.meta.url).pathname;

async function docker(args: string[]) {
  return (await exec("docker", args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

// A timeout or failed check names the outcome it waited for and, given the
// fixture, the state of the Collector and backend containers with the Collector's
// last log lines, so a CI failure shows which step stalled and whether a container
// had stopped.
async function waitFor(
  outcome: string,
  check: () => boolean | Promise<boolean>,
  fixture?: Pick<Awaited<ReturnType<typeof collectorFixture>>, "describe">,
) {
  const deadline = Date.now() + 30_000;
  // The deadline is checked after each check, so the last check happens at or past it.
  for (;;) {
    let done;
    try {
      done = await check();
    } catch (error) {
      const state = fixture ? ` ${await fixture.describe()}` : "";
      throw new Error(
        `Waiting for ${outcome} failed: ${error instanceof Error ? error.message : String(error)}.${state}`,
        {
          cause: error,
        },
      );
    }
    if (done) {
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(100);
  }
  const state = fixture ? ` ${await fixture.describe()}` : "";
  assert.fail(`Timed out waiting for ${outcome}.${state}`);
}

type StartCollectorOptions = {
  receiverPath: string;
  publish: string[];
  env?: string[];
  volumes?: string[];
  configs?: string[];
};

async function collectorFixture(t: TestContext, prefix: string) {
  const suffix = randomUUID().slice(0, 8);
  const network = `oce-otel-${prefix}-${suffix}`;
  const backend = `oce-otel-${prefix}-backend-${suffix}`;
  const collector = `oce-otel-${prefix}-collector-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), `occ-collector-${prefix}-`));
  const out = join(directory, "out");
  const state = join(directory, "state");
  await mkdir(out);
  await mkdir(state);
  const image = await readDefaultCollectorImage(root);
  assert.ok(
    process.getuid && process.getgid,
    "the Collector Docker fixture requires POSIX user IDs",
  );
  const user = `${process.getuid()}:${process.getgid()}`;
  await writeFile(
    join(directory, "backend.yaml"),
    `receivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\nexporters:\n  file:\n    path: /out/logs.jsonl\nservice:\n  telemetry:\n    logs:\n      level: error\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [file]\n`,
  );
  let networkCreated = false;
  // node:test runs after hooks in registration order, so this hook runs before any hook a
  // test adds for a container it attaches to the network later. Remove every container on
  // the network (backend, Collector and those test fixtures) before the network itself:
  // Docker refuses to remove a network with attached containers, and each leaked network
  // keeps an address pool until Compose networks on the host find none left. A failed
  // removal fails the test instead of leaking silently.
  t.after(async () => {
    try {
      if (networkCreated) {
        const attached = await docker(["ps", "--all", "--quiet", "--filter", `network=${network}`]);
        if (attached.length > 0) {
          await docker(["rm", "--force", ...attached.split("\n")]);
        }
        await docker(["network", "rm", network]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await docker(["network", "create", network]);
  networkCreated = true;
  await docker([
    "run",
    "--detach",
    "--name",
    backend,
    "--network",
    network,
    "--user",
    user,
    "--volume",
    `${join(directory, "backend.yaml")}:/etc/otel/backend.yaml:ro`,
    "--volume",
    `${out}:/out`,
    image,
    "--config=/etc/otel/backend.yaml",
  ]);
  return {
    suffix,
    directory,
    out,
    backend,
    collector,
    network,
    async startCollector({
      receiverPath,
      publish,
      env = [],
      volumes = [],
      configs = [],
    }: StartCollectorOptions) {
      const args = ["run", "--detach", "--name", collector, "--network", network, "--user", user];
      for (const port of publish) {
        args.push("--publish", port);
      }
      for (const entry of env) {
        args.push("--env", entry);
      }
      for (const volume of volumes) {
        args.push("--volume", volume);
      }
      configs.forEach((path, index) =>
        args.push("--volume", `${path}:/etc/otel/extra-${index}.yaml:ro`),
      );
      args.push(
        "--env",
        `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://${backend}:4318/v1/logs`,
        "--volume",
        `${join(root, "deploy/logging/collector.yaml")}:/etc/otel/collector.yaml:ro`,
        "--volume",
        `${join(root, "deploy/logging/exporter.yaml")}:/etc/otel/exporter.yaml:ro`,
        "--volume",
        `${receiverPath}:/etc/otel/receiver.yaml:ro`,
        "--volume",
        `${state}:/var/lib/otelcol`,
        image,
        "--config=/etc/otel/collector.yaml",
        "--config=/etc/otel/receiver.yaml",
        "--config=/etc/otel/exporter.yaml",
        ...configs.map((_, index) => `--config=/etc/otel/extra-${index}.yaml`),
      );
      await docker(args);
    },
    port(containerPort: number) {
      return docker(["port", collector, `${containerPort}/tcp`]);
    },
    async describe() {
      const states = [];
      for (const [role, name] of [
        ["Collector", collector],
        ["backend", backend],
      ] as const) {
        const state = await exec(
          "docker",
          ["inspect", "--format", "{{.State.Status}} (exit {{.State.ExitCode}})", name],
          { timeout: 10_000 },
        )
          .then(({ stdout }) => stdout.trim())
          .catch(() => "absent");
        states.push(`${role} ${state}`);
      }
      // The Collector logs at error level, so these are its recent failures.
      const log = await exec("docker", ["logs", "--tail", "5", collector], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
        .then(({ stdout, stderr }) => `${stdout}${stderr}`.trim())
        .catch(
          (error: unknown) =>
            `unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      return `${states.join(", ")}; Collector log: ${log.slice(-800) || "empty"}`;
    },
  };
}

function otlpObject(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, "expected an OTLP object");
  return record;
}

function otlpArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected an OTLP array");
  return value;
}

function attributeEntries(entries: unknown = []): [string, Record<string, unknown>][] {
  return otlpArray(entries).map((entry) => {
    const { key, value } = otlpObject(entry);
    assert.ok(typeof key === "string", "expected an OTLP attribute key");
    return [key, otlpObject(value)];
  });
}

function attributes(entries?: unknown): Record<string, string | number | boolean | undefined> {
  return Object.fromEntries(
    attributeEntries(entries).map(([key, { stringValue, intValue, boolValue }]) => {
      const scalar = stringValue ?? intValue ?? boolValue;
      assert.ok(
        scalar === undefined ||
          typeof scalar === "string" ||
          typeof scalar === "number" ||
          typeof scalar === "boolean",
        "expected a scalar OTLP attribute value",
      );
      return [key, scalar];
    }),
  );
}

async function exportedRecords<T>(
  out: string,
  mapRecord: (resource: Record<string, unknown>, record: Record<string, unknown>) => T,
): Promise<T[]> {
  let text;
  try {
    text = await readFile(join(out, "logs.jsonl"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return completeJsonLines(text).flatMap((payload) =>
    otlpArray(otlpObject(payload).resourceLogs).flatMap((resourceLogs) => {
      const resource = otlpObject(resourceLogs);
      return otlpArray(resource.scopeLogs).flatMap((scope) =>
        otlpArray(otlpObject(scope).logRecords).map((record) =>
          mapRecord(resource, otlpObject(record)),
        ),
      );
    }),
  );
}

export {
  attributeEntries,
  attributes,
  collectorFixture,
  docker,
  exportedRecords,
  nodeImage,
  otlpObject,
  root,
  selected,
  waitFor,
};
