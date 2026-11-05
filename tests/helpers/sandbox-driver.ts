import type { SandboxDriver } from "../../packages/contracts/src/index.ts";

/** Explicit mode declaration for fixture Drivers that can host Dedicated OpenClaw. */
export const DEDICATED_OPENCLAW_SUPPORT: SandboxDriver["supportsHarnessExecutionMode"] =
  Object.freeze({
    openclaw: Object.freeze({
      embedded: Object.freeze({ supported: false }),
      dedicated: Object.freeze({ supported: true }),
    }),
  });
