import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  chartTooling,
  parseProductionChart,
  productionValues,
  renderProductionChart,
} from "../helpers/production-chart.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

type Labels = Record<string, string | number | null>;
type Resource = { kind: string; metadata: { name: string } };
type Container = { name: string; envFrom?: unknown };
type Job = Resource & {
  metadata: { labels: Labels };
  spec: {
    template: {
      metadata: { labels: Labels };
      spec: {
        initContainers?: Container[];
        containers: Container[];
      };
    };
  };
};
type Policy = Resource & { spec: { podSelector: { matchLabels: Labels } } };

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL("../../scripts/upgrade-startup-preflight.ts", import.meta.url),
);

test(
  "migration preflight preserves labels and refuses ambiguous initialization Jobs",
  await chartTooling(),
  async (t) => {
    const release = "preflight-test";
    const { stdout } = await renderProductionChart({}, { isUpgrade: true, release });
    const resources: Resource[] = await parseProductionChart(stdout);
    const initializer = resources.find(
      ({ kind, metadata }) => kind === "Job" && metadata.name === `${release}-initialization`,
    ) as Job | undefined;
    const deny = resources.find(
      ({ kind, metadata }) =>
        kind === "NetworkPolicy" && metadata.name === "openclaw-enterprise-default-deny",
    ) as Policy | undefined;
    assert.ok(initializer);
    assert.ok(deny);
    const directory = await temporaryDirectory(t, "migration-preflight-");
    const input = join(directory, "chart.jsonl");
    const customLabel = "example.invalid/upgrade";
    const nullableLabel = "example.invalid/presence";
    const withInitializer = (job: Job) =>
      resources.map((resource) => (resource === initializer ? job : resource));

    async function generate(action: string, rendered: Resource[]) {
      await writeFile(input, rendered.map((resource) => JSON.stringify(resource)).join("\n"));
      return execute(process.execPath, [
        helper,
        action,
        input,
        "migration",
        "preflight-migration",
        "openclaw-system",
        release,
        "occ-installation-startup",
        "candidate-installation",
        productionValues["images.controller"],
        "60",
        join(directory, "unused-installation.json"),
        "none",
      ]);
    }

    async function refuses(action: string, rendered: Resource[], message: RegExp) {
      await assert.rejects(generate(action, rendered), { code: 1, stdout: "", stderr: message });
    }

    for (const action of ["job", "identity-job"]) {
      await t.test(action, async () => {
        const selected = structuredClone(initializer);
        const pod = selected.spec.template;
        const bootstrap = pod.spec.containers.find(({ name }) => name === "bootstrap");
        const migration = pod.spec.initContainers?.find(({ name }) => name === "migration");
        assert.ok(bootstrap);
        assert.ok(migration);
        // Preserve all labels, including custom labels, so the chart's default-deny
        // selector continues to cover the migration Pod.
        selected.metadata.labels[customLabel] = "job";
        pod.metadata.labels[customLabel] = "pod";
        pod.metadata.labels[nullableLabel] = null;
        bootstrap.envFrom = null;
        migration.envFrom = null;
        const generated: Job = JSON.parse(
          (await generate(action, withInitializer(selected))).stdout,
        );
        assert.deepEqual(generated.metadata.labels, selected.metadata.labels);
        assert.deepEqual(generated.spec.template.metadata.labels, pod.metadata.labels);
        for (const [key, value] of Object.entries(deny.spec.podSelector.matchLabels)) {
          assert.equal(generated.spec.template.metadata.labels[key], value);
        }
        assert.deepEqual(
          generated.spec.template.spec.containers.map(({ name, envFrom }) => ({ name, envFrom })),
          [{ name: "migration", envFrom: null }],
        );
        assert.equal(generated.spec.template.spec.initContainers, undefined);

        // Count both release and component matches before validating their other labels.
        const duplicate = structuredClone(initializer);
        duplicate.metadata.name += "-duplicate";
        duplicate.metadata.labels[customLabel] = 7;
        await refuses(action, [...resources, duplicate], /exactly one initialization Job/);

        // Reject a label Kubernetes cannot decode before writing any Job manifest.
        pod.metadata.labels[customLabel] = 7;
        await refuses(action, withInitializer(selected), /invalid Pod labels/);
      });
    }
  },
);
