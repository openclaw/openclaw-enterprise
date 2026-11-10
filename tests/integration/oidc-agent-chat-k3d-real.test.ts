import test from "node:test";

import { runOidcAgentChatScenario } from "../helpers/native-admin-browser.mjs";
import { requiresNativeAdminRouting } from "../helpers/harness-topology-k3d-real.mjs";

for (const createAccounts of [false, true]) {
  test(
    `OIDC linking preserves Agent access with account creation ${createAccounts ? "enabled" : "disabled"}`,
    { ...requiresNativeAdminRouting, timeout: 1_200_000 },
    // Linking must use both proofs even when ordinary sign-in can create accounts.
    (context) => runOidcAgentChatScenario(context, { createAccounts }),
  );
}
