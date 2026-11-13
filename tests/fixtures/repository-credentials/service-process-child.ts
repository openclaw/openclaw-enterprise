import type { RunningService } from "../../../apps/controller/src/composition/repository-credentials/service.ts";
import type { ServiceConfig } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { createControlledClock } from "./clock.mjs";
import type { createTlsMaterial } from "./process.mjs";
import { appModule } from "./runtime.mjs";

export type ServiceProcessRequest = { id: number } & (
  | {
      command: "start";
      input: {
        config: ServiceConfig;
        tls: Awaited<ReturnType<typeof createTlsMaterial>>;
        origin: string;
        wallMs: number;
        registryFile: string;
        socketPath: string;
      };
    }
  | { command: "advance"; input: { milliseconds: number; wallDelta?: number } }
);

export type ServiceProcessGeneration = { pid: number; port: number };

type ServiceProcessReply = { id: number } & (
  | { result: ServiceProcessGeneration }
  | { result: { wallMs: number } }
  | { error: "service fixture command failed" }
);

let clock: ReturnType<typeof createControlledClock> | undefined;
let running: RunningService | undefined;

function reply(message: ServiceProcessReply) {
  process.send?.(message);
}

// Only the owning test process can supply trusted composition and move time.
// Session operations still traverse the production Unix/HTTPS listeners.
process.on("message", async ({ id, command, input }: ServiceProcessRequest) => {
  try {
    if (command === "start" && !running) {
      clock = createControlledClock(input.wallMs);
      const { config, tls, origin } = input;
      const [{ loadGitHubRepositoryRegistry }, { createPreparedGitHubRegistryFactory }]: [
        typeof import("../../../apps/controller/src/composition/repository-credentials/registry.ts"),
        typeof import("../../../apps/controller/src/drivers/repo/github/access/warm-registry-factory.ts"),
      ] = await Promise.all([
        appModule("composition/repository-credentials/registry"),
        appModule("drivers/repo/github/access/warm-registry-factory"),
      ]);
      const registry = await loadGitHubRepositoryRegistry(input.registryFile, "github-fixture");
      const factory = createPreparedGitHubRegistryFactory({
        registry,
        socketPath: input.socketPath,
        gatewayOrigin: config.gateway.publicOrigin,
        limits: config.limits,
        clock,
        apiOrigin: origin,
        gitOrigin: origin,
      });
      const {
        runService,
      }: typeof import("../../../apps/controller/src/composition/repository-credentials/service.ts") =
        await appModule("composition/repository-credentials/service");
      running = await runService(
        {
          config,
          factory,
          authority: "github-prepared-git-registry",
          tls,
          trustedUpstreamOrigins: new Set([origin]),
          upstreamCa: tls.ca,
          close() {},
        },
        clock,
      );
      reply({ id, result: { pid: process.pid, port: running.listeners.address.port } });
    } else if (command === "advance" && running && clock) {
      await clock.advance(input.milliseconds, input.wallDelta);
      reply({ id, result: { wallMs: clock.wallNow() } });
    } else {
      throw new Error("invalid fixture command");
    }
  } catch {
    // Never send keys, bearer material, provider packets or assertion values over logs.
    reply({ id, error: "service fixture command failed" });
  }
});

// An interrupted runner must not strand a service process or its listeners.
process.once("disconnect", () => process.exit(1));
