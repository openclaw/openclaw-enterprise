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

type Slot = "secret" | "networkpolicy" | "api" | "worker";
type PlannedSlot = Record<string, unknown> & { kind: string; name: string };
type Slots = Record<Slot, PlannedSlot>;
type Resource = {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    deletionTimestamp?: string;
    finalizers?: string[];
    ownerReferences?: { uid: string }[];
  };
  status?: { phase?: string };
};
type SecretFixture = { apiVersion: "v1"; kind: "Secret"; stringData: Record<string, string> };
type NetworkPolicyFixture = {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  spec: {
    podSelector: Record<string, never>;
    policyTypes: string[];
    ingress: never[];
    egress: never[];
  };
};
type PodFixture = {
  apiVersion: "v1";
  kind: "Pod";
  spec: {
    restartPolicy: string;
    terminationGracePeriodSeconds: number;
    automountServiceAccountToken: boolean;
    containers: { name: string; image: string; command: string[] }[];
  };
};
type CreateFixture = SecretFixture | NetworkPolicyFixture | ReturnType<typeof buildJobSpec>;
type ApplyFixture = (CreateFixture | PodFixture) & {
  metadata: { name: string; namespace: string };
};
type CommandResult = { code: number | null; stdout: string; stderr: string };
type ScenarioContext = {
  scope: string[];
  directory: string;
  slots: Slots;
  create: (slot: Slot, spec: CreateFixture, acknowledge?: boolean) => Promise<Resource>;
  jobSpec: (active?: boolean) => ReturnType<typeof buildJobSpec>;
  get: (kind: string, name: string) => Promise<Resource | undefined>;
  cleanup: () => Promise<CommandResult>;
  dependenciesPresent: () => Promise<void>;
  apply: (object: ApplyFixture) => Promise<Resource>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function resource(value: unknown): Resource {
  const object = record(value);
  const metadata = record(object.metadata);
  const parsed: Resource = {
    metadata: {
      name: string(metadata.name),
      namespace: string(metadata.namespace),
      uid: string(metadata.uid),
    },
  };
  if (metadata.deletionTimestamp !== undefined) {
    parsed.metadata.deletionTimestamp = string(metadata.deletionTimestamp);
  }
  if (metadata.finalizers !== undefined) {
    assert.ok(Array.isArray(metadata.finalizers));
    parsed.metadata.finalizers = metadata.finalizers.map(string);
  }
  if (metadata.ownerReferences !== undefined) {
    assert.ok(Array.isArray(metadata.ownerReferences));
    parsed.metadata.ownerReferences = metadata.ownerReferences.map((owner: unknown) => ({
      uid: string(record(owner).uid),
    }));
  }
  if (object.status !== undefined) {
    const status = record(object.status);
    parsed.status = status.phase === undefined ? {} : { phase: string(status.phase) };
  }
  return parsed;
}

function requireResource(value: Resource | undefined): Resource {
  assert.ok(value);
  return value;
}

function finalizers(value: Resource): string[] {
  assert.ok(value.metadata.finalizers);
  return value.metadata.finalizers;
}

function resources(value: unknown): Resource[] {
  const items = record(value).items;
  assert.ok(Array.isArray(items));
  return items.map(resource);
}

function plannedSlots(value: unknown): Slots {
  const slots = record(record(value).slots);
  const planned = (slot: Slot): PlannedSlot => {
    const entry = record(slots[slot]);
    return { ...entry, kind: string(entry.kind), name: string(entry.name) };
  };
  return {
    secret: planned("secret"),
    networkpolicy: planned("networkpolicy"),
    api: planned("api"),
    worker: planned("worker"),
  };
}

function buildJobSpec(image: string, secretName: string, active = false) {
  return {
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
              envFrom: [{ secretRef: { name: secretName } }],
            },
          ],
        },
      },
    },
  };
}

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

