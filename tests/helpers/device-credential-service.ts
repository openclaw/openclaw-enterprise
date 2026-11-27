import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { PlatformStateStore, OpenClawController } from "../../packages/occ/src/index.ts";
import type { SecretDriver } from "../../packages/contracts/src/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/credential-service/oauth-connection.ts";
import { refreshCodexOAuthGrant } from "../../apps/controller/src/drivers/credential-service/codex-device-authorization.ts";
import { OCCCredentialServiceDriver } from "../../apps/controller/src/drivers/credential-service/occ.ts";

export const DEVICE_ACCOUNT_ID = "workspace-fixture";

const claims = {
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": {
    chatgpt_account_id: DEVICE_ACCOUNT_ID,
    chatgpt_plan_type: "plus",
  },
};
export const DEVICE_OAUTH_ACCESS_TOKEN = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
export const DEVICE_OAUTH_REFRESH_TOKEN = "device-refresh-private-fixture";

type IssuerOperation = "start" | "poll" | "exchange";
export interface DeviceIssuerOptions {
  approve?: () => Promise<boolean>;
  beforeStart?: () => Promise<void>;
  beforePoll?: () => Promise<void>;
  startError?: unknown;
}

/** Control only issuer HTTP; the selected CredentialService, exchange logic and custody remain real. */
export function controlDeviceIssuer(t: TestContext, options: DeviceIssuerOptions = {}) {
  const operations: IssuerOperation[] = [];
  const handles = new Set<string>();
  const originalFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== "https://auth.openai.com") {
        return originalFetch(input, init);
      }
      if (url.pathname === "/api/accounts/deviceauth/usercode") {
        operations.push("start");
        await options.beforeStart?.();
        if (options.startError !== undefined) {
          throw options.startError;
        }
        const handle = randomUUID();
        handles.add(handle);
        return Response.json({ device_auth_id: handle, user_code: "CODE-12345", interval: 5 });
      }
      if (url.pathname === "/api/accounts/deviceauth/token") {
        operations.push("poll");
        const body = JSON.parse(String(init?.body));
        assert.ok(handles.has(body.device_auth_id));
        assert.equal(body.user_code, "CODE-12345");
        await options.beforePoll?.();
        if (options.approve && !(await options.approve())) {
          return new Response(null, { status: 403 });
        }
        return Response.json({ authorization_code: randomUUID(), code_verifier: randomUUID() });
      }
      assert.equal(url.pathname, "/oauth/token");
      operations.push("exchange");
      const form = new URLSearchParams(init?.body as URLSearchParams);
      assert.equal(form.get("grant_type"), "authorization_code");
      return Response.json({
        access_token: DEVICE_OAUTH_ACCESS_TOKEN,
        token_type: "Bearer",
        id_token: DEVICE_OAUTH_ACCESS_TOKEN,
        refresh_token: DEVICE_OAUTH_REFRESH_TOKEN,
      });
    },
  );
  return { operations, handles };
}

export async function installDeviceCredentialService(
  controller: OpenClawController,
  state: PlatformStateStore,
  secrets: SecretDriver,
  driverId = "device-credential-service",
  notifyRenewed?: ConstructorParameters<typeof OAuthAccountTokens>[4],
) {
  assert.ok(secrets.privateSecrets);
  const instanceId = await controller.activateCredentialServiceInstance(driverId, randomUUID());
  const owner = new OCCCredentialServiceDriver(
    driverId,
    controller.installation.id,
    secrets.privateSecrets,
    instanceId,
    state,
    undefined,
    new OAuthAccountTokens(
      state,
      secrets.privateSecrets,
      controller.resolveConnectionClient.bind(controller),
      refreshCodexOAuthGrant,
      notifyRenewed,
    ),
  );
  controller.registerDriver(owner);
  controller.selectDriver("credential_service", owner.id);
  return { owner, instanceId };
}
