import test from "node:test";

import { startCustodyRepositoryOrigin } from "../fixtures/egress-custody-repository-origin.mjs";
import { verifyCredentialFreeReadAndWithdrawal } from "../helpers/egress-credential-free-installed.mjs";
import { admitRepositoryAgent } from "../helpers/egress-custody-installed-agent.mjs";
import { registerCleanupAndStartProvider } from "../helpers/egress-installed-agent.mjs";
import {
  arrangeRealPrerequisites,
  createRunEvidence,
  observePreparedStack,
} from "../helpers/egress-installed-stack.mjs";

const selected = process.env.OCC_TEST_EGRESS_CUSTODY_INSTALLED === "1";

test(
  "explicit protected credential-free read, removal of authority and final route withdrawal",
  {
    skip: selected ? false : "Dedicated installed-custody lane requires a fresh disposable pair.",
    timeout: 74 * 60_000,
  },
  async (t) => {
    const progress = { stage: "input-preflight" };
    const safeError = (error) => {
      // Subprocess diagnostics can carry response or proof bytes.
      const at = error.stack?.match(/egress-[\w.-]+\.mjs:\d+:\d+/)?.[0] ?? "external-operation";
      return Error(
        "Installed custody failed at " +
          progress.stage +
          " (" +
          at +
          "); inspect private phase ledger",
      );
    };
    try {
      const setup = await arrangeRealPrerequisites(
        t,
        progress,
        process.env.OCC_TEST_EGRESS_CONNECTED_INPUTS,
        { wholeExecution: true },
      );
      const evidence = await createRunEvidence(t, setup, progress);
      const stack = await observePreparedStack(t, setup, evidence, progress);
      const owned = await registerCleanupAndStartProvider(
        t,
        setup,
        stack,
        evidence,
        startCustodyRepositoryOrigin,
      );
      progress.stage = "credential-free-agent";
      const admitted = await admitRepositoryAgent(setup, stack, evidence, owned);
      progress.stage = "credential-free-read-and-withdrawal";
      await verifyCredentialFreeReadAndWithdrawal({ setup, stack, evidence, owned, admitted });
    } catch (error) {
      throw safeError(error);
    }
  },
);
