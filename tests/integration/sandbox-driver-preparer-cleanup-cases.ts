import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

type PreparationMetadata = {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  uid?: string;
  deletionTimestamp?: string;
};

type PreparationResource = {
  kind: string;
  metadata: PreparationMetadata;
};

type PreparationDeployment = PreparationResource & {
  spec: {
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        containers: [{ securityContext: { allowPrivilegeEscalation: boolean } }, ...unknown[]];
        securityContext: { fsGroup: number };
      };
    };
  };
};

type PreparationApi = {
  create: (resource: PreparationResource) => Promise<unknown>;
  read: (resource: PreparationResource) => Promise<PreparationDeployment>;
  delete: (
    resource: PreparationResource,
    pretty: string | undefined,
    dryRun: string | undefined,
    grace: number | undefined,
    orphan: boolean | undefined,
    propagation: string | undefined,
    body: { preconditions: { uid: string | undefined } },
  ) => Promise<void>;
  list: (
    version: string,
    kind: string,
    namespace: string,
    pretty: string | undefined,
    exact: boolean | undefined,
    exportValue: boolean | undefined,
    field: string | undefined,
    selector: string,
  ) => Promise<{ items: unknown[] }>;
};

type HarnessContext = Parameters<OpenShellSandboxDriver["provisionHarness"]>[0];
type PreparationFixture = {
  driver: OpenShellSandboxDriver;
  gateway: {
    providers: ReadonlyMap<string, unknown>;
    calls: ReadonlyArray<readonly [string, ...unknown[]]>;
    createSandbox: (
      request: OpenShellSandboxCreateRequest,
    ) => Promise<Pick<OpenShellSandboxResponse, "name" | "serviceUrls">>;
  };
  api: PreparationApi;
  resource: PreparationResource;
  deployment: PreparationDeployment;
  context: Omit<HarnessContext, "requirements" | "signal"> & { signal: AbortSignal };
  requirements: HarnessContext["requirements"];
};

type PreparerCleanupDependencies = {
  orphanedNativePreparation: () => Promise<PreparationFixture>;
  labelSelectorLabels: (selector: string) => Record<string, string>;
};

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 404;
}

