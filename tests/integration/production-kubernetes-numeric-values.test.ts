import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MAX_TIMER_DELAY_MS } from "../../packages/utils/src/index.ts";
import { parseProductionChart, productionCollectorValues } from "../helpers/production-chart.mjs";
import {
  render,
  tooling,
  type ChartRenderOptions,
  type ChartValues,
} from "../helpers/production-chart-network-fixture.ts";
import {
  collectorVolumeLimitCases,
  quantityRefusals,
  resourceNameAndSignRefusals,
} from "../helpers/production-chart-quantity-cases.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chartObject(value: unknown, field: string): Record<string, unknown> {
  assert.ok(isRecord(value), `Expected a rendered object at ${field}`);
  return value;
}

function chartArray(value: unknown, field: string): unknown[] {
  assert.ok(Array.isArray(value), `Expected a rendered array at ${field}`);
  return value;
}

async function renderObjects(overrides: ChartValues, options: ChartRenderOptions) {
  const rendered: unknown = await parseProductionChart((await render(overrides, options)).stdout);
  return chartArray(rendered, "chart documents");
}

function podSpec(resource: unknown): Record<string, unknown> {
  const spec = chartObject(chartObject(resource, "resource").spec, "spec");
  const template = chartObject(spec.template, "spec.template");
  return chartObject(template.spec, "spec.template.spec");
}

function helmStderr(error: unknown): string {
  assert.ok(
    isRecord(error) && typeof error.stderr === "string",
    "Expected Helm to reject with stderr",
  );
  return error.stderr;
}

test("Helm rejects worker timings the worker process rejects", tooling, async () => {
  for (const [key, value] of [
    ["worker.pollIntervalMs", "0"],
    ["worker.pollIntervalMs", "abc"],
    ["worker.leaseDurationMs", "1.5"],
    ["worker.maxAttempts", "-1"],
    ["worker.convergenceTimeoutMs", "9007199254740993"],
  ] as const) {
    await assert.rejects(render({ [key]: value }), /must be a positive safe integer/);
  }
  const rendered = await render({ "worker.pollIntervalMs": "010" });
  assert.match(rendered.stdout, /name: OCC_WORKER_POLL_INTERVAL_MS\n\s+value: "010"/);
});

