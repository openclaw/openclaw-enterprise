import type { RepositoryCredentialSessionFiles } from "../../packages/contracts/src/index.ts";
import { parseRecord } from "./repository-runtime-material-observations.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { SETUP_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  deadlineWallMs,
  runtimeBinding,
  workloadPod,
  fixture,
  present,
} from "./repository-runtime-material-fixture.ts";

for (const mode of ["embedded", "dedicated"] as const) {
  test(`Kubernetes repository material lifecycle (${mode})`, async (t) => {
    await t.test(
      "Kubernetes preparation creates immutable material and mounts only private output in the runtime",
      async () => {
        const f = await fixture(mode);
        const binding = runtimeBinding();
        await f.driver.prepareRevision(f.revision, f.context([binding]));
        assert.equal(f.secrets().length, 1);
        const secret = present(f.secrets()[0]);
        assert.equal(secret.immutable, true);
        const pod = f.requireConsumer().spec.template.spec;
        const init = pod.initContainers.find((container) => container.name.includes("repository"));
        assert.ok(init, "repository material must pass through an init container");
        const output = pod.volumes.find((volume) => volume.emptyDir?.medium === "Memory");
        assert.ok(output, "runtime material requires a memory-backed private volume");
        const mount = pod.containers[0].volumeMounts.find((value) => value.name === output.name);
        assert.ok(mount);
        assert.equal(mount.readOnly, true);
        assert.equal(mount.subPath, "private");
        assert.equal(mount.mountPath, "/run/oce/repository-credentials");
        const nativeIndex = pod.initContainers.findIndex(
          ({ name }) => name === "prepare-repository-native-git",
        );
        assert.ok(nativeIndex > pod.initContainers.indexOf(init));
        const native = present(pod.initContainers[nativeIndex]);
        assert.deepEqual(native.volumeMounts, [{ ...mount, readOnly: false }]);
        assert.equal(pod.securityContext?.runAsNonRoot, true);
        for (const initializer of [init, native]) {
          assert.deepEqual(initializer.command, [...SETUP_WRAPPER_COMMAND]);
          assert.equal(initializer.securityContext?.readOnlyRootFilesystem, true);
          assert.equal(initializer.securityContext?.allowPrivilegeEscalation, false);
          assert.deepEqual(initializer.securityContext?.capabilities, { drop: ["ALL"] });
        }
        assert.equal(JSON.stringify(pod).includes(binding.files.bearer), false);
        assert.equal(
          JSON.stringify(
            [...f.objects.values()].filter((object) => object.kind === "ConfigMap"),
          ).includes(binding.files.bearer),
          false,
        );
        const retained = {
          kind: "retained",
          repositoryRef: binding.repositoryRef,
          sessionId: binding.sessionId,
          deadlineWallMs,
        } as const;
        await f.driver.prepareRevision(f.revision, f.context([retained]));
        assert.equal(
          f.calls.filter(
            (call) =>
              call.operation === "write" &&
              call.kind === "Secret" &&
              call.name.startsWith("oce-repository-"),
          ).length,
          1,
        );
      },
    );

    for (const publicCa of [undefined, Buffer.from("fixture-public-ca")]) {
      await t.test(
        `repository file ordering preserves the Pod template (public CA: ${publicCa !== undefined})`,
        async () => {
          const f = await fixture(mode);
          const binding = runtimeBinding(undefined, publicCa);
          await f.driver.prepareRevision(f.revision, f.context([binding]));
          const originalTemplate = structuredClone(f.requireConsumer().spec.template);
          const originalGeneration = f.requireConsumer().metadata.generation;

          // JSON object members may return in a different order after storage.
          // That must not restart an unchanged credential-consuming workload.
          const secret = present(f.secrets()[0]);
          secret.data = Object.fromEntries(Object.entries(secret.data).reverse());
          f.save(secret);
          const { files, ...reference } = binding;
          const retained = { ...reference, kind: "retained" } as const;
          await f.driver.prepareRevision(f.revision, f.context([retained]));
          assert.deepEqual(f.requireConsumer().spec.template, originalTemplate);
          assert.equal(f.requireConsumer().metadata.generation, originalGeneration);

          const reordered = {
            ...binding,
            files: Object.fromEntries(
              Object.entries(files).reverse(),
            ) as RepositoryCredentialSessionFiles,
          };
          await f.driver.prepareRevision(f.revision, f.context([reordered]));
          assert.deepEqual(f.requireConsumer().spec.template, originalTemplate);
          assert.equal(f.requireConsumer().metadata.generation, originalGeneration);
        },
      );
    }

    await t.test(
      "Kubernetes reports exact missing retained material without silently creating new custody",
      async () => {
        const f = await fixture(mode);
        // The new binding is visited first; a later missing reference must prevent
        // the entire set from publishing any new Secret or workload.
        const pending = { ...runtimeBinding(), repositoryRef: "earlier-project" };
        const { bindings } = present(f.revision.repositoryCredentials);
        bindings.push({
          ...present(bindings[0]),
          repositoryRef: pending.repositoryRef,
        });
        const missing = { repositoryRef: "project", sessionId: "session-missing" };
        const context = f.context([pending, { kind: "retained", ...missing, deadlineWallMs }]);
        assert.deepEqual(await f.driver.prepareRevision(f.revision, context), {
          namespaceId: f.revision.namespaceId,
          agentId: f.revision.agentId,
          revisionId: f.revision.id,
          ready: false,
          repositoryCredentialMaterialMissing: [missing],
        });
        // Dedicated activation reports the missing material. Embedded activation refuses
        // earlier: preparation stopped, so the shared gateway Deployment was never created.
        await assert.rejects(
          f.driver.activateRevision(f.revision, context),
          mode === "dedicated"
            ? {
                name: "DependencyUnavailableError",
                message: "Repository credential material is unavailable for activation.",
              }
            : { message: "The Agent gateway workload is unavailable." },
        );
        assert.equal(
          f.calls.filter((call) => call.operation === "write" && call.kind === "Secret").length,
          0,
        );
        assert.equal(f.secrets().length, 0);
        assert.equal(f.deployments().length, 0);
        if (mode === "embedded") {
          // Once the shared gateway exists, embedded activation reaches the same refusal and
          // publishes no Secret for the set while one retained reference is missing.
          const project = runtimeBinding("session_material_project");
          await f.driver.prepareRevision(f.revision, f.context([pending, project]));
          assert.equal(f.deployments().length, 1);
          const writes = f.calls.length;
          await assert.rejects(f.driver.activateRevision(f.revision, context), {
            name: "DependencyUnavailableError",
            message: "Repository credential material is unavailable for activation.",
          });
          assert.deepEqual(
            f.calls.slice(writes).filter((call) => call.operation === "write"),
            [],
          );
        }
      },
    );

    await t.test(
      "Kubernetes rejects mismatched session documents before publishing repository material",
      async () => {
        const f = await fixture(mode);
        const binding = runtimeBinding();
        const document = parseRecord(binding.files["client.json"]);
        document.sessionId = "another-session";
        binding.files["client.json"] = JSON.stringify(document);
        await assert.rejects(f.driver.prepareRevision(f.revision, f.context([binding])), {
          message: "Repository credential material is invalid.",
        });
        assert.equal(f.secrets().length, 0);
        assert.equal(f.deployments().length, 0);
      },
    );

    await t.test(
      "Kubernetes stop recovers material left by an interrupted multi-Secret create",
      async () => {
        const f = await fixture(mode);
        const { bindings } = present(f.revision.repositoryCredentials);
        bindings.push({
          ...present(bindings[0]),
          repositoryRef: "second-project",
        });
        const first = runtimeBinding();
        const second = {
          ...runtimeBinding("session_material_second"),
          repositoryRef: "second-project",
        };
        const create = f.clients.core.createNamespacedSecret;
        let creations = 0;
        f.clients.core.createNamespacedSecret = async (request) => {
          // The API accepts one material object before the next request loses service.
          // No Pod exists, so recovery must discover material independently of Pods.
          if (++creations === 2) {
            throw Object.assign(new Error("API unavailable"), { statusCode: 503 });
          }
          return create(request);
        };
        // The API error is replaced so a Secret body it may carry never reaches callers.
        await assert.rejects(f.driver.prepareRevision(f.revision, f.context([first, second])), {
          message: "Repository credential material could not be created.",
        });
        assert.equal(f.secrets().length, 1);
        assert.equal(f.deployments().length, 0);
        await f.driver.stopRevision(f.revision);
        assert.equal(f.secrets().length, 0);
        // A conflict whose Secret is gone by the follow-up read cannot confirm custody.
        f.clients.core.createNamespacedSecret = async () => {
          throw Object.assign(new Error("Secret already exists"), { statusCode: 409 });
        };
        await assert.rejects(f.driver.prepareRevision(f.revision, f.context([first, second])), {
          message: "Repository credential material creation could not be confirmed.",
        });
        assert.equal(f.secrets().length, 0);
        assert.equal(f.deployments().length, 0);
      },
    );

    await t.test(
      "Kubernetes stop keeps material until the exact revision Pods disappear",
      async () => {
        const f = await fixture(mode);
        await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
        const deployment = f.requireConsumer();
        f.setPods([
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...deployment.spec.template.metadata,
              name: "terminating-gateway",
              namespace: f.namespace,
              deletionTimestamp: "2026-09-18T00:00:00.000Z",
            },
            spec: deployment.spec.template.spec,
          },
        ]);
        let observed = 0;
        f.observePods(() => {
          assert.equal(
            f.secrets().length,
            1,
            "material must survive every termination observation",
          );
          if (++observed === 2) {
            f.setPods([]);
          }
        });
        await f.driver.stopRevision(f.revision);
        assert.ok(observed >= 2);
        assert.equal(f.secrets().length, 0);
      },
    );

    await t.test(
      "Kubernetes activation rotates same-revision material while retaining the old Pod's Secret",
      async () => {
        const f = await fixture(mode);
        const original = runtimeBinding();
        await f.driver.prepareRevision(f.revision, f.context([original]));
        f.markReady();
        await f.driver.activateRevision(f.revision, f.context([original]));
        const oldSecret = present(f.secrets()[0]).metadata.name;
        const deployment = f.requireConsumer();
        f.setPods([
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...deployment.spec.template.metadata,
              name: "old-session-gateway",
              namespace: f.namespace,
            },
            spec: deployment.spec.template.spec,
          },
        ]);

        // Session rotation keeps the revision ID; deleting by revision label alone
        // would revoke a Secret still mounted by the terminating predecessor.
        const replacement = runtimeBinding("session_material_rotated");
        await assert.rejects(
          f.driver.activateRevision(f.revision, f.context([replacement])),
          /not ready/,
        );
        assert.notDeepEqual(f.requireConsumer().spec.template, deployment.spec.template);
        assert.equal(JSON.stringify(f.requireConsumer().spec.template).includes(oldSecret), false);
        assert.equal(f.secrets().length, 2);
        assert.ok(f.secrets().some((secret) => secret.metadata.name === oldSecret));
        f.setPods([]);
        f.markReady();
        await f.driver.activateRevision(f.revision, f.context([replacement]));
        assert.equal(f.secrets().length, 1);
        assert.notEqual(present(f.secrets()[0]).metadata.name, oldSecret);
        assert.equal(JSON.stringify(f.requireConsumer().spec.template).includes(oldSecret), false);
      },
    );

    await t.test(
      "repository material readiness waits for the replacement Pod when the old Pod is still ready",
      async () => {
        const f = await fixture(mode);
        const original = runtimeBinding();
        await f.driver.prepareRevision(f.revision, f.context([original]));
        f.markReady();
        await f.driver.activateRevision(f.revision, f.context([original]));
        const oldPod = workloadPod(f.requireConsumer(), f.namespace, "old-material-ready");
        const replacement = runtimeBinding("session_material_replacement");
        await f.driver.prepareRevision(f.revision, f.context([replacement]));

        // Deployment status can acknowledge the new template while its ready replica
        // still belongs to the old material generation. Observe both Pods separately.
        const deployment = f.requireConsumer();
        deployment.status = {
          observedGeneration: deployment.metadata.generation,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
        };
        f.save(deployment);
        const replacementPod = workloadPod(deployment, f.namespace, "replacement-starting", false);
        f.setPods([oldPod, replacementPod]);
        const waiting = await f.driver.prepareRevision(f.revision, f.context([replacement]));
        assert.equal(waiting.ready, false);
        await assert.rejects(f.driver.activateRevision(f.revision, f.context([replacement])), {
          name: "DependencyUnavailableError",
          message: "The exact repository credential runtime generation is not ready.",
        });

        replacementPod.status.conditions = [{ type: "Ready", status: "True" }];
        f.setPods([replacementPod]);
        const ready = await f.driver.prepareRevision(f.revision, f.context([replacement]));
        assert.equal(ready.ready, true);
        await f.driver.activateRevision(f.revision, f.context([replacement]));
      },
    );

    await t.test(
      "Kubernetes retirement finds material after its Deployment was already removed",
      async () => {
        const f = await fixture(mode);
        await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
        const deployment = f.requireConsumer();
        f.objects.delete(`Deployment:${deployment.metadata.namespace}:${deployment.metadata.name}`);
        f.setPods([
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              ...deployment.spec.template.metadata,
              name: "orphaned-old-gateway",
              namespace: f.namespace,
            },
            spec: deployment.spec.template.spec,
          },
        ]);
        let observations = 0;
        f.observePods(() => {
          assert.equal(f.secrets().length, 1);
          if (++observations === 2) {
            f.setPods([]);
          }
        });
        await f.driver.retireRevision(f.revision);
        assert.ok(observations >= 2);
        assert.equal(f.secrets().length, 0);
      },
    );

    await t.test(
      "external namespace cleanup removes owned repository material and preserves unrelated Secrets",
      async () => {
        const f = await fixture(mode);
        await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
        const tenant = present(f.objects.get(`Namespace::${f.namespace}`));
        assert.ok(tenant.metadata.annotations);
        tenant.metadata.annotations["openclaw.dev/namespace-lifecycle"] = "external";
        f.save(tenant);
        for (const deployment of f.deployments()) {
          f.objects.delete(
            `Deployment:${deployment.metadata.namespace}:${deployment.metadata.name}`,
          );
        }
        f.save({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "external-owner", namespace: f.namespace, uid: "external-owner-uid" },
          data: { value: "cHJlc2VydmU=" },
        });
        const result = await f.driver.deleteNamespace({
          id: f.revision.namespaceId,
          name: "External material tenant",
          status: "deleting",
          existingNamespace: f.namespace,
          createdAt: f.revision.createdAt,
        });
        assert.equal(result.namespaceDeleted, true, JSON.stringify(result));
        assert.deepEqual(f.secrets(), []);
        assert.ok(f.objects.has(`Secret:${f.namespace}:external-owner`));
        assert.ok(f.objects.has(`Namespace::${f.namespace}`));
      },
    );
  });
}