export function registerSandboxDriverPreparerCleanupCases({
  orphanedNativePreparation,
  labelSelectorLabels,
}: PreparerCleanupDependencies): void {
  test("OpenShell resumes an SDK-decoded preparer after losing its create response", async () => {
    const { driver, gateway, api, resource, context, requirements } =
      await orphanedNativePreparation();
    api.create = async () => assert.fail("a retry must adopt the existing preparer");
    let sandboxCreates = 0;
    gateway.createSandbox = async (request) => {
      await assert.rejects(api.read(resource), isNotFound);
      sandboxCreates++;
      return { name: request.name, serviceUrls: {} };
    };

    // The original response was lost, not the Deployment. Reconciliation must verify
    // its SDK-decoded content, finish preparation, and remove the writer before launch.
    const sandbox = await driver.provisionHarness({ ...context, requirements });
    assert.equal(sandbox.revisionId, context.revision.id);
    assert.equal(sandboxCreates, 1);
    assert.equal(gateway.providers.size, 1);
  });

  test("OpenShell preparer adoption still rejects changed SDK-decoded security content", async (t) => {
    for (const scenario of [
      {
        name: "container privilege",
        change: (template: PreparationDeployment["spec"]["template"]) => {
          template.spec.containers[0].securityContext.allowPrivilegeEscalation = true;
        },
      },
      {
        name: "PVC group identity",
        change: (template: PreparationDeployment["spec"]["template"]) => {
          template.spec.securityContext.fsGroup = 1000;
        },
      },
      {
        name: "cleanup Pod selector",
        change: (template: PreparationDeployment["spec"]["template"]) => {
          template.metadata.labels["openclaw.dev/revision"] = "foreign";
        },
      },
    ]) {
      await t.test(scenario.name, async () => {
        const { driver, gateway, api, resource, deployment, context, requirements } =
          await orphanedNativePreparation();
        scenario.change(deployment.spec.template);
        const read = api.read;
        api.read = async (target) => (target.kind === "Deployment" ? deployment : read(target));
        api.create = async () => assert.fail("a foreign preparer must not be replaced");
        api.delete = async () => assert.fail("a foreign preparer must not be deleted");
        gateway.createSandbox = async () => assert.fail("a foreign preparer must prevent launch");
        await assert.rejects(
          driver.provisionHarness({ ...context, requirements }),
          /foreign workspace preparation Deployment/,
        );
        assert.equal((await api.read(resource)).metadata.uid, deployment.metadata.uid);
      });
    }
  });

  test("OpenShell revision cleanup removes an orphaned preparer before its provider and replays safely", async () => {
    const { driver, gateway, api, resource, context } = await orphanedNativePreparation();
    const remove = api.delete;
    let deletions = 0;
    api.delete = async (...args) => {
      assert.equal(
        gateway.providers.size,
        1,
        "runtime provider must survive until the writer stops",
      );
      assert.equal(
        gateway.calls.some(([method]) => method === "deleteSandbox"),
        false,
      );
      assert.equal(args[0].metadata.name, resource.metadata.name);
      assert.equal(args[0].metadata.namespace, context.namespace.name);
      deletions++;
      await remove(...args);
    };
    await driver.cleanup(context);
    await assert.rejects(api.read(resource), isNotFound);
    assert.equal(gateway.providers.size, 0);
    await driver.cleanup(context);
    assert.equal(deletions, 1, "a replay must not delete another resource");
  });

  test("OpenShell preparer cleanup retries after a delete response is lost", async () => {
    const { driver, gateway, api, resource, context } = await orphanedNativePreparation();
    const remove = api.delete;
    const failure = new Error("preparation delete response lost");
    api.delete = async (...args) => {
      await remove(...args);
      throw failure;
    };
    await assert.rejects(driver.cleanup(context), (error) => error === failure);
    await assert.rejects(api.read(resource), isNotFound);
    assert.equal(gateway.providers.size, 1);
    // The next pass must finish without requiring a Deployment or a create receipt.
    api.delete = async () => assert.fail("deleted preparation must not be deleted again");
    await driver.cleanup(context);
    assert.equal(gateway.providers.size, 0);
  });

  test("OpenShell preparer cleanup rejects foreign ownership and missing UIDs before deletion", async (t) => {
    const changes = [
      ...[
        "app.kubernetes.io/managed-by",
        "openclaw.dev/namespace",
        "openclaw.dev/agent",
        "openclaw.dev/revision",
        "openclaw.dev/workload-role",
      ].map((label) => ({
        name: label,
        change: (metadata: PreparationMetadata) => {
          metadata.labels[label] = "foreign";
        },
        error: /foreign workspace preparation/,
      })),
      {
        name: "namespace",
        change: (metadata: PreparationMetadata) => {
          metadata.namespace = "foreign";
        },
        error: /foreign workspace preparation/,
      },
      {
        name: "name",
        change: (metadata: PreparationMetadata) => {
          metadata.name = "foreign";
        },
        error: /foreign workspace preparation/,
      },
      {
        name: "missing UID",
        change: (metadata: PreparationMetadata) => {
          delete metadata.uid;
        },
        error: /Deployment UID/,
      },
    ];
    for (const scenario of changes) {
      await t.test(scenario.name, async () => {
        const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
        scenario.change(deployment.metadata);
        api.read = async () => structuredClone(deployment);
        api.delete = async () => assert.fail("foreign or unfenced Deployment must not be deleted");
        await assert.rejects(driver.cleanup(context), scenario.error);
        assert.equal(gateway.providers.size, 1);
        assert.equal(
          gateway.calls.some(([method]) => method === "deleteSandbox"),
          false,
        );
      });
    }
  });

  test("OpenShell preparer cleanup preserves a same-name UID replacement", async () => {
    const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
    const conflict = Object.assign(new Error("UID precondition failed"), { code: 409 });
    api.delete = async (_resource, _pretty, _dryRun, _grace, _orphan, propagation, body) => {
      assert.equal(propagation, "Foreground");
      assert.equal(body.preconditions.uid, deployment.metadata.uid);
      // Kubernetes refuses deletion after the resource is replaced between GET and DELETE.
      deployment.metadata.uid = "replacement-uid";
      throw conflict;
    };
    await assert.rejects(driver.cleanup(context), (error) => error === conflict);
    assert.equal(deployment.metadata.uid, "replacement-uid");
    assert.equal(gateway.providers.size, 1);
  });

  test("OpenShell preparer cleanup rejects a replacement observed while waiting for deletion", async () => {
    const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
    api.delete = async () => {
      deployment.metadata.uid = "replacement-uid";
    };
    api.read = async () => structuredClone(deployment);
    await assert.rejects(driver.cleanup(context), /Deployment changed/);
    assert.equal(gateway.providers.size, 1);
  });

  test("OpenShell preparer cleanup tolerates a concurrent delete but waits for lingering Pods", async (t) => {
    for (const missingDeployment of [false, true]) {
      await t.test(
        missingDeployment ? "Deployment already absent" : "foreground deletion",
        async () => {
          const { driver, gateway, api, resource, deployment, context } =
            await orphanedNativePreparation();
          const remove = api.delete;
          if (missingDeployment) {
            await remove(resource, undefined, undefined, undefined, undefined, "Foreground", {
              preconditions: { uid: deployment.metadata.uid },
            });
            api.delete = async () => assert.fail("an absent Deployment must not be deleted");
          } else {
            api.delete = async (...args) => {
              await remove(...args);
              throw { code: 404 };
            };
          }
          let observations = 0;
          api.list = async (
            version,
            kind,
            namespace,
            _pretty,
            _exact,
            _export,
            _field,
            selector,
          ) => {
            assert.equal(version, "v1");
            assert.equal(kind, "Pod");
            assert.equal(namespace, context.namespace.name);
            assert.deepEqual(labelSelectorLabels(selector), deployment.metadata.labels);
            assert.equal(gateway.providers.size, 1);
            assert.equal(
              gateway.calls.some(([method]) => method === "deleteSandbox"),
              false,
            );
            observations++;
            // A Pod carrying deletionTimestamp can still write; readiness is irrelevant.
            return {
              items:
                observations === 1
                  ? [{ metadata: { deletionTimestamp: "2026-10-12T00:00:00Z" } }]
                  : [],
            };
          };
          await driver.cleanup(context);
          assert.equal(observations, 2);
          assert.equal(gateway.providers.size, 0);
        },
      );
    }
  });

  test("OpenShell preparer cleanup waits for the Deployment even when no Pods are listed", async () => {
    const { driver, gateway, api, deployment, context } = await orphanedNativePreparation();
    let reads = 0;
    api.read = async () => {
      if (++reads <= 2) {
        return structuredClone(deployment);
      }
      throw { code: 404 };
    };
    api.delete = async () => {
      deployment.metadata.deletionTimestamp = "2026-10-12T00:00:00Z";
    };
    api.list = async () => {
      assert.equal(gateway.providers.size, 1);
      return { items: [] };
    };
    await driver.cleanup(context);
    assert.equal(reads, 3);
    assert.equal(gateway.providers.size, 0);
  });

  test("OpenShell preparer cleanup preserves retryable work on cancellation and transport errors", async (t) => {
    for (const stage of [
      "cancelled before cleanup",
      "cancelled while waiting",
      "read",
      "delete",
      "list",
    ] as const) {
      await t.test(stage, async () => {
        const { driver, gateway, api, context } = await orphanedNativePreparation();
        const abort = new AbortController();
        context.signal = abort.signal;
        const failure = new Error("cleanup interrupted");
        if (stage === "cancelled before cleanup") {
          abort.abort(failure);
          api.delete = async () => assert.fail("cancellation must prevent mutation");
        } else if (stage === "cancelled while waiting") {
          api.list = async () => {
            abort.abort(failure);
            return { items: [{}] };
          };
        } else {
          api[stage] = async () => {
            throw failure;
          };
        }
        await assert.rejects(driver.cleanup(context), (error) => error === failure);
        assert.equal(gateway.providers.size, 1);
        assert.equal(
          gateway.calls.some(([method]) => method === "deleteSandbox"),
          false,
        );
      });
    }
  });
}
