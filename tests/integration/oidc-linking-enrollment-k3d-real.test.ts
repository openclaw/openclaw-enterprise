import test from "node:test";

import { runOidcAgentChatScenario } from "../helpers/native-admin-browser.mjs";
import { requiresNativeAdminRouting } from "../helpers/harness-topology-k3d-real.mjs";

// This file gets a separate prepared database: the first scenario's linked
// subjects and manually created accounts must not become this scenario's setup.
test(
  "OIDC linking preserves Agent access with account creation enabled",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  (context) => runOidcAgentChatScenario(context, { createAccounts: true }),
);
