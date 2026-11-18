import { asRecord } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  type WireRequest,
  type WireReply,
} from "./openshell-gateway-wire-fixture.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellSandboxCreateRequest,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { OpenShellGatewayFailure } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts";

export function registerSandboxCases(): void {
  test("OpenShell client serializes v0.1.5 create-time service exposure", async () => {
    const createRequests: WireRequest<"CreateSandbox">[] = [];
    const getRequests: WireRequest<"GetSandbox">[] = [];
    const serviceRequests: WireRequest<"GetService">[] = [];
    const deleteRequests: WireRequest<"DeleteSandbox">[] = [];
    const server = new grpc.Server();

    // Decode with the independently pinned upstream fixture so a production proto
    // field or enum renumbering cannot make both ends agree on an incompatible wire shape.
    addWireService(server, {
      CreateSandbox(call, callback) {
        createRequests.push(call.request);
        if (call.request.name === "sandbox-wire-invalid") {
          callback({
            code: grpc.status.INVALID_ARGUMENT,
            details: "sandbox spec rejected\nby the Kubernetes driver",
          });
          return;
        }
        const omitServiceUrls = call.request.name !== "sandbox-wire";
        callback(null, {
          sandbox: {
            metadata: {
              id: "sandbox-id",
              name: call.request.name,
              workspace: call.request.workspace_scope?.workspace,
              labels: call.request.labels,
            },
          },
          ...(omitServiceUrls
            ? {}
            : {
                service_urls: {
                  "": `http://tenant-workspace--${call.request.name}.openshell.localhost:8080/`,
                },
              }),
        });
      },
      GetSandbox(call, callback) {
        getRequests.push(call.request);
        const created = createRequests.find(({ name }) => name === call.request.name);
        if (created === undefined) {
          callback({ code: grpc.status.NOT_FOUND });
          return;
        }
        callback(null, {
          sandbox: {
            metadata: {
              id: "sandbox-id",
              name: created.name,
              workspace: created.workspace_scope?.workspace,
              labels: created.labels,
              annotations: created.annotations,
            },
            spec: created.spec,
          },
        });
      },
      GetService(call, callback) {
        serviceRequests.push(call.request);
        callback(null, {
          endpoint: {
            sandbox: call.request.sandbox,
            name: call.request.name,
            target_port: 18_790,
            authorization_mode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
          },
          url: `http://tenant-workspace--${call.request.sandbox}.openshell.localhost:8080/`,
        });
      },
      DeleteSandbox(call, callback) {
        deleteRequests.push(call.request);
        callback(null, { outcome: "DELETION_OUTCOME_COMPLETED", sandbox_id: "sandbox-id" });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });

    try {
      const request: OpenShellSandboxCreateRequest = {
        name: "sandbox-wire",
        workspace: "tenant-workspace",
        requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
        labels: { owner: "openclaw" },
        annotations: {},
        serviceExposures: [
          { service: "", targetPort: 18_790, authorizationMode: "bearer_passthrough" },
        ],
        spec: {
          policy: {
            network_policies: {
              model: {
                name: "model",
                binaries: [{ path: "/app/bin/model-client" }],
                endpoints: [
                  {
                    host: "api.openai.com",
                    ports: [443],
                    protocol: "rest",
                    tls: "NETWORK_TLS_MODE_SKIP",
                    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                    access: "NETWORK_ACCESS_PRESET_FULL",
                    path: "/node",
                    websocket_credential_rewrite: true,
                    credential_binding: { provider: "oce-runtime-example" },
                  },
                ],
              },
            },
          },
          restart_policy: "SANDBOX_RESTART_POLICY_ALWAYS",
        },
      };
      const created = await client.createSandbox(request, AbortSignal.timeout(2_000));
      const observed = await client.getSandbox(
        { name: request.name, workspace: request.workspace },
        AbortSignal.timeout(2_000),
      );
      const service = await client.getService(
        request.workspace,
        request.name,
        "",
        AbortSignal.timeout(2_000),
      );
      await client.deleteSandbox(
        { name: request.name, workspace: request.workspace },
        AbortSignal.timeout(2_000),
      );

      assert.equal(created.workspace, "tenant-workspace");
      assert.deepEqual(created.serviceUrls, {
        "": `http://tenant-workspace--${request.name}.openshell.localhost:${port}/`,
      });
      assert.ok(observed && service);
      assert.deepEqual(observed.annotations, request.annotations);
      assert.deepEqual(observed.spec, request.spec);
      assert.equal(service.targetPort, 18_790);
      assert.equal(service.authorizationMode, "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH");
      assert.equal(
        service.advertisedUrl,
        `http://tenant-workspace--${request.name}.openshell.localhost:8080/`,
      );
      assert.equal(
        service.url,
        `http://tenant-workspace--${request.name}.openshell.localhost:${port}/`,
      );
      assert.deepEqual(createRequests[0]?.workspace_scope, {
        workspace: "tenant-workspace",
        selection: "workspace",
      });
      assert.deepEqual(deleteRequests[0]?.workspace_scope, {
        workspace: "tenant-workspace",
        selection: "workspace",
      });
      assert.deepEqual(getRequests[0]?.workspace_scope, {
        workspace: "tenant-workspace",
        selection: "workspace",
      });
      assert.deepEqual(serviceRequests[0], {
        sandbox: request.name,
        name: "",
        workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
      });
      assert.equal(createRequests[0]?.request_id, request.requestId);
      assert.deepEqual(createRequests[0]?.service_exposures, [
        {
          service: "",
          target_port: 18_790,
          authorization_mode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
        },
      ]);
      assert.deepEqual(createRequests[0]?.spec?.policy?.network_policies?.model?.endpoints?.[0], {
        host: "api.openai.com",
        ports: [443],
        protocol: "rest",
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_FULL",
        path: "/node",
        websocket_credential_rewrite: true,
        credential_binding: { provider: "oce-runtime-example" },
      });
      // Field 15 of the pinned gateway's SandboxSpec (finding 1029).
      assert.equal(createRequests[0]?.spec?.restart_policy, "SANDBOX_RESTART_POLICY_ALWAYS");
      assert.deepEqual(createRequests[0]?.spec?.policy?.network_policies?.model?.binaries, [
        { path: "/app/bin/model-client" },
      ]);

      const outboundOnly = await client.createSandbox(
        { ...request, name: "sandbox-wire-outbound-only", serviceExposures: [] },
        AbortSignal.timeout(2_000),
      );
      assert.deepEqual(outboundOnly.serviceUrls, {});
      const optionalExposure = createRequests[1];
      assert.ok(optionalExposure);
      assert.deepEqual(optionalExposure.service_exposures ?? [], []);

      await assert.rejects(
        client.createSandbox(
          { ...request, name: "sandbox-wire-invalid" },
          AbortSignal.timeout(2_000),
        ),
        (error) => {
          assert.ok(error instanceof DependencyUnavailableError);
          assert.equal(asRecord(error)?.grpcStatus, grpc.status.INVALID_ARGUMENT);
          assert.equal(asRecord(error)?.code, undefined);
          assert.equal(error.message, "OpenShell CreateSandbox failed with gRPC status 3.");
          assert.deepEqual(error.requestDiagnostic, {
            method: "CreateSandbox",
            grpcStatus: grpc.status.INVALID_ARGUMENT,
            validationCategory: "UNKNOWN",
          });
          return true;
        },
      );

      await assert.rejects(
        client.createSandbox(
          { ...request, name: "sandbox-wire-missing-service-url" },
          AbortSignal.timeout(2_000),
        ),
        /OpenShell CreateSandbox returned no service URL map/,
      );
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell client reports a Sandbox deleted only once OpenShell confirms it", async () => {
    const deletes: (string | undefined)[] = [];
    const gets: (string | undefined)[] = [];
    // Per Sandbox name: how DeleteSandbox answers, and what GetSandbox reports afterwards.
    const scenarios: Record<
      string,
      {
        delayMs?: number;
        outcome?: string;
        presentFor?: number;
        replacedBy?: string;
        unnamed?: boolean;
        notFound?: boolean;
      }
    > = {
      // Finding 857: OpenShell answers only after the Sandbox Pod's termination grace,
      // which outlasts the ordinary request deadline.
      "sandbox-slow": { delayMs: 1_500, outcome: "DELETION_OUTCOME_COMPLETED" },
      "sandbox-accepted": { outcome: "DELETION_OUTCOME_ACCEPTED", presentFor: 2 },
      "sandbox-no-outcome": { presentFor: 1 },
      "sandbox-replaced": { outcome: "DELETION_OUTCOME_ACCEPTED", replacedBy: "sandbox-id-2" },
      // Without the targeted ID only absence by name counts, so even a replacement holds the
      // wait until the bound.
      "sandbox-stuck": {
        outcome: "DELETION_OUTCOME_ACCEPTED",
        unnamed: true,
        replacedBy: "sandbox-id-2",
      },
      // NOT_FOUND: OpenShell answers it for a Sandbox this identity may not see as for one that
      // is gone (finding 1676), so it confirms nothing and the caller decides with GetWorkspace.
      "sandbox-missing": { notFound: true },
    };
    const server = new grpc.Server();
    addWireService(server, {
      DeleteSandbox(call, callback) {
        deletes.push(call.request.name);
        assert.ok(call.request.name);
        const scenario = scenarios[call.request.name];
        assert.ok(scenario);
        if (scenario.notFound) {
          callback({ code: grpc.status.NOT_FOUND, details: "sandbox not found" });
          return;
        }
        setTimeout(
          () =>
            callback(null, {
              ...(scenario.outcome === undefined ? {} : { outcome: scenario.outcome }),
              ...(scenario.unnamed ? {} : { sandbox_id: "sandbox-id-1" }),
            }),
          scenario.delayMs ?? 0,
        );
      },
      GetSandbox(call, callback) {
        gets.push(call.request.name);
        assert.ok(call.request.name);
        const scenario = scenarios[call.request.name];
        assert.ok(scenario);
        const seen = gets.filter((name) => name === call.request.name).length;
        if (
          scenario.replacedBy === undefined &&
          scenario.presentFor !== undefined &&
          seen > scenario.presentFor
        ) {
          callback({ code: grpc.status.NOT_FOUND });
          return;
        }
        callback(null, {
          sandbox: {
            metadata: {
              id: scenario.replacedBy ?? "sandbox-id-1",
              name: call.request.name,
              workspace: call.request.workspace_scope?.workspace,
            },
          },
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `127.0.0.1:${port}`,
      requestTimeoutMs: 1_000,
      sandboxDeleteTimeoutMs: 3_000,
    });
    const remove = (name: string) =>
      client.deleteSandbox({ name, workspace: "tenant-workspace" }, AbortSignal.timeout(10_000));

    try {
      await remove("sandbox-slow");
      assert.deepEqual([...gets], []);

      await remove("sandbox-accepted");
      assert.deepEqual(gets, ["sandbox-accepted", "sandbox-accepted", "sandbox-accepted"]);

      await remove("sandbox-no-outcome");
      assert.equal(gets.filter((name) => name === "sandbox-no-outcome").length, 2);

      await remove("sandbox-replaced");
      assert.equal(gets.filter((name) => name === "sandbox-replaced").length, 1);

      const started = Date.now();
      await assert.rejects(remove("sandbox-stuck"), (error) => {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.match(error.message, /did not finish it within 3 s/);
        return true;
      });
      assert.ok(Date.now() - started < 5_000);
      await assert.rejects(remove("sandbox-missing"), (error) => {
        assert.ok(error instanceof OpenShellGatewayFailure, String(error));
        assert.match(
          error.message,
          /DeleteSandbox did not find the Sandbox, so the deletion is unconfirmed/,
        );
        // The code the worker's sweep logs apart from a failure (finding 1696).
        assert.equal(asRecord(error)?.code, "SANDBOX_DELETION_UNCONFIRMED");
        assert.equal(asRecord(error.cause)?.code, grpc.status.NOT_FOUND);
        return true;
      });
      assert.equal(gets.includes("sandbox-missing"), false);
      assert.deepEqual(deletes, Object.keys(scenarios));

      const aborted = new AbortController();
      const cancelled = client.deleteSandbox(
        { name: "sandbox-stuck", workspace: "tenant-workspace" },
        aborted.signal,
      );
      setTimeout(() => aborted.abort(new Error("cancelled by test")), 700);
      await assert.rejects(cancelled, /cancelled by test/);
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell client reads an existing Sandbox and its service endpoint", async () => {
    const requests: (
      ["GetSandbox", WireRequest<"GetSandbox">] | ["DeleteService", WireRequest<"DeleteService">]
    )[] = [];
    const notFound = (callback: (error: { code: number }) => void) =>
      callback(Object.assign(new Error("not found"), { code: grpc.status.NOT_FOUND }));
    const server = new grpc.Server();
    addWireService(server, {
      GetSandbox(call, callback) {
        requests.push(["GetSandbox", call.request]);
        if (call.request.name !== "sandbox-wire") {
          notFound(callback);
          return;
        }
        callback(null, {
          sandbox: {
            metadata: {
              id: "sandbox-id",
              name: call.request.name,
              workspace: call.request.workspace_scope?.workspace,
              labels: { owner: "openclaw" },
              annotations: { "openclaw.dev/revision-id": "rev_wire" },
            },
          },
        });
      },
      // Per Sandbox name: how DeleteService answers (finding 1657).
      DeleteService(call, callback) {
        requests.push(["DeleteService", call.request]);
        const outcomes: Record<string, WireReply<"DeleteService">> = {
          "sandbox-wire": { outcome: "DELETION_OUTCOME_COMPLETED" },
          "sandbox-absent": { outcome: "DELETION_OUTCOME_ALREADY_ABSENT" },
          "sandbox-accepted": { outcome: "DELETION_OUTCOME_ACCEPTED" },
          "sandbox-silent": {},
        };
        const answer =
          call.request.sandbox === undefined ? undefined : outcomes[call.request.sandbox];
        if (answer === undefined) {
          notFound(callback);
          return;
        }
        callback(null, answer);
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const signal = AbortSignal.timeout(2_000);
    try {
      // A service is gone on COMPLETED or ALREADY_ABSENT only; an accepted or unstated outcome
      // is not a confirmation, so the exposure is reported as still present. Neither is
      // NOT_FOUND: OpenShell answers it for a Sandbox this identity may not see as for one that
      // is gone (finding 1670), so the caller confirms with a read it can trust.
      for (const sandbox of ["sandbox-wire", "sandbox-absent"]) {
        await client.deleteService("tenant-workspace", sandbox, "", signal);
      }
      for (const sandbox of ["sandbox-accepted", "sandbox-silent"]) {
        await assert.rejects(
          client.deleteService("tenant-workspace", sandbox, "", signal),
          /DeleteService did not confirm deletion/,
        );
      }
      await assert.rejects(
        client.deleteService("tenant-workspace", "sandbox-missing", "", signal),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /DeleteService did not find the Sandbox, so the deletion is unconfirmed/,
          );
          assert.equal(asRecord(error)?.code, "SANDBOX_DELETION_UNCONFIRMED");
          return true;
        },
      );
      const deletions = requests.filter(([method]) => method === "DeleteService");
      assert.equal(deletions.length, 5);
      // The delete is idempotent by itself: no request_id, so no durable admission per pass.
      assert.deepEqual(deletions[0]?.[1], {
        sandbox: "sandbox-wire",
        name: "",
        workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
        allow_missing: true,
      });
      requests.length = 0;
      const sandbox = await client.getSandbox(
        { name: "sandbox-wire", workspace: "tenant-workspace" },
        signal,
      );
      assert.ok(sandbox);
      assert.equal(sandbox.name, "sandbox-wire");
      assert.equal(sandbox.workspace, "tenant-workspace");
      assert.deepEqual(sandbox.annotations, { "openclaw.dev/revision-id": "rev_wire" });
      assert.deepEqual(sandbox.serviceUrls, {});
      assert.equal(
        await client.getSandbox({ name: "missing", workspace: "tenant-workspace" }, signal),
        undefined,
      );
      assert.deepEqual(requests[0], [
        "GetSandbox",
        {
          name: "sandbox-wire",
          workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
        },
      ]);
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell client reads the pinned gateway's Harness restart state from GetSandbox", async () => {
    // SandboxStatus fields 6, 9 and 14 as the gateway sets them (finding 1043).
    const statuses: Record<string, { phase: string; exit_code?: number; restart_count?: number }> =
      {
        "sandbox-restarting": { phase: "SANDBOX_PHASE_STARTING", exit_code: 137, restart_count: 4 },
        "sandbox-exited-zero": { phase: "SANDBOX_PHASE_STARTING", exit_code: 0, restart_count: 1 },
        "sandbox-first-start": { phase: "SANDBOX_PHASE_STARTING" },
        "sandbox-recovered": { phase: "SANDBOX_PHASE_READY", restart_count: 3 },
      };
    const server = new grpc.Server();
    addWireService(server, {
      GetSandbox(call, callback) {
        assert.ok(call.request.name);
        const status = statuses[call.request.name];
        assert.ok(status);
        callback(null, {
          sandbox: {
            metadata: { id: "sandbox-id", name: call.request.name, workspace: "tenant-workspace" },
            status,
          },
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const signal = AbortSignal.timeout(2_000);
    try {
      const read = async (name: string) => {
        const observed = await client.getSandbox({ name, workspace: "tenant-workspace" }, signal);
        assert.ok(observed);
        const { phase, exitCode, restartCount } = observed;
        return { phase, exitCode, restartCount };
      };
      assert.deepEqual(await read("sandbox-restarting"), {
        phase: "SANDBOX_PHASE_STARTING",
        exitCode: 137,
        restartCount: 4,
      });
      // `exit_code` is a proto3 optional: a clean exit is present as 0, not absent.
      assert.deepEqual(await read("sandbox-exited-zero"), {
        phase: "SANDBOX_PHASE_STARTING",
        exitCode: 0,
        restartCount: 1,
      });
      assert.deepEqual(await read("sandbox-first-start"), {
        phase: "SANDBOX_PHASE_STARTING",
        exitCode: undefined,
        restartCount: undefined,
      });
      assert.deepEqual(await read("sandbox-recovered"), {
        phase: "SANDBOX_PHASE_READY",
        exitCode: undefined,
        restartCount: 3,
      });
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });
}
