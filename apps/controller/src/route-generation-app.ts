import { randomBytes } from "node:crypto";

import { InMemoryAuditSink } from "@openclaw-enterprise/audit";
import { createNativeIAMDriver } from "@openclaw-enterprise/iam";

import { createControllerAuth, OCC_AUTH_COOKIE_PREFIX } from "./auth/index.ts";
import { createFastifyApp } from "./index.ts";

// Keep Fastify's Swagger type augmentation visible to the generator project.
export type {} from "@fastify/swagger";

const installationId = "ins_6054d30d-0f89-4cd0-aa56-2b76e3c5fb52";

// Build commands register the real routes without serving requests.
export function createRouteGenerationApp(maxBodyBytes?: number) {
  return createFastifyApp({
    development: { enabled: true, installationId },
    auth: {
      ...createControllerAuth({
        mode: "development",
        installationId,
        baseURL: "https://console.oce.localhost",
        agentDomain: "agents.oce.localhost",
        secret: randomBytes(48).toString("base64url"),
      }),
      // Keep the session cookie name used by the generated OpenAPI contract.
      sessionCookieName: `${OCC_AUTH_COOKIE_PREFIX}.session_token`,
    },
    iamDriver: createNativeIAMDriver({
      async loadNativeIAMState() {
        throw new Error("IAM state is unavailable during route generation.");
      },
    }),
    auditSink: new InMemoryAuditSink(),
    resolveHarness() {
      throw new Error("Harness resolution is unavailable during route generation.");
    },
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  });
}
