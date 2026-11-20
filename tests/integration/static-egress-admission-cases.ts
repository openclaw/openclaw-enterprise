import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  SandboxNetworkGrantSchema,
  type AgentRevision,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { registerStartupAdmissionCases } from "./static-egress-startup-admission-cases.ts";
import {
  deployedContext,
  registerPolicyAdmissionCases,
} from "./static-egress-policy-admission-cases.ts";

interface AdmissionDependencies {
  admissionCases: (revision: AgentRevision) => unknown;
  networkPolicyGrant: () => unknown;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function admissionVectors(value: unknown) {
  const vectors = asRecord(value);
  const unprotected = asRecord(vectors?.unprotected);
  const refused = vectors?.refused;
  assert.ok(unprotected && isUnknownArray(refused), "shared admission vectors");
  assert.equal(refused.length, 5, "all malformed admission vectors remain exercised");
  const failures: [Record<string, unknown>, RegExp][] = refused.map((entry) => {
    assert.ok(isUnknownArray(entry) && entry.length === 2, "admission failure pair");
    const revision = asRecord(entry[0]);
    const expected = entry[1];
    assert.ok(
      revision && expected instanceof RegExp,
      "malformed admission vector and refusal oracle",
    );
    return [revision, expected];
  });
  return { unprotected, refused: failures };
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

// These cases intentionally exercise malformed revisions and a partial harness
// context that the supported TypeScript contracts do not permit constructing.
function invoke(method: unknown, receiver: object, ...args: unknown[]): unknown {
  assert.ok(isCallable(method), "Driver method");
  return Reflect.apply(method, receiver, args);
}

function invokeAsync(method: unknown, receiver: object, ...args: unknown[]): Promise<unknown> {
  const result = invoke(method, receiver, ...args);
  assert.ok(result instanceof Promise, "the Driver method must return a Promise");
  const promise: Promise<unknown> = result;
  return promise;
}

export function createStaticEgressAdmissionCases({
  admissionCases,
  networkPolicyGrant,
}: AdmissionDependencies) {
  return {
    registerStartupCases: registerStartupAdmissionCases,
    registerPolicyVersionCases: registerPolicyAdmissionCases,
    registerComputeCase() {
      test("production Compute refuses protected admission and release, including empty plans", async (t) => {
        const compute = createTestKubernetesComputeDriver("admission-cutoff");
        const f = await staticEgressFixture(t);
        const { revision } = await deployedContext(f);
        const admittingCompute = createTestKubernetesComputeDriver("admission-origin", {
          gatewayRuntime: true,
        });
        // Keep valid resolved-provider admission while testing the independent protection gate.
        const computeAdmission = admittingCompute.admitRevision(revision);
        assert.ok(typeof computeAdmission === "string", "resolved-provider Compute admission");
        const admitted = {
          ...revision,
          compute: { ...revision.compute, admission: computeAdmission },
        };
        const { unprotected, refused } = admissionVectors(admissionCases(admitted));
        const cases: [Record<string, unknown> | AgentRevision, RegExp][] = [
          ...refused,
          [admitted, /Protected execution is unavailable/],
          [
            {
              ...admitted,
              credentialSources: [],
              egressPlan: { ...revision.egressPlan, routes: [] },
            },
            /Protected execution is unavailable/,
          ],
        ];
        // Actual shipped Compute entrypoints: no clients are initialized and no cluster exists.
        // Even its runtime-disabled activation fast path must recognize admission first.
        for (const [revision, expected] of cases) {
          assert.throws(
            () => invoke(compute.validateExecutionAdmission, compute, revision),
            expected,
          );
          await assert.rejects(invokeAsync(compute.prepareRevision, compute, revision), expected);
          await assert.rejects(invokeAsync(compute.activateRevision, compute, revision), expected);
        }
        assert.doesNotThrow(() => invoke(compute.validateExecutionAdmission, compute, unprotected));
        await assert.rejects(
          invokeAsync(compute.activateRevision, compute, unprotected),
          /AgentRevision Compute ownership is invalid/,
        );
        const prepared = asRecord(await invokeAsync(compute.prepareRevision, compute, unprotected));
        assert.equal(prepared?.ready, false);
        const unprotectedCompute = asRecord(unprotected.compute);
        assert.ok(unprotectedCompute, "unprotected Compute selection");
        await invokeAsync(compute.activateRevision, compute, {
          ...unprotected,
          gatewayManagedMode: false,
          compute: {
            ...unprotectedCompute,
            id: compute.id,
            implementation: compute.implementation,
          },
        });

        // Source-free runtime authentication retains an empty protected plan. Compute without
        // a qualified protected release must refuse it, even though no credentials are granted.
        assert.ok("createAgent" in f, "fixture Agent helper");
        const controller = asRecord(f)?.controller;
        assert.ok(controller instanceof OpenClawController);
        const emptyAgent = await f.createAgent(
          f.namespace.id,
          "credential-free",
          revision.configuration,
          { executionMode: "dedicated", harnessAuth: { method: "runtime" } },
        );
        const emptyMetadata = await f.deployAgent(f.namespace.id, emptyAgent.id);
        const emptyRevision = await controller.transact((unit) =>
          unit.revisions.findRevision(f.namespace.id, emptyAgent.id, emptyMetadata.id),
        );
        assert.ok(emptyRevision?.egressPlan, "credential-free protected revision");
        assert.deepEqual(emptyRevision.executionAdmission, { version: 3, mode: "protected" });
        assert.deepEqual(emptyRevision.egressPlan.routes, []);
        await assert.rejects(
          compute.prepareRevision(emptyRevision),
          /Protected execution is unavailable/,
        );

        // Exercise the real OCC deploy route with the shipped Compute admission policy.
        // Other Compute operations remain deterministic fixtures; this is not cluster proof.
        let admissionChecks = 0;
        const admission = await staticEgressFixture(t, {
          admitRevision: false,
          appFactory: (context, options) => {
            const driver = asRecord(asRecord(options)?.computeDriver);
            assert.ok(driver, "fixture Compute Driver");
            return createConsoleAppFixture(context, {
              ...options,
              computeDriver: {
                ...driver,
                validateExecutionAdmission(
                  revision: Parameters<typeof compute.validateExecutionAdmission>[0],
                  owner: Parameters<typeof compute.validateExecutionAdmission>[1],
                ) {
                  admissionChecks += 1;
                  compute.validateExecutionAdmission(revision, owner);
                },
              },
            });
          },
        });
        const admissionFixture = asRecord(admission);
        const admissionController = admissionFixture?.controller;
        const admissionAgent = asRecord(admissionFixture?.agent);
        assert.ok(admissionController instanceof OpenClawController);
        const admissionAgentId = admissionAgent?.id;
        assert.ok(typeof admissionAgentId === "string", "undeployed fixture Agent");
        const response: { status: number; body: unknown } = await admission.request(
          "POST",
          `/namespaces/${admission.namespace.id}/agents/${admissionAgentId}/deploy`,
        );
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(asRecord(asRecord(response.body)?.error)?.code, "DEPENDENCY_UNAVAILABLE");
        assert.equal(
          admissionChecks,
          1,
          "the OCC route must reach the shipped Compute admission gate",
        );
        assert.deepEqual(
          await admissionController.transact((unit) =>
            unit.revisions.listRevisions(admission.namespace.id, admissionAgentId),
          ),
          [],
        );
      });
    },
    registerDriverCase() {
      test("the OpenShell Driver refuses a protected revision carrying Agent network policy additions", async (t) => {
        // Finding 2053's provisioning backstop: the protected Sandbox policy is the protected egress
        // profile alone. Admission never stores additions on a protected revision; should one carry
        // them anyway, provisioning refuses it rather than silently dropping them.
        const f = await staticEgressFixture(t);
        const context = await deployedContext(f);
        const { revision } = context;
        const grant = networkPolicyGrant();
        assert.ok(Check(SandboxNetworkGrantSchema, grant), "shared network policy grant");
        const requirements = {
          loginMode: "api_key",
          image: "harness-fixture:local",
          command: ["node", "harness.mjs"],
          workspaceMounts: [],
          credentialAttachments: [],
          proxyWiring: f.attachment,
          labels: { "openclaw.dev/revision": revision.id },
          files: [],
          environment: [],
        };
        await assert.rejects(
          invokeAsync(f.sandboxDriver.provisionHarness, f.sandboxDriver, {
            ...context,
            kubernetes: {},
            signal: AbortSignal.timeout(5000),
            transportToken: "fixture-transport-token",
            requirements,
            revision: {
              ...revision,
              sandboxPolicy: {
                driverId: f.sandboxDriver.id,
                implementation: "openshell",
                version: 2,
                defaults: {},
                additions: [grant],
              },
            },
          }),
          {
            code: "SANDBOX_HARNESS_UNSUPPORTED",
            message:
              "Protected execution keeps only its protected egress policy; this revision carries Agent network policy additions.",
          },
        );
      });
    },
  };
}
