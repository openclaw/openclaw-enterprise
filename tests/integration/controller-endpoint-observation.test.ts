import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { observeControllerEndpoints } from "../helpers/controller-endpoint-observation.ts";
import { FixtureCommandError, type FixtureRun } from "../helpers/production-rehearsal-custody.ts";

const namespace = "endpoint-observation";
const release = "fixture-release";
const serviceName = "openclaw-enterprise-api";
const selector = {
  "app.kubernetes.io/name": "openclaw-enterprise",
  "app.kubernetes.io/instance": release,
  "app.kubernetes.io/component": "api",
};
const kubeArgs = ["--kubeconfig", "/fixture/kubeconfig", "--context", "fixture-context"];
const privateText = "not-for-the-observation-receipt";
const metadata = (name: string, uid: string) => ({
  name,
  uid,
  namespace,
  resourceVersion: "123",
  annotations: { private: privateText },
});
const service = (uid = "service-original") => ({
  kind: "Service",
  metadata: metadata(serviceName, uid),
  spec: { selector },
});
const slice = (podUID: string, serviceUID = "service-original") => ({
  kind: "EndpointSlice",
  metadata: {
    ...metadata("api-slice", "slice-uid"),
    labels: { "kubernetes.io/service-name": serviceName },
    ownerReferences: [{ kind: "Service", name: serviceName, uid: serviceUID }],
  },
  endpoints: [
    {
      conditions: { ready: true },
      targetRef: { kind: "Pod", namespace, name: podUID, uid: podUID },
    },
  ],
});
const pod = (uid: string) => ({
  kind: "Pod",
  metadata: { ...metadata(uid, uid), labels: selector },
  spec: { containers: [{ env: [{ value: privateText }] }] },
  status: {
    phase: "Running",
    conditions: [
      {
        type: "Ready",
        status: "True",
        lastTransitionTime: "2026-01-01T00:00:00Z",
        message: privateText,
      },
    ],
  },
});
const list = (items: object[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-endpoint-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "controller-api-endpoints.json");
  return {
    directory,
    path,
    options: { namespace, release, kubeArgs, directory },
    receipt: async () => JSON.parse(await readFile(path, "utf8")),
  };
}

test(
  "controller endpoint observations retain scoped readiness windows without rebinding",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const emptyObserved = Promise.withResolvers<void>();
    const successorObserved = Promise.withResolvers<void>();
    let stage = 0;
    let actions = 0;
    const run: FixtureRun = async (command, args, options) => {
      assert.equal(command, "kubectl");
      assert.deepEqual(args.slice(0, 8), [
        ...kubeArgs,
        "--namespace",
        namespace,
        "--request-timeout=2s",
        "get",
      ]);
      assert.deepEqual(options, { timeout: 3_000, protectedInput: true });
      assert.deepEqual(args.slice(-2), ["-o", "json"]);
      const resource = args[8];
      if (resource === "services") {
        assert.deepEqual(args.slice(9, -2), ["--field-selector", `metadata.name=${serviceName}`]);
        return list([service(stage === 3 ? "service-replaced" : "service-original")]);
      }
      if (resource === "endpointslices.discovery.k8s.io") {
        assert.deepEqual(args.slice(9, -2), ["-l", `kubernetes.io/service-name=${serviceName}`]);
        if (stage === 1) {
          emptyObserved.resolve();
          return list([]);
        }
        return list([
          slice(
            stage ? "pod-new" : "pod-old",
            stage === 3 ? "service-replaced" : "service-original",
          ),
        ]);
      }
      assert.equal(resource, "pods");
      assert.deepEqual(args.slice(9, -2), [
        "-l",
        "app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=fixture-release,app.kubernetes.io/component=api",
      ]);
      if (stage === 2) {
        successorObserved.resolve();
      }
      return list(stage === 1 ? [] : [pod(stage ? "pod-new" : "pod-old")]);
    };
    const value = { accepted: true };
    assert.equal(
      await observeControllerEndpoints({ ...f.options, run }, async () => {
        actions++;
        stage = 1;
        await emptyObserved.promise;
        stage = 2;
        await successorObserved.promise;
        stage = 3;
        return value;
      }),
      value,
    );
    const receipt = await f.receipt();
    assert.equal(actions, 1);
    assert.equal(receipt.boundServiceUID, "service-original");
    assert.equal(receipt.complete, true);
    assert.equal(receipt.actionSucceeded, true);
    assert.deepEqual(
      receipt.samples.map((s: { phase: string }) => s.phase),
      ["before", "during", "during", "after"],
    );
    assert.equal(receipt.samples[0].slices.objects[0].endpoints[0].targetRef.uid, "pod-old");
    assert.deepEqual(receipt.samples[1].slices.objects, []);
    assert.equal(receipt.samples[1].slices.status, "ok");
    assert.equal(receipt.samples[2].slices.objects[0].endpoints[0].targetRef.uid, "pod-new");
    assert.equal(receipt.samples[3].service.objects[0].uid, "service-replaced");
    assert.equal(receipt.samples[3].slices.objects[0].serviceUIDs[0], "service-replaced");
    assert.equal(receipt.samples[0].slices.objects[0].endpoints[0].serving, null);
    assert.equal(
      receipt.samples[0].pods.objects[0].conditions[0].lastTransitionTime,
      "2026-01-01T00:00:00Z",
    );
    for (const sample of receipt.samples) {
      for (const kind of ["service", "slices", "pods"]) {
        const read = sample[kind];
        assert.ok(Number.isFinite(Date.parse(read.startedAt)));
        assert.ok(Date.parse(read.finishedAt) >= Date.parse(read.startedAt));
        assert.ok(read.finishOffsetMs >= read.startOffsetMs);
      }
    }
    assert.ok(!(await readFile(f.path, "utf8")).includes(privateText));
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  },
);