test("Helm refuses worker timer settings a Node.js timer cannot wait for", tooling, async (t) => {
  // Node fires a longer timer after 1 ms; the chart shares the worker's bound (finding 2303).
  const over = String(MAX_TIMER_DELAY_MS + 1);
  for (const key of ["worker.pollIntervalMs", "worker.leaseDurationMs"]) {
    await assert.rejects(
      render({ [key]: over }),
      new RegExp(`${key.replace(".", "\\.")} must be at most ${MAX_TIMER_DELAY_MS} milliseconds`),
    );
  }
  const rendered = await render({
    "worker.pollIntervalMs": String(MAX_TIMER_DELAY_MS),
    "worker.leaseDurationMs": String(MAX_TIMER_DELAY_MS),
    // Only compared with work age, never a timer delay: the safe-integer bound still applies.
    "worker.convergenceTimeoutMs": over,
  });
  for (const name of ["OCC_WORKER_POLL_INTERVAL_MS", "OCC_WORKER_LEASE_DURATION_MS"]) {
    assert.match(rendered.stdout, new RegExp(`name: ${name}\\n\\s+value: "${MAX_TIMER_DELAY_MS}"`));
  }
  assert.match(
    rendered.stdout,
    new RegExp(`name: OCC_WORKER_CONVERGENCE_TIMEOUT_MS\\n\\s+value: "${over}"`),
  );
  // A values file delivers a float64, which takes the helper's other parsing path.
  const directory = await temporaryDirectory(t, "occ-worker-timer-");
  const valuesFile = join(directory, "worker.yaml");
  await writeFile(valuesFile, `worker:\n  leaseDurationMs: ${over}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    render({}, { valuesFiles: [valuesFile] }),
    /worker\.leaseDurationMs must be at most 2147483647 milliseconds/,
  );
});

test("Helm renders a values-file worker timeout of 1800000 as digits", tooling, async (t) => {
  const directory = await temporaryDirectory(t, "occ-worker-timing-");
  const valuesFile = join(directory, "worker.yaml");
  await writeFile(valuesFile, "worker:\n  convergenceTimeoutMs: 1800000\n", {
    mode: 0o600,
  });
  const rendered = await render({}, { valuesFiles: [valuesFile] });
  assert.match(rendered.stdout, /name: OCC_WORKER_CONVERGENCE_TIMEOUT_MS\n\s+value: "1800000"/);
  assert.doesNotMatch(rendered.stdout, /OCC_WORKER_CONVERGENCE_TIMEOUT_MS\n\s+value: "1\.8e\+06"/);
});

// Kubernetes refuses these at apply, after other objects of the release changed (finding 2337).
test("Helm refuses unknown resource names and negative quantities", tooling, async () => {
  const values = {
    ...productionCollectorValues,
    "slackProxy.enabled": "true",
  };
  for (const [field, value, message] of resourceNameAndSignRefusals) {
    await assert.rejects(render({ ...values, [field]: value }), (error) => {
      const stderr = helmStderr(error);
      assert.ok(stderr.includes(message), `${field}: ${stderr}`);
      return true;
    });
  }
  // Extended and huge page resources pass, and so does zero, signed or not. Request above
  // limit is left to Kubernetes (#1676 keeps the chart to syntax checks).
  await render({
    ...values,
    "resources.requests.cpu": "2",
    "resources.limits.cpu": "500m",
    "resources.requests.example\\.com/gpu": "1",
    "resources.limits.example\\.com/gpu": "1",
    "slackProxy.resources.limits.hugepages-2Mi": "4Mi",
    "slackProxy.resources.requests.hugepages-1\\.5Gi": "3Gi",
    // A huge page size is any quantity: unsuffixed, or with an exponent.
    "slackProxy.resources.limits.hugepages-2097152": "4Mi",
    "slackProxy.resources.limits.hugepages-1e6": "4Mi",
    [`resources.limits.example\\.com/${"g".repeat(63)}`]: "1",
    // Null clears a quantity instead of failing the check.
    "resources.limits.example\\.com/fpga": "null",
    "slackProxy.resources.requests.ephemeral-storage": "-0",
    "logging.collector.resources.requests.memory": "384e6",
    "logging.collector.state.sizeLimit": "0",
    "logging.collector.tmp.sizeLimit": "-0.0Mi",
  });
});

test("Helm rejects obvious malformed quantity syntax", tooling, async () => {
  const collector = productionCollectorValues;
  for (const isUpgrade of [false, true]) {
    const options = { isUpgrade };
    for (const [field, value] of quantityRefusals["--set"].syntax) {
      await assert.rejects(render({ ...collector, [field]: value }, options), (error) => {
        assert.ok(helmStderr(error).includes(`${field} must be a Kubernetes quantity`));
        return true;
      });
    }
    const rendered = await render(collector, options);
    assert.match(rendered.stdout, /sizeLimit: "128Mi"/);
    assert.match(rendered.stdout, /sizeLimit: "64Mi"/);

    // Numeric YAML quantities must not be mistaken for missing or non-string values.
    const numeric = await renderObjects(
      { ...collector, "resources.requests.cpu": 0, "resources.limits.cpu": 1 },
      options,
    );
    const api = numeric.find((object) => {
      if (!isRecord(object) || object.kind !== "Deployment" || !isRecord(object.metadata)) {
        return false;
      }
      const labels = object.metadata.labels;
      return isRecord(labels) && labels["app.kubernetes.io/component"] === "api";
    });
    const [container] = chartArray(podSpec(api).containers, "API containers");
    const resources = chartObject(
      chartObject(container, "API container").resources,
      "API resources",
    );
    assert.equal(chartObject(resources.requests, "API resource requests").cpu, 0);
    assert.equal(chartObject(resources.limits, "API resource limits").cpu, 1);

    // Decimal E is exa; uppercase K is not a suffix. Exponent and binary forms stay.
    for (const [field, value, diagnostic, base] of quantityRefusals["--set"].uppercaseSuffix) {
      const values = base === "collector" ? collector : {};
      await assert.rejects(render({ ...values, [field]: value }, options), diagnostic);
    }
    const accepted = await render(
      {
        ...collector,
        "resources.requests.memory": "1E",
        "logging.collector.resources.requests.memory": "1E",
        "logging.collector.state.sizeLimit": "1E",
      },
      options,
    );
    assert.match(accepted.stdout, /memory: 1E/);
    assert.match(accepted.stdout, /sizeLimit: "1E"/);
    const preserved = await render(
      {
        "resources.requests.memory": "1e3",
        "resources.limits.memory": "1E3",
        "resources.requests.cpu": "1k",
        "resources.limits.cpu": "1Ki",
      },
      options,
    );
    assert.match(preserved.stdout, /memory: "1e3"/);
    assert.match(preserved.stdout, /memory: "1E3"/);
    assert.match(preserved.stdout, /cpu: 1k/);
    assert.match(preserved.stdout, /cpu: 1Ki/);

    // UnmarshalJSON trims spaces on the raw JSON text. Escaped tabs stay rejected.
    for (const [field, value, diagnostic] of quantityRefusals["--set-string"]) {
      await assert.rejects(render({}, { ...options, strings: { [field]: value } }), diagnostic);
    }
    const padded = await render(collector, {
      ...options,
      strings: {
        "resources.requests.cpu": " 100m ",
        "resources.limits.memory": " 1E ",
        "logging.collector.resources.requests.memory": " 64Mi ",
        "logging.collector.state.sizeLimit": " 128Mi ",
        "logging.collector.tmp.sizeLimit": " 32Mi ",
      },
    });
    assert.match(padded.stdout, /cpu: ["'] 100m ["']/);
    assert.match(padded.stdout, /memory: ["'] 1E ["']/);
    assert.match(padded.stdout, /memory: ["'] 64Mi ["']/);
    assert.match(padded.stdout, /sizeLimit: " 128Mi "/);
    assert.match(padded.stdout, /sizeLimit: " 32Mi "/);

    // ParseQuantity treats a missing numerator as zero. Bare Pi has an empty numeric token.
    const zeros = await render(collector, {
      ...options,
      strings: {
        "resources.requests.cpu": "m",
        "resources.limits.cpu": "+",
        "resources.requests.memory": ".",
        "logging.collector.state.sizeLimit": "m",
      },
    });
    assert.match(zeros.stdout, /cpu: m$/m);
    assert.match(zeros.stdout, /cpu: \+$/m);
    assert.match(zeros.stdout, /memory: \.$/m);
    assert.match(zeros.stdout, /sizeLimit: "m"/);
    await assert.rejects(
      render({}, { ...options, strings: { "resources.requests.memory": "Pi" } }),
      /resources\.requests\.memory must be a Kubernetes quantity/,
    );
    const withDigit = await render(
      {},
      { ...options, strings: { "resources.requests.memory": "1Pi" } },
    );
    assert.match(withDigit.stdout, /memory: 1Pi/);

    // sizeLimit is optional. Null clears the chart default and must stay YAML null on install and upgrade.
    for (const { overrides, expectedState, expectedTmp } of collectorVolumeLimitCases) {
      const objects = await renderObjects({ ...collector, ...overrides }, options);
      const collectorDaemonSet = objects.find(
        (object) =>
          isRecord(object) &&
          object.kind === "DaemonSet" &&
          isRecord(object.metadata) &&
          object.metadata.name === "openclaw-enterprise-collector",
      );
      const volumes = chartArray(podSpec(collectorDaemonSet).volumes, "Collector volumes");
      for (const [name, expectedSize] of [
        ["collector-state", expectedState],
        ["collector-tmp", expectedTmp],
      ] as const) {
        const volume = volumes.find((volume) => isRecord(volume) && volume.name === name);
        const emptyDir = chartObject(chartObject(volume, name).emptyDir, `${name}.emptyDir`);
        assert.equal(emptyDir.sizeLimit, expectedSize);
      }
    }
    await assert.rejects(
      render(
        {
          ...collector,
          "logging.collector.state.sizeLimit": "null",
          "logging.collector.tmp.sizeLimit": "10MiB",
        },
        options,
      ),
      /logging\.collector\.tmp\.sizeLimit must be a Kubernetes quantity/,
    );
    await assert.rejects(
      render(
        {
          ...collector,
          "logging.collector.state.sizeLimit": "foo",
          "logging.collector.tmp.sizeLimit": "null",
        },
        options,
      ),
      /logging\.collector\.state\.sizeLimit must be a Kubernetes quantity/,
    );

    // resources: null clears defaults. Indexing that absent map used to abort the render.
    const cleared = await render(
      {
        ...collector,
        resources: "null",
        "logging.collector.resources": "null",
      },
      options,
    );
    assert.match(cleared.stdout, /sizeLimit: "128Mi"/);
    assert.doesNotMatch(cleared.stdout, /cpu: 100m/);
    assert.doesNotMatch(cleared.stdout, /memory: 128Mi/);
    await assert.rejects(
      render(
        { ...collector, resources: "null" },
        {
          ...options,
          strings: { "logging.collector.resources.requests.memory": "foo" },
        },
      ),
      /logging\.collector\.resources\.requests\.memory must be a Kubernetes quantity/,
    );
  }
});
