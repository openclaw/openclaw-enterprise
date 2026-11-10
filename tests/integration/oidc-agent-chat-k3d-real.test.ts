import test from "node:test";

import { runOidcAgentChatScenario } from "../helpers/native-admin-browser.mjs";
import { requiresNativeAdminRouting } from "../helpers/harness-topology-k3d-real.mjs";

test(
  "OIDC linking preserves Agent access with account creation disabled",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  (context) => runOidcAgentChatScenario(context),
);