test("controller endpoint failed reads stay unknown and cannot establish a late binding", async (t) => {
  const f = await fixture(t);
  let actionStarted = false;
  const run: FixtureRun = async (_command, args) => {
    if (args[8] === "services") {
      if (!actionStarted) {
        throw new Error(privateText);
      }
      return list([service()]);
    }
    if (args[8] === "pods") {
      return list([]);
    }
    return actionStarted
      ? JSON.stringify({ apiVersion: "v1", kind: "Status", items: [] })
      : JSON.stringify({ items: [] });
  };
  await observeControllerEndpoints({ ...f.options, run }, async () => {
    actionStarted = true;
  });
  const receipt = await f.receipt();
  assert.equal(receipt.boundServiceUID, null);
  assert.equal(receipt.samples[0].service.status, "read-error");
  assert.equal(receipt.samples[0].slices.status, "invalid-response");
  assert.equal(receipt.samples.at(-1).slices.status, "invalid-response");
  assert.ok(!("objects" in receipt.samples[0].service));
  assert.ok(!("objects" in receipt.samples[0].slices));
  assert.deepEqual(receipt.samples[0].pods.objects, []);
  assert.equal(receipt.samples.at(-1).service.status, "ok");
  assert.ok(!(await readFile(f.path, "utf8")).includes(privateText));
});

test("controller endpoint observer joins reads and preserves action and evidence failures", async (t) => {
  const f = await fixture(t);
  const held = Promise.withResolvers<string>();
  const arrived = Promise.withResolvers<void>();
  let during = false;
  const failure = new Error("upgrade failed");
  const run: FixtureRun = async () => {
    if (during) {
      arrived.resolve();
      return held.promise;
    }
    return list([]);
  };
  const observed = observeControllerEndpoints({ ...f.options, run }, async () => {
    during = true;
    await arrived.promise;
    during = false;
    throw failure;
  });
  // The action has failed but its concurrently issued reads still belong to this observer.
  await arrived.promise;
  held.resolve(list([]));
  await assert.rejects(observed, (error: unknown) => error === failure);
  const { samples } = await f.receipt();
  const duringRead = samples.find((sample: { phase: string }) => sample.phase === "during");
  const afterRead = samples.find((sample: { phase: string }) => sample.phase === "after");
  assert.ok(duringRead && afterRead);
  const resources = ["service", "slices", "pods"];
  assert.ok(
    Math.max(...resources.map((key) => duringRead[key].finishOffsetMs)) <=
      Math.min(...resources.map((key) => afterRead[key].startOffsetMs)),
    "All during reads must finish before any after read starts",
  );

  assert.equal((await f.receipt()).actionSucceeded, false);

  const unavailable = join(f.directory, "not-a-directory");
  await writeFile(unavailable, "occupied");
  let actions = 0;
  await assert.rejects(
    observeControllerEndpoints(
      { ...f.options, directory: unavailable, run: async () => list([]) },
      async () => {
        actions++;
        throw failure;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, failure);
      assert.equal(error.errors[0], failure);
      assert.equal(error.errors[1].code, "ENOTDIR");
      return true;
    },
  );
  assert.equal(actions, 1);
});

for (const terminationFailed of [true, false]) {
  test(`baseline command without a confirmed exit prevents upgrade (terminationFailed=${terminationFailed})`, async (t) => {
    const f = await fixture(t);
    const failure = new FixtureCommandError("owned command cleanup failed", {
      exitCode: null,
      signal: null,
      timedOut: true,
      interrupted: false,
      spawned: true,
      terminationFailed,
    });
    let calls = 0;
    let actions = 0;
    await assert.rejects(
      observeControllerEndpoints(
        {
          ...f.options,
          run: async () => {
            calls++;
            throw failure;
          },
        },
        async () => {
          actions++;
        },
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(actions, 0);
    assert.equal(calls, 3);
    assert.equal((await f.receipt()).complete, false);
  });
}
