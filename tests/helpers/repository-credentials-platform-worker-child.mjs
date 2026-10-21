import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { installRepositoryMaterialExpiryProbe } from "./repository-material-expiry-probe.mjs";

let worker;
let receiptServer;

process.once("message", async ({ databaseUrl, configFile }) => {
  try {
    const drivers = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: configFile },
    });
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    if (drivers.repositoryOwner?.controlSocket !== undefined) {
      receiptServer = await startRepositoryReceiptServer({
        ...drivers.repositoryOwner,
        state: new PostgresPlatformState(pool),
      });
    }
    worker = createControllerWorker({
      mode: "production",
      pool,
      drivers,
      pollIntervalMs: 25,
      leaseDurationMs: 6_000,
      maxAttempts: 30,
      emit: (event) => process.send({ type: "event", event }),
    });
    await worker.start();
    let expiryProbe;
    process.on("message", async (message) => {
      if (message.type !== "material-expiry-command") {
        return;
      }
      try {
        if (message.action === "arm") {
          expiryProbe ??= await installRepositoryMaterialExpiryProbe(
            drivers.computeDriver,
            (event) => process.send(event),
          );
          expiryProbe.arm(message.id, message.agentId);
        } else if (message.action === "release") {
          expiryProbe.release(message.id, message.proceed);
        } else if (message.action === "finish") {
          expiryProbe.finish(message.id);
        } else if (message.action !== "inspect") {
          throw new Error("Unknown probe command.");
        }
        const result = message.action === "inspect" ? expiryProbe.inspect(message.id) : undefined;
        process.send({ type: "material-expiry-response", requestId: message.requestId, result });
      } catch {
        process.send({
          type: "material-expiry-response",
          requestId: message.requestId,
          failed: true,
        });
      }
    });
    process.send({ type: "ready" });
  } catch {
    // Configuration and database errors may contain private connection details.
    process.exit(1);
  }
});

process.once("SIGTERM", async () => {
  try {
    await receiptServer?.close();
    await worker?.stop();
    process.exit(0);
  } catch {
    process.exit(1);
  }
});

// Losing the test runner must not strand the separately owned worker.
process.once("disconnect", () => process.exit(1));
