import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { ChartValues } from "./production-chart-network-fixture.ts";
import { goToolEnvironment, parseProductionChart } from "./production-chart.mjs";
import { findResource } from "./production-chart-resource.ts";

const execute = promisify(execFile);
export const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
const chartPath = "deploy/helm/openclaw-enterprise";

export { chartTooling } from "./production-chart.mjs";

function templateArguments(overrides: ChartValues, chart = chartPath): string[] {
  const args = [
    "template",
    "oce",
    chart,
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

function renderTemplate(args: string[]) {
  return execute(helm, args, {
    cwd: repository,
    env: goToolEnvironment(),
    maxBuffer: 2_000_000,
  });
}

type ChartResource = {
  kind: string;
  metadata: { name: string };
  spec: unknown;
};

function record(value: unknown, label: string): Record<string, unknown> {
  const entry = asRecord(value);
  assert.ok(entry, `${label} must be an object.`);
  return entry;
}

function array(value: unknown, label: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string.`);
  return value;
}

/** Renders the example install with `--set` overrides and returns its named resources. */
export async function renderChart(overrides: ChartValues = {}): Promise<ChartResource[]> {
  const { stdout } = await renderTemplate(templateArguments(overrides));
  let parsed: unknown;
  try {
    parsed = await parseProductionChart(stdout);
  } catch (error) {
    throw new Error("Could not parse the rendered chart with yq.", { cause: error });
  }
  return array(parsed, "Rendered chart").map((value, index) => {
    const label = `Rendered chart resource ${index + 1}`;
    const { kind, metadata, spec } = record(value, label);
    return {
      kind: string(kind, `${label} kind`),
      metadata: { name: string(record(metadata, `${label} metadata`).name, `${label} name`) },
      spec,
    };
  });
}

/**
 * `helm template` omits NOTES.txt. Copy the chart once and render the same named
 * template into a probe ConfigMap. The caller removes the copy after all work settles.
 */
export function trustedProxyNoticeRenderer(directory: string) {
  let copied: Promise<void> | undefined;
  const chart = join(directory, "openclaw-enterprise");
  const copy = async () => {
    await cp(join(repository, chartPath), chart, { recursive: true });
    assert.match(
      await readFile(join(chart, "templates/NOTES.txt"), "utf8"),
      /include "openclaw\.trustedProxy\.notice"/,
    );
    await writeFile(
      join(chart, "templates/notice-probe.yaml"),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notice-probe\ndata:\n  notice: {{ include "openclaw.trustedProxy.notice" . | quote }}\n',
    );
  };
  return async (overrides: ChartValues = {}): Promise<string> => {
    copied ??= copy();
    await copied;
    const args = templateArguments(overrides, chart);
    args.push("--show-only", "templates/notice-probe.yaml");
    const { stdout } = await renderTemplate(args);
    const notice = /notice: (".*")/.exec(stdout)?.[1];
    assert.ok(notice, "The chart did not render the proxy notice.");
    const parsed: unknown = JSON.parse(notice);
    return string(parsed, "Proxy notice");
  };
}

/** Return Helm's validation message, keeping spawn and signal failures distinct. */
export async function chartRefusal(overrides: ChartValues): Promise<string> {
  try {
    await renderTemplate(templateArguments(overrides));
  } catch (error) {
    const failure = asRecord(error);
    if (typeof failure?.code === "number" && typeof failure.stderr === "string") {
      return failure.stderr;
    }
    throw error;
  }
  assert.fail("The chart unexpectedly rendered the refused settings.");
}

type SecretKeyReference = { secretKeyRef: { name: string; key: string } };
type EnvironmentEntry = { name: string } & (
  | { value: string; valueFrom?: never }
  | { value?: never; valueFrom: SecretKeyReference | { fieldRef: { fieldPath: string } } }
);
export type SignInSettings = Readonly<Record<string, string | SecretKeyReference>>;

function secretKeyReference(value: unknown, label: string): SecretKeyReference {
  const reference = asRecord(value);
  const name = reference?.name;
  const key = reference?.key;
  assert.ok(
    typeof name === "string" && name.length > 0 && typeof key === "string" && key.length > 0,
    `${label} must specify a Secret name and key.`,
  );
  assert.deepEqual(
    Object.keys(reference ?? {}).sort(),
    ["key", "name"],
    `${label} required Secret key reference`,
  );
  return { secretKeyRef: { name, key } };
}

function environmentEntry(value: unknown, label: string): EnvironmentEntry {
  const entry = record(value, label);
  const name = string(entry.name, `${label} name`);
  if (entry.valueFrom === undefined) {
    return { name, value: string(entry.value, `${label} ${name} value`) };
  }
  assert.equal(entry.value, undefined, `${label} ${name} must have only valueFrom.`);
  const source = record(entry.valueFrom, `${label} ${name} valueFrom`);
  if (source.secretKeyRef !== undefined) {
    assert.deepEqual(Object.keys(source), ["secretKeyRef"], `${label} ${name} source`);
    return { name, valueFrom: secretKeyReference(source.secretKeyRef, `${label} ${name}`) };
  }
  assert.deepEqual(Object.keys(source), ["fieldRef"], `${label} ${name} source`);
  const { fieldPath } = record(source.fieldRef, `${label} ${name} fieldRef`);
  return {
    name,
    valueFrom: { fieldRef: { fieldPath: string(fieldPath, `${label} ${name} fieldPath`) } },
  };
}

function podSpec(resource: ChartResource, label: string) {
  const template = record(record(resource.spec, `${label} spec`).template, `${label} template`);
  return record(template.spec, `${label} Pod spec`);
}

function namedObject(value: unknown, name: string, label: string) {
  const entries = array(value, label).map((entry) => {
    const object = record(entry, label);
    return { name: string(object.name, `${label} name`), object };
  });
  const matches = entries.filter((entry) => entry.name === name);
  const [match] = matches;
  assert.ok(matches.length === 1 && match, `${label} must contain exactly one ${name}.`);
  return match.object;
}

function containerEnv(container: Record<string, unknown>, label: string) {
  return array(container.env, `${label} environment`).map((entry) =>
    environmentEntry(entry, `${label} environment`),
  );
}

type Component = "api" | "worker";

function deployment(objects: readonly ChartResource[], component: Component) {
  const name = `openclaw-enterprise-${component}`;
  const resource = findResource(objects, "Deployment", name);
  assert.ok(resource, `The chart must render Deployment ${name}.`);
  const pod = podSpec(resource, name);
  const container = namedObject(pod.containers, component, `${name} containers`);
  return { pod, container, name };
}

export function deploymentEnv(objects: readonly ChartResource[], component: Component) {
  const { container, name } = deployment(objects, component);
  return containerEnv(container, name);
}

export function bootstrapEnv(objects: readonly ChartResource[]) {
  const name = "oce-initialization";
  const job = findResource(objects, "Job", name);
  assert.ok(job, `The chart must render Job ${name}.`);
  const { containers } = podSpec(job, name);
  return containerEnv(namedObject(containers, "bootstrap", `${name} containers`), name);
}

/** The API Pod's sign-in settings: literal values or the keys of mounted Secrets. */
export function signInSettings(env: readonly EnvironmentEntry[]): SignInSettings {
  const settings: Record<string, string | SecretKeyReference> = {};
  for (const entry of env) {
    if (!/^OCC_(AUTH_|AGENT_NATIVE_ADMIN_|GATEWAY_API_KEY_PATH$)/.test(entry.name)) {
      continue;
    }
    if (entry.valueFrom === undefined) {
      settings[entry.name] = entry.value;
    } else {
      assert.ok("secretKeyRef" in entry.valueFrom, `${entry.name} must name a Secret key.`);
      settings[entry.name] = entry.valueFrom;
    }
  }
  return settings;
}

export function loginEgress(objects: readonly ChartResource[]) {
  return objects.flatMap(({ kind, metadata, spec }) => {
    const provider = /-api-(google|oidc)-login-egress$/.exec(metadata.name)?.[1];
    if (kind !== "NetworkPolicy" || (provider !== "google" && provider !== "oidc")) {
      return [];
    }
    return [
      { provider, rules: array(record(spec, metadata.name).egress, `${metadata.name} egress`) },
    ];
  });
}

export function egressPeers(rule: unknown) {
  return array(record(rule, "Egress rule").to, "Egress peers");
}

export function egressCidr(peer: unknown) {
  const ipBlock = record(peer, "Egress peer").ipBlock;
  if (ipBlock !== undefined) {
    return string(record(ipBlock, "Egress IP block").cidr, "Egress CIDR");
  }
}

export function assertSecretMount(
  objects: readonly ChartResource[],
  component: Component,
  expected: {
    volume: string;
    secret: string;
    key: string;
    itemPath: string;
    mountPath: string;
    variable: string;
  },
) {
  const { pod, container, name } = deployment(objects, component);
  const volume = namedObject(pod.volumes, expected.volume, `${name} volumes`);
  const mount = namedObject(container.volumeMounts, expected.volume, `${name} mounts`);
  const label = `${name} ${expected.volume}`;
  assert.deepEqual(
    volume.secret,
    {
      secretName: expected.secret,
      items: [{ key: expected.key, path: expected.itemPath }],
    },
    `${label} Secret volume`,
  );
  assert.equal(mount.mountPath, expected.mountPath, `${label} mount path`);
  assert.equal(mount.readOnly, true, `${label} mount must be read-only`);
  assert.deepEqual(
    containerEnv(container, name).filter(({ name }) => name === expected.variable),
    [{ name: expected.variable, value: `${expected.mountPath}/${expected.itemPath}` }],
    `${label} file environment`,
  );
  assert.equal(pod.serviceAccountName, name, `${label} service account`);
  assert.ok(
    findResource(objects, "ServiceAccount", name),
    `The chart must render ServiceAccount ${name}.`,
  );
}
