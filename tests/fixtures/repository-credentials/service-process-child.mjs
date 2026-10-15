import { createPrivateKey } from "node:crypto";
import { appModule } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { createGitHubServiceFactory } from "./service-resources.mjs";
import { fixtureAppId } from "./github.mjs";

const keyDisposals = [];
let clock;
let running;

// Only the owning test process can supply trusted composition and move time.
// Session operations still traverse the production Unix/HTTPS listeners.
process.on("message", async ({ id, command, input }) => {
  try {
    if (command === "start" && !running) {
      clock = createControlledClock(input.wallMs);
      const { config, tls, origin } = input;
      let factory;
      if (input.registryFile) {
        const [
          { loadGitHubRepositoryRegistry },
          { createGitHubRegistryDriverFactory },
          { createGitHubKeyOwner },
        ] = await Promise.all([
          appModule("composition/repository-credentials/registry"),
          appModule("drivers/repo/github/credentials/registry-factory"),
          appModule("drivers/repo/github/credentials/material"),
        ]);
        const key = createGitHubKeyOwner({
          privateKey: createPrivateKey(input.privateKey),
          appId: fixtureAppId,
          clock,
        });
        keyDisposals.push(() => key.close());
        const registry = await loadGitHubRepositoryRegistry(input.registryFile, "github-fixture");
        factory = createGitHubRegistryDriverFactory({
          registry,
          authority: key,
          privateKeyFile: input.privateKeyFile,
          gatewayOrigin: config.gateway.publicOrigin,
          limits: config.limits,
          clock,
          trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: tls.ca },
        });
      } else {
        factory = await createGitHubServiceFactory(
          { after: (dispose) => keyDisposals.push(dispose) },
          {
            config,
            clock,
            privateKey: createPrivateKey(input.privateKey),
            trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: tls.ca },
          },
        );
      }
      const { runService } = await appModule("composition/repository-credentials/service");
      running = await runService(
        {
          config,
          factory,
          tls,
          trustedUpstreamOrigins: new Set([origin]),
          upstreamCa: tls.ca,
          // The factory registers synchronous key disposal, matching runService's
          // loaded-configuration close contract even though these tests use SIGKILL.
          close() {
            for (const dispose of keyDisposals.splice(0).reverse()) {
              dispose();
            }
          },
        },
        clock,
      );
      process.send({ id, result: { pid: process.pid, port: running.listeners.address.port } });
    } else if (command === "advance" && running) {
      await clock.advance(input.milliseconds, input.wallDelta);
      process.send({ id, result: { wallMs: clock.wallNow() } });
    } else {
      throw new Error("invalid fixture command");
    }
  } catch {
    // Never send keys, bearer material, provider packets or assertion values over logs.
    process.send({ id, error: "service fixture command failed" });
  }
});

// An interrupted runner must not strand a service process or its listeners.
process.once("disconnect", () => process.exit(1));
