import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { array, record } from "./full-integration-json-fixture.ts";

const kubernetes: unknown = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");
const loadYaml = record(kubernetes).loadYaml;

type Job = Record<string, unknown> & {
  steps?: Record<string, unknown>[];
  needs?: string | string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isJob(value: unknown): value is Job {
  return (
    isRecord(value) &&
    (value.steps === undefined || (Array.isArray(value.steps) && value.steps.every(isRecord))) &&
    (value.needs === undefined ||
      typeof value.needs === "string" ||
      (Array.isArray(value.needs) &&
        value.needs.every((name: unknown) => typeof name === "string")))
  );
}

function parseYaml(source: string) {
  assert.ok(typeof loadYaml === "function");
  return record(loadYaml(source));
}

export function parseWorkflow(source: string) {
  const workflow = parseYaml(source);
  const jobs = Object.fromEntries(
    Object.entries(record(workflow.jobs)).map(([name, job]) => {
      assert.ok(isJob(job), `Invalid job ${name}`);
      return [name, job];
    }),
  );
  return {
    ...workflow,
    on: workflow.on,
    jobs,
    concurrency: workflow.concurrency,
    env: workflow.env,
    permissions: workflow.permissions,
  };
}

export async function readWorkflow(name: string) {
  return parseWorkflow(
    await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
  );
}

export async function readLaneAction() {
  const action = parseYaml(
    await readFile(
      new URL("../../.github/actions/run-ci-lane/action.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = array(record(action.runs).steps);
  assert.ok(steps.every(isRecord));
  return steps;
}
