import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { mock } from "node:test";

export async function loadFirstAgentStack() {
  // The synthetic CLI does not bind ports. Keep the real startup and cleanup path.
  mock.method(net, "createServer", () => ({
    once() {},
    listen(_address: object, ready: () => void) {
      ready();
    },
    address() {
      return { port: 3000 };
    },
    close(done: () => void) {
      done();
    },
  }));
  syncBuiltinESMExports();
  return import("../helpers/local-first-agent-stack.mjs");
}

export function configureFirstAgentStartup() {
  process.env.OCC_TEST_LOCAL_FIRST_AGENT_REAL = "1";
  process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE = "compose";
  process.env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR = "172.20.1.0/24";
  process.env.OCC_TEST_LOCAL_FIRST_AGENT_SANDBOX_DRIVER = "none";
  process.env.OPENAI_API_KEY = "invented-fixture-input";
  delete process.env.OCC_DEVELOPMENT_STATE_DIRECTORY;
  delete process.env.OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE;
}
