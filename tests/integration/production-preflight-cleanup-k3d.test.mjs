import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../fixtures/repository-credentials/process.mjs";
import {
  explicitK3dSelection,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

// This proves recovery against the real API and garbage collector. The normal
// producer's interruption and receipt ordering have separate process coverage.
test(
  "interrupted preflight recovery respects real Kubernetes identity and consumer lifetime",
  {
    skip: process.env.OCC_TEST_PRODUCTION_OBSERVABILITY !== "1",
    timeout: 300_000,
  },
  async (t) => {
    const selection = explicitK3dSelection();
    await validateExplicitK3dLoopbackContext(selection);
    const image = process.env.OCC_TEST_KUBERNETES_IMAGE;
    assert.match(image ?? "", /^\S+@sha256:[a-f0-9]{64}$/);
    const command = async (file, args, options = {}) =>
      run(file, args, { env: process.env, timeout: 90_000, ...options });
    const kubectl = async (...args) =>
      (await command("kubectl", kubectlArguments(selection, args))).stdout;
    const waitFor = async (description, predicate) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await predicate()) {
          return;
        }
        await delay(200);
      }
      assert.fail(`timed out: ${description}`);
    };

    async function scenario(label, action) {
      const suffix = randomBytes(4).toString("hex");
      const namespace = `preflight-cleanup-${suffix}`;
      const release = `recovery-${suffix}`;
      const directory = await realpath(await mkdtemp(join(tmpdir(), "oce-preflight-cleanup-")));
      const scope = ["--namespace", namespace];
      const get = async (kind, name) => {
        const result = await kubectl(
          ...scope,
          "get",
          kind,
          name,
          "--ignore-not-found",
          "-o",
          "json",
        );
        return result.trim() ? JSON.parse(result) : undefined;
      };
      const apply = async (object) =>
        JSON.parse(
          (
            await command(
              "kubectl",
              kubectlArguments(selection, ["create", "-f", "-", "-o", "json"]),
              {
                input: JSON.stringify(object),
              },
            )
          ).stdout,
        );
      let created = false;
      try {
        await kubectl("create", "namespace", namespace);
        created = true;
        await mkdir(join(directory, ".upgrade-lock"));
        const info = await stat(directory);
        const parameters = {
          evidenceDirectory: { path: directory, st_dev: info.dev, st_ino: info.ino },
          arguments: [
            selection.kubeconfigPath,
            selection.kubernetesContext,
            namespace,
            release,
            ...Array(11).fill(""),
          ],
          kubeconfigSha256: digest(await readFile(selection.kubeconfigPath)),
        };
        for (const [field, path] of Object.entries({
          scriptSha256: "scripts/upgrade-production-images",
          startupPreflightSha256: "scripts/upgrade-startup-preflight.mjs",
          preflightStateSha256: "scripts/upgrade-preflight-state.py",
          preflightCleanupSha256: "scripts/lib/upgrade-preflight-cleanup.sh",
        })) {
          parameters[field] = digest(await readFile(path));
        }
        await writeFile(join(directory, "parameters.json"), JSON.stringify(parameters), {
          mode: 0o600,
        });
        const state = (action, ...args) =>
          command("python3", ["scripts/upgrade-preflight-state.py", action, directory, ...args]);
        await state("init");
        await state("register", ".", suffix, "true");
        const { slots } = JSON.parse(
          await readFile(join(directory, "preflight-plan.json"), "utf8"),
        );
        const create = async (slot, spec, acknowledge = true) => {
          await state("started", ".", slot);
          const planned = slots[slot];
          const object = await apply({
            ...spec,
            metadata: { name: planned.name, namespace },
          });
          if (acknowledge) {
            // Retain only the UID actually returned by this API create. Omitting
            // this write below models an accepted create whose response was lost.
            await writeFile(
              join(directory, `preflight-${slot}-identity.json`),
              JSON.stringify({ ...planned, uid: object.metadata.uid }),
              { mode: 0o600 },
            );
          }
          return object;
        };
        const secret = await create("secret", {
          apiVersion: "v1",
          kind: "Secret",
          stringData: { marker: "synthetic" },
        });
        const policy = await create("networkpolicy", {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
        });
        const jobSpec = (active = false) => ({
          apiVersion: "batch/v1",
          kind: "Job",
          spec: {
            parallelism: active ? 1 : 0,
            backoffLimit: 0,
            template: {
              metadata: { finalizers: active ? ["test.openclaw.dev/hold-consumer"] : [] },
              spec: {
                restartPolicy: "Never",
                terminationGracePeriodSeconds: 0,
                automountServiceAccountToken: false,
                containers: [
                  {
                    name: "consumer",
                    image,
                    imagePullPolicy: "IfNotPresent",
                    command: ["sh", "-c", "sleep 600"],
                    envFrom: [{ secretRef: { name: secret.metadata.name } }],
                  },
                ],
              },
            },
          },
        });
        const dependenciesPresent = async () => {
          assert.equal(
            (await get("secret", secret.metadata.name))?.metadata.uid,
            secret.metadata.uid,
          );
          assert.equal(
            (await get("networkpolicy", policy.metadata.name))?.metadata.uid,
            policy.metadata.uid,
          );
        };
        const cleanup = async () => {
          const result = await command(
            "bash",
            [
              "scripts/upgrade-production-images",
              "--cleanup-preflight",
              "--kubeconfig",
              selection.kubeconfigPath,
              "--context",
              selection.kubernetesContext,
              "--namespace",
              namespace,
              "--release",
              release,
              "--evidence-dir",
              directory,
              "--previous-process-settled",
              "--evidence-unrestored",
            ],
            { allowFailure: true },
          );
          assert.ok(
            await stat(join(directory, ".upgrade-lock")),
            "cleanup preserves the upgrade lock",
          );
          return result;
        };
        await action({
          scope,
          directory,
          slots,
          create,
          jobSpec,
          get,
          cleanup,
          dependenciesPresent,
          apply,
        });
        t.diagnostic(`${label}: real API assertions passed`);
      } finally {
        if (created) {
          // Remove only this test's finalizer before deleting its owned namespace.
          const pods = JSON.parse(await kubectl(...scope, "get", "pods", "-o", "json"));
          for (const pod of pods.items) {
            if (pod.metadata.finalizers?.includes("test.openclaw.dev/hold-consumer")) {
              await kubectl(
                ...scope,
                "patch",
                "pod",
                pod.metadata.name,
                "--type=merge",
                "-p",
                JSON.stringify({
                  metadata: {
                    finalizers: pod.metadata.finalizers.filter(
                      (value) => value !== "test.openclaw.dev/hold-consumer",
                    ),
                  },
                }),
              );
            }
          }
          await kubectl("delete", "namespace", namespace, "--wait=true", "--timeout=60s");
        }
        await rm(directory, { recursive: true, force: true });
      }
    }

    await scenario(
      "original child convergence",
      async ({ scope, directory, create, jobSpec, get, cleanup, dependenciesPresent }) => {
        const job = await create("api", jobSpec(true));
        let pod;
        await waitFor("the real Job controller creates its Pod", async () => {
          const pods = JSON.parse(await kubectl(...scope, "get", "pods", "-o", "json"));
          pod = pods.items.find(({ metadata }) =>
            metadata.ownerReferences?.some(({ uid }) => uid === job.metadata.uid),
          );
          return pod?.status.phase === "Running";
        });
        // A previous delete may have removed the Job while GC is still waiting on
        // a child finalizer. No child receipt or mutable discovery label is trusted.
        await kubectl(
          ...scope,
          "delete",
          "job",
          job.metadata.name,
          "--cascade=background",
          "--wait=true",
        );
        await waitFor(
          "garbage collection reaches the original child",
          async () => (await get("pod", pod.metadata.name))?.metadata.deletionTimestamp,
        );
        await kubectl(
          ...scope,
          "patch",
          "pod",
          pod.metadata.name,
          "--type=merge",
          "-p",
          JSON.stringify({ metadata: { labels: null } }),
        );
        const pending = cleanup();
        try {
          await waitFor("cleanup observes the retained child", async () => {
            for (const name of await readdir(directory)) {
              if (!name.startsWith("preflight-cleanup.")) {
                continue;
              }
              try {
                const observed = JSON.parse(
                  await readFile(join(directory, name, "preflight-cleanup-pods.json"), "utf8"),
                );
                if (observed.items.some(({ metadata }) => metadata.uid === pod.metadata.uid)) {
                  return true;
                }
              } catch (error) {
                if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
                  throw error;
                }
              }
            }
            return false;
          });
          await dependenciesPresent();
          await kubectl(
            ...scope,
            "patch",
            "pod",
            pod.metadata.name,
            "--type=merge",
            "-p",
            JSON.stringify({
              metadata: {
                finalizers: (await get("pod", pod.metadata.name)).metadata.finalizers.filter(
                  (value) => value !== "test.openclaw.dev/hold-consumer",
                ),
              },
            }),
          );
        } finally {
          const result = await pending;
          assert.equal(result.code, 0, result.stderr);
        }
        assert.equal(await get("pod", pod.metadata.name), undefined);
        assert.equal((await cleanup()).code, 0, "repeated cleanup converges");
        const remaining = JSON.parse(
          await kubectl(...scope, "get", "jobs,pods,secrets,networkpolicies", "-o", "json"),
        );
        assert.deepEqual(remaining.items, []);
      },
    );

    await scenario(
      "same-name replacement",
      async ({ scope, slots, create, jobSpec, get, cleanup, dependenciesPresent, apply }) => {
        const original = await create("api", jobSpec());
        await kubectl(...scope, "delete", "job", original.metadata.name, "--wait=true");
        const replacement = await apply({
          ...jobSpec(),
          metadata: { name: slots.api.name, namespace: original.metadata.namespace },
        });
        assert.notEqual(replacement.metadata.uid, original.metadata.uid);
        assert.equal((await cleanup()).code, 1);
        assert.equal(
          (await get("job", replacement.metadata.name)).metadata.uid,
          replacement.metadata.uid,
        );
        await dependenciesPresent();
      },
    );

    await scenario(
      "recorded child replacement",
      async ({ scope, directory, create, jobSpec, get, cleanup, dependenciesPresent, apply }) => {
        const job = await create("api", jobSpec(true));
        let original;
        await waitFor("the real Job controller creates its child", async () => {
          const pods = JSON.parse(await kubectl(...scope, "get", "pods", "-o", "json"));
          original = pods.items.find(({ metadata }) =>
            metadata.ownerReferences?.some(({ uid }) => uid === job.metadata.uid),
          );
          return original?.status.phase === "Running";
        });
        await writeFile(
          join(directory, "preflight-api-pod-identity.json"),
          JSON.stringify({ kind: "pod", name: original.metadata.name, uid: original.metadata.uid }),
          { mode: 0o600 },
        );
        // An interrupted cleanup can leave a recorded name available for reuse.
        // A new Pod at that name is not proof that the original child settled.
        const observed = await get("pod", original.metadata.name);
        await kubectl(
          ...scope,
          "patch",
          "pod",
          original.metadata.name,
          "--type=merge",
          "-p",
          JSON.stringify({
            metadata: {
              finalizers: observed.metadata.finalizers.filter(
                (value) => value !== "test.openclaw.dev/hold-consumer",
              ),
            },
          }),
        );
        await kubectl(
          ...scope,
          "delete",
          "job",
          job.metadata.name,
          "--cascade=foreground",
          "--wait=true",
          "--timeout=60s",
        );
        await waitFor(
          "the original child is gone",
          async () => !(await get("pod", original.metadata.name)),
        );
        const replacement = await apply({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: original.metadata.name, namespace: original.metadata.namespace },
          spec: {
            restartPolicy: "Never",
            terminationGracePeriodSeconds: 0,
            automountServiceAccountToken: false,
            containers: [{ name: "replacement", image, command: ["sh", "-c", "sleep 600"] }],
          },
        });
        assert.notEqual(replacement.metadata.uid, original.metadata.uid);
        assert.equal((await cleanup()).code, 1);
        assert.equal(
          (await get("pod", original.metadata.name)).metadata.uid,
          replacement.metadata.uid,
        );
        await dependenciesPresent();
      },
    );

    await scenario(
      "lost create acknowledgement",
      async ({ directory, create, jobSpec, get, cleanup, dependenciesPresent }) => {
        const unknown = await create("api", jobSpec(), false);
        const known = await create("worker", jobSpec());
        assert.equal((await cleanup()).code, 1);
        assert.equal((await get("job", unknown.metadata.name)).metadata.uid, unknown.metadata.uid);
        assert.equal(await get("job", known.metadata.name), undefined);
        await dependenciesPresent();
        const resultDirectory = (await readdir(directory)).find((name) =>
          name.startsWith("preflight-cleanup."),
        );
        const result = JSON.parse(
          await readFile(join(directory, resultDirectory, "preflight-cleanup-result.json"), "utf8"),
        );
        assert.equal(result.complete, false);
        assert.deepEqual(result.unknown, [".:api"]);
      },
    );
  },
);