// This proves recovery against the real API and garbage collector. The normal
// producer's interruption and receipt ordering have separate process coverage.
test(
  "interrupted preflight recovery respects real Kubernetes identity and consumer lifetime",
  {
    skip: process.env.OCC_TEST_PRODUCTION_OBSERVABILITY !== "1",
    timeout: 300_000,
  },
  async (t) => {
    const selected = explicitK3dSelection();
    await validateExplicitK3dLoopbackContext(selected);
    const selection = {
      kubeconfigPath: string(selected.kubeconfigPath),
      kubernetesContext: string(selected.kubernetesContext),
    };
    const image = string(process.env.OCC_TEST_KUBERNETES_IMAGE);
    assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/);
    const command = async (
      file: string,
      args: string[],
      options: { input?: string; allowFailure?: boolean } = {},
    ): Promise<CommandResult> => {
      // The JavaScript fixture infers its default environment as a required shape,
      // but its subprocess accepts the caller's actual process environment.
      const execute = run as (
        file: string,
        args: string[],
        options: {
          env: NodeJS.ProcessEnv;
          timeout: number;
          input?: string;
          allowFailure?: boolean;
        },
      ) => Promise<unknown>;
      const result = await execute(file, args, {
        env: process.env,
        timeout: 90_000,
        ...options,
      });
      const output = record(result);
      assert.ok(typeof output.code === "number" || output.code === null);
      return { code: output.code, stdout: string(output.stdout), stderr: string(output.stderr) };
    };
    const kubectl = async (...args: string[]) =>
      (await command("kubectl", kubectlArguments(selection, args))).stdout;
    const waitFor = async <T>(
      description: string,
      predicate: () => Promise<T | undefined | false>,
    ): Promise<T> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const result = await predicate();
        if (result) {
          return result;
        }
        await delay(200);
      }
      assert.fail(`timed out: ${description}`);
    };

    async function scenario(label: string, action: (context: ScenarioContext) => Promise<void>) {
      const suffix = randomBytes(4).toString("hex");
      const namespace = `preflight-cleanup-${suffix}`;
      const release = `recovery-${suffix}`;
      const directory = await realpath(await mkdtemp(join(tmpdir(), "oce-preflight-cleanup-")));
      const scope = ["--namespace", namespace];
      const get = async (kind: string, name: string): Promise<Resource | undefined> => {
        const result = await kubectl(
          ...scope,
          "get",
          kind,
          name,
          "--ignore-not-found",
          "-o",
          "json",
        );
        return result.trim() ? resource(JSON.parse(result)) : undefined;
      };
      const apply = async (object: ApplyFixture): Promise<Resource> =>
        resource(
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
          ),
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
            ...Array.from({ length: 11 }, () => ""),
          ],
          kubeconfigSha256: digest(await readFile(selection.kubeconfigPath)),
          scriptSha256: digest(await readFile("scripts/upgrade-production-images")),
          startupPreflightSha256: digest(await readFile("scripts/upgrade-startup-preflight.ts")),
          preflightStateSha256: digest(await readFile("scripts/upgrade-preflight-state.py")),
          preflightCleanupSha256: digest(
            await readFile("scripts/lib/upgrade-preflight-cleanup.sh"),
          ),
        };
        await writeFile(join(directory, "parameters.json"), JSON.stringify(parameters), {
          mode: 0o600,
        });
        const state = (action: string, ...args: string[]) =>
          command("python3", ["scripts/upgrade-preflight-state.py", action, directory, ...args]);
        await state("init");
        await state("register", ".", suffix, "true");
        const slots = plannedSlots(
          JSON.parse(await readFile(join(directory, "preflight-plan.json"), "utf8")),
        );
        const create = async (slot: Slot, spec: CreateFixture, acknowledge = true) => {
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
        const jobSpec = (active = false) => buildJobSpec(image, secret.metadata.name, active);
        const dependenciesPresent = async () => {
          assert.equal(
            requireResource(await get("secret", secret.metadata.name)).metadata.uid,
            secret.metadata.uid,
          );
          assert.equal(
            requireResource(await get("networkpolicy", policy.metadata.name)).metadata.uid,
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
          const pods = resources(JSON.parse(await kubectl(...scope, "get", "pods", "-o", "json")));
          for (const pod of pods) {
            if (
              pod.metadata.finalizers !== undefined &&
              pod.metadata.finalizers.includes("test.openclaw.dev/hold-consumer")
            ) {
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
        const pod = await waitFor("the real Job controller creates its Pod", async () => {
          const pods = resources(JSON.parse(await kubectl(...scope, "get", "pods", "-o", "json")));
          return pods.find(
            ({ metadata, status }) =>
              metadata.ownerReferences !== undefined &&
              metadata.ownerReferences.some(({ uid }) => uid === job.metadata.uid) &&
              status !== undefined &&
              status.phase === "Running",
          );
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
        await waitFor("garbage collection reaches the original child", async () => {
          const observed = await get("pod", pod.metadata.name);
          return observed !== undefined && observed.metadata.deletionTimestamp !== undefined;
        });
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
                const observed = resources(
                  JSON.parse(
                    await readFile(join(directory, name, "preflight-cleanup-pods.json"), "utf8"),
                  ),
                );
                if (observed.some(({ metadata }) => metadata.uid === pod.metadata.uid)) {
                  return true;
                }
              } catch (error) {
                if (
                  !(error instanceof SyntaxError) &&
                  !(error instanceof Error && "code" in error && error.code === "ENOENT")
                ) {
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
                finalizers: finalizers(requireResource(await get("pod", pod.metadata.name))).filter(
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
        const remaining = resources(
          JSON.parse(
            await kubectl(...scope, "get", "jobs,pods,secrets,networkpolicies", "-o", "json"),
          ),
        );
        assert.deepEqual(remaining, []);
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
          requireResource(await get("job", replacement.metadata.name)).metadata.uid,
          replacement.metadata.uid,
        );
        await dependenciesPresent();
      },
    );

    await scenario(
      "recorded child replacement",
      async ({ scope, directory, create, jobSpec, get, cleanup, dependenciesPresent, apply }) => {
        const job = await create("api", jobSpec(true));
        const original = await waitFor("the real Job controller creates its child", async () => {
          const pods = resources(JSON.parse(await kubectl(...scope, "get", "pods", "-o", "json")));
          return pods.find(
            ({ metadata, status }) =>
              metadata.ownerReferences !== undefined &&
              metadata.ownerReferences.some(({ uid }) => uid === job.metadata.uid) &&
              status !== undefined &&
              status.phase === "Running",
          );
        });
        await writeFile(
          join(directory, "preflight-api-pod-identity.json"),
          JSON.stringify({ kind: "pod", name: original.metadata.name, uid: original.metadata.uid }),
          { mode: 0o600 },
        );
        // An interrupted cleanup can leave a recorded name available for reuse.
        // A new Pod at that name is not proof that the original child settled.
        const observed = requireResource(await get("pod", original.metadata.name));
        await kubectl(
          ...scope,
          "patch",
          "pod",
          original.metadata.name,
          "--type=merge",
          "-p",
          JSON.stringify({
            metadata: {
              finalizers: finalizers(observed).filter(
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
          requireResource(await get("pod", original.metadata.name)).metadata.uid,
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
        assert.equal(
          requireResource(await get("job", unknown.metadata.name)).metadata.uid,
          unknown.metadata.uid,
        );
        assert.equal(await get("job", known.metadata.name), undefined);
        await dependenciesPresent();
        const resultDirectory = (await readdir(directory)).find((name) =>
          name.startsWith("preflight-cleanup."),
        );
        assert.ok(resultDirectory);
        const result = record(
          JSON.parse(
            await readFile(
              join(directory, resultDirectory, "preflight-cleanup-result.json"),
              "utf8",
            ),
          ),
        );
        assert.equal(result.complete, false);
        assert.deepEqual(result.unknown, [".:api"]);
      },
    );
  },
);
