import { asRecord } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createManagedWorkloadExec } from "../helpers/egress-managed-workload-exec.ts";
import { agentClients } from "../helpers/egress-custody-observations.mjs";
import { mutualTls } from "./openshell-gateway-wire-tls-cases.ts";
import {
  addWireService,
  bindWireServer,
  grpc,
  type WireRequest,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

export function registerWorkloadCases(): void {
  test("installed workload clients select the enrolled Sandbox at authenticated ExecSandbox; a lost Exit is not replayed", async (t) => {
    const { tls, auth, rootCertificatePath } = await mutualTls(t);
    // Record the real clients' mTLS RPCs, independently of any kubectl or cluster.
    // Only an installed run can establish that the supplier launched the filtered child.
    const binding = { sandboxName: "managed-reader", sandboxId: "enrolled-id" };
    const workspace = "managed-workspace";
    const launches: { request: WireRequest<"ExecSandbox">; dispatch: Dispatch | undefined }[] = [];
    type Dispatch = { phase: string; requestId: string; sandboxId: string };
    const phases: Dispatch[] = [];
    let selectedId = binding.sandboxId;
    let loseExit = false;
    const server = new grpc.Server();
    addWireService(
      server,
      {
        GetSandbox({ request }, callback) {
          callback(null, {
            sandbox: {
              metadata: {
                id: selectedId,
                name: request.name,
                workspace: request.workspace_scope?.workspace,
              },
            },
          });
        },
        ExecSandbox(call) {
          const { request } = call;
          const dispatch = phases.find((entry) => entry.requestId === request.request_id);
          launches.push({ request, dispatch });
          call.write({ stdout: { data: Buffer.from("recipient") } });
          call.write({ stderr: { data: Buffer.from("diagnostic") } });
          call.write({ stdout: { data: Buffer.from("-bytes") } });
          if (!loseExit) {
            call.write({ exit: {} });
          }
          call.end();
        },
      },
      "workload",
    );
    const credentials = grpc.ServerCredentials.createSsl(
      tls.ca,
      [{ cert_chain: tls.cert, private_key: tls.key }],
      true,
    );
    const port = await bindWireServer(server, credentials);
    t.after(() => server.forceShutdown());
    const backend = {
      endpoint: `https://127.0.0.1:${port}`,
      rootCertificatePath,
      auth,
    };
    const gatewayClient = new GrpcOpenShellGatewayClient(backend);
    t.after(() => gatewayClient.close());
    const managedExec: (
      context: TestContext,
      options: {
        backend: typeof backend;
        workspace: string;
        gatewayClient: GrpcOpenShellGatewayClient;
        checkpoint(phase: string, details: Omit<Dispatch, "phase">): void;
      },
    ) => (
      binding: { sandboxName: string; sandboxId: string },
      command: string[],
    ) => Promise<unknown> = createManagedWorkloadExec;
    const execWorkload = managedExec(t, {
      backend,
      workspace,
      gatewayClient,
      checkpoint: (phase: string, details: { requestId: string; sandboxId: string }) => {
        phases.push({ phase, ...details });
      },
    });
    const inAgent = async (...command: string[]) => {
      const result: unknown = await execWorkload(binding, command);
      const { stdout, stderr, exitCode } = asRecord(result) ?? {};
      assert.ok(Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr));
      assert.equal(exitCode, 0);
      assert.equal(stderr.toString(), "diagnostic");
      return stdout.toString();
    };
    const target = "https://provider.test/repos/fixture/repository";
    const clients: (
      options: { inAgent: (...command: string[]) => Promise<string> },
      origin: string,
    ) => { curl(): unknown; throughFin(): unknown } = agentClients;
    const { curl, throughFin } = clients({ inAgent }, new URL(target).origin);
    assert.deepEqual(await Promise.all([curl(), throughFin()]), [
      "recipient-bytes",
      "recipient-bytes",
    ]);

    assert.deepEqual(launches.map(({ request }) => request.command?.[0]).sort(), ["curl", "node"]);
    for (const { request, dispatch } of launches) {
      assert.equal(request.sandbox, binding.sandboxName);
      assert.equal(request.workspace_scope?.workspace, workspace);
      assert.equal(request.command?.at(-1), target, "ordinary argv, not a shell command string");
      assert.equal(request.no_login_shell, true);
      assert.equal(request.execution_timeout?.seconds, "120");
      assert.ok(dispatch);
      assert.equal(
        dispatch.phase,
        "managed-workload-exec-dispatch-unknown",
        "persisted before launch",
      );
      assert.equal(dispatch.sandboxId, binding.sandboxId);
    }
    const [first, second] = launches;
    assert.ok(first?.dispatch && second?.dispatch);
    assert.notEqual(first.dispatch.requestId, second.dispatch.requestId);

    loseExit = true;
    await assert.rejects(async () => await curl(), /Unconfirmed managed workload exec/);
    assert.equal(
      launches.length,
      3,
      "even clean gRPC completion cannot cause a missing Exit to be retried",
    );
    const unconfirmed = phases.at(-1);
    assert.equal(unconfirmed?.phase, "managed-workload-exec-unconfirmed");
    const third = launches[2];
    assert.ok(unconfirmed && third?.dispatch);
    assert.equal(unconfirmed.requestId, third.dispatch.requestId);

    selectedId = "replaced-id";
    await assert.rejects(async () => await curl(), /supplier Sandbox replaced/);
    assert.equal(launches.length, 3, "an old enrolled recipient never silently switches Sandbox");
  });
}
