import test from "node:test";

import { runOidcAgentChatScenario } from "../helpers/native-admin-browser.mjs";
import { requiresNativeAdminRouting } from "../helpers/harness-topology-k3d-real.mjs";

test(
  "OIDC owner creates an Agent and a shared operator chats without administrative access",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  runOidcAgentChatScenario,
);
