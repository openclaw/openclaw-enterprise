import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import { loadTestSuites } from "../../scripts/ci/test-suites.ts";
import { readJsonLines } from "../helpers/json-lines.mjs";
import { loadYaml, yamlMapping } from "../helpers/kubernetes-yaml.ts";

type SuiteFile = Record<string, unknown> & { path: string; expectedTests?: string[] };
type SuiteLane = Record<string, unknown> & {
  files: SuiteFile[];
  env?: Record<string, string>;
  requiredEnv?: string[];
  prepare?: Record<string, unknown>;
};
type Suites = { lanes: Record<string, SuiteLane>; groups: Record<string, string[]> };

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
function stringRecord(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((item) => typeof item === "string");
}
function suiteFile(value: unknown): value is SuiteFile {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.path === "string" &&
    (record.expectedTests === undefined || strings(record.expectedTests))
  );
}
function suiteLane(value: unknown): value is SuiteLane {
  const record = asRecord(value);
  return (
    record !== undefined &&
    Array.isArray(record.files) &&
    record.files.every(suiteFile) &&
    (record.env === undefined || stringRecord(record.env)) &&
    (record.requiredEnv === undefined || strings(record.requiredEnv)) &&
    (record.prepare === undefined || asRecord(record.prepare) !== undefined)
  );
}
function suites(value: unknown): value is Suites {
  const record = asRecord(value);
  const lanes = asRecord(record?.lanes);
  const groups = asRecord(record?.groups);
  return (
    lanes !== undefined &&
    groups !== undefined &&
    Object.values(lanes).every(suiteLane) &&
    Object.values(groups).every(strings)
  );
}
export function loadSuites(path: string): Suites {
  const value = loadTestSuites(path);
  assert.ok(suites(value), "invalid test suite manifest");
  return value;
}
export function getLane(manifest: Suites, name: string): SuiteLane {
  const lane = manifest.lanes[name];
  assert.ok(lane, "missing lane " + name);
  return lane;
}
export function getGroup(manifest: Suites, name: string): string[] {
  const group = manifest.groups[name];
  assert.ok(group, "missing group " + name);
  return group;
}

export type WorkflowStep = Record<string, unknown>;
export type WorkflowJob = Record<string, unknown>;
export type Workflow = Record<string, unknown> & { jobs: Record<string, unknown> };

function step(value: unknown): value is WorkflowStep {
  return asRecord(value) !== undefined;
}
function workflow(value: unknown): value is Workflow {
  return asRecord(asRecord(value)?.jobs) !== undefined;
}
export function parseWorkflow(text: string): Workflow {
  const value = loadYaml(text);
  assert.ok(workflow(value), "invalid workflow");
  return value;
}
export function getJob(value: Workflow, name: string): WorkflowJob {
  const result = asRecord(value.jobs[name]);
  assert.ok(result, "invalid workflow job " + name);
  return result;
}
export function getSteps(value: WorkflowJob): WorkflowStep[] {
  const steps = value.steps;
  assert.ok(Array.isArray(steps) && steps.every(step), "invalid workflow steps");
  return steps;
}
export function parseActionSteps(text: string): WorkflowStep[] {
  const steps: unknown = yamlMapping(loadYaml(text), "runs").steps;
  assert.ok(Array.isArray(steps) && steps.every(step), "invalid action steps");
  return steps;
}
export function collectorImage(text: string): string {
  const image = yamlMapping(loadYaml(text), "services", "collector").image;
  assert.ok(typeof image === "string");
  return image;
}
export async function readCommandLines(
  ...args: Parameters<typeof readJsonLines>
): Promise<string[][]> {
  const rows = await readJsonLines(...args);
  assert.ok(rows.every(strings), "invalid command log");
  return rows;
}
export function tuples<const T extends readonly unknown[]>(rows: T[]): T[] {
  return rows;
}
