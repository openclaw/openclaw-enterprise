import test from "node:test";

import { publicEgressWatchdogMs } from "../helpers/public-egress-deadline.ts";
import { runPublicEgressConnected } from "../helpers/public-egress-workflow.ts";

const selected = process.env.OCC_TEST_PUBLIC_EGRESS === "1";

test(
  "a protected Agent admits public TCP only in its frozen public egress mode",
  { skip: !selected, timeout: publicEgressWatchdogMs },
  async (t) => {
    await runPublicEgressConnected({
      signal: t.signal,
      diagnostic: (message) => t.diagnostic(message),
    });
  },
);
