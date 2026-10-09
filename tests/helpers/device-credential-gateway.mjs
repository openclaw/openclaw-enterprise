import assert from "node:assert/strict";

export const DEVICE_ACCESS_TOKEN = "device-access-private-fixture";
export const DEVICE_ACCOUNT_ID = "workspace-fixture";

/**
 * Simulates only the external Credential Gateway contract. OCC still owns source
 * registration, IAM, login-session fencing, and Agent bindings in the callers.
 * This fixture does not prove provider exchange, refresh, or runtime injection.
 */
export function createDeviceCredentialGateway({
  now = () => Date.now(),
  approve = async () => true,
  beforePoll = async () => {},
  startError,
} = {}) {
  const calls = [];
  const sources = new Map();
  const handles = new Map();
  const record = (operation, context) => {
    calls.push({ operation, sourceId: context.source.id });
  };
  return {
    id: "device-credential-gateway",
    capability: "credential_gateway",
    implementation: "test-external-device-service",
    calls,
    sources,
    async listSourceTypes() {
      return [
        {
          type: "codex-device",
          config: [],
          secrets: [],
          rotation: "external",
          deviceAuthorization: { harnessId: "codex" },
          harnessAuth: { modelProvider: "openai", loginMode: "chatgptAuthTokens" },
        },
      ];
    },
    async registerSource(context, input) {
      record("registerSource", context);
      assert.deepEqual(input, { type: "codex-device", config: {}, secrets: {} });
      sources.set(context.source.id, "pending");
      return { state: "pending" };
    },
    async startDeviceAuthorization(context) {
      record("startDeviceAuthorization", context);
      const error = typeof startError === "function" ? startError() : startError;
      if (error !== undefined) {
        throw error;
      }
      assert.equal(sources.has(context.source.id), true, "register the source before login");
      const privateState = `device-private-handle-${crypto.randomUUID()}`;
      handles.set(context.source.id, privateState);
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CODE-12345",
        expiresAt: new Date(now() + 15 * 60 * 1000).toISOString(),
        intervalSeconds: 5,
        privateState,
      };
    },
    async pollDeviceAuthorization(context, privateState) {
      record("pollDeviceAuthorization", context);
      assert.equal(privateState, handles.get(context.source.id));
      await beforePoll();
      if (!(await approve())) {
        return { status: "pending" };
      }
      sources.set(context.source.id, "ready");
      return { status: "ready" };
    },
    async withSourceToken(context, use) {
      record("withSourceToken", context);
      if (sources.get(context.source.id) !== "ready") {
        throw new Error("No warm token is available for this source.");
      }
      return use({ accessToken: DEVICE_ACCESS_TOKEN, accountId: DEVICE_ACCOUNT_ID });
    },
    async sourceStatus(context) {
      record("sourceStatus", context);
      return { state: sources.get(context.source.id) ?? "absent" };
    },
    async removeSource(context) {
      record("removeSource", context);
      sources.delete(context.source.id);
      handles.delete(context.source.id);
    },
    async updateSource() {
      assert.fail("device-login scenarios do not update source inputs");
    },
    async rotateSource() {
      assert.fail("OCC device login and discovery must not refresh or rotate credentials");
    },
    async attachForRevision() {
      assert.fail("this fixture proves API admission, not runtime attachment");
    },
    async attachmentStatus() {
      assert.fail("this fixture proves API admission, not runtime attachment");
    },
    async withdraw() {
      assert.fail("closing a login must not withdraw runtime credentials");
    },
  };
}
