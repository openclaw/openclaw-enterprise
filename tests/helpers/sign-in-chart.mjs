import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseProductionChart } from "./production-chart.mjs";

const execute = promisify(execFile);
export const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";

export { chartTooling } from "./production-chart.mjs";

function templateArguments(overrides) {
  const args = [
    "template",
    "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    "openclaw-system",
    "--values",
    "deploy/examples/production/values.yaml",
  ];
  for (const [key, value] of Object.entries(overrides)) {
    args.push("--set", `${key}=${value}`);
  }
  return args;
}

/** Renders the example install with `--set` overrides and returns the parsed objects. */
export async function renderChart(overrides = {}) {
  const { stdout } = await execute(helm, templateArguments(overrides), {
    cwd: repository,
    maxBuffer: 2_000_000,
  });
  return parseProductionChart(stdout);
}

/**
 * The api.trustedProxy notice that NOTES.txt prints on install and upgrade. `helm template`
 * does not render NOTES.txt, so a copy of the chart renders the same named template into a
 * probe ConfigMap.
 */
export async function trustedProxyNotice(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "occ-chart-notice-"));
  try {
    const chart = join(directory, "openclaw-enterprise");
    await cp(join(repository, "deploy/helm/openclaw-enterprise"), chart, { recursive: true });
    assert.match(
      await readFile(join(chart, "templates/NOTES.txt"), "utf8"),
      /include "openclaw\.trustedProxy\.notice"/,
    );
    await writeFile(
      join(chart, "templates/notice-probe.yaml"),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notice-probe\ndata:\n  notice: {{ include "openclaw.trustedProxy.notice" . | quote }}\n',
    );
    const args = templateArguments(overrides);
    args[2] = chart;
    args.push("--show-only", "templates/notice-probe.yaml");
    const { stdout } = await execute(helm, args, { cwd: repository, maxBuffer: 2_000_000 });
    const match = /notice: (".*")/.exec(stdout);
    assert.ok(match, stdout);
    return JSON.parse(match[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The chart's refusal message for values it must not render. */
export async function chartRefusal(overrides) {
  try {
    await execute(helm, templateArguments(overrides), { cwd: repository, maxBuffer: 2_000_000 });
  } catch (error) {
    return String(error.stderr);
  }
  throw new Error(`The chart rendered ${JSON.stringify(overrides)}.`);
}

export function deploymentEnv(objects, component) {
  const deployment = objects.find(
    ({ kind, metadata }) =>
      kind === "Deployment" && metadata.labels?.["app.kubernetes.io/component"] === component,
  );
  assert.ok(deployment, component);
  return deployment.spec.template.spec.containers[0].env;
}

/** The API Pod's sign-in settings: literal values, or the Secret keys they come from. */
export function signInSettings(env) {
  return Object.fromEntries(
    env
      .filter(({ name }) => /^OCC_(AUTH_|AGENT_NATIVE_ADMIN_|GATEWAY_API_KEY_PATH$)/.test(name))
      .map(({ name, value, valueFrom }) => [
        name,
        value ?? { secretKeyRef: valueFrom.secretKeyRef },
      ]),
  );
}
