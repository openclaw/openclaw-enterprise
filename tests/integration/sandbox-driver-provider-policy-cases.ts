import assert from "node:assert/strict";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { SandboxPolicySnapshot } from "../../packages/contracts/src/index.ts";
import type { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Provision = () => ReturnType<OpenShellSandboxDriver["provisionHarness"]>;
type OpenShellPolicyUpdate = () => ReturnType<OpenShellSandboxDriver["applyNetworkPolicy"]>;
type GoogleClient = Pick<ReturnType<typeof workspaceGatewayClient>, "providers" | "profiles"> &
  Pick<OpenShellGatewayClient, "getGatewayInfo">;
type CreatedSandbox = {
  spec: {
    providers: string[];
    policy: { network_policies: Record<string, object | undefined> };
  };
};

export async function verifyGoogleAdmissionRefusals({
  ensureNamespace,
  provisionWithoutCredentials,
  client,
  provision,
  getCreated,
  negotiatedGoogleGuard,
  setPolicy,
  clearPolicy,
}: {
  ensureNamespace: () => ReturnType<OpenShellSandboxDriver["ensureNamespace"]>;
  provisionWithoutCredentials: Provision;
  client: GoogleClient;
  provision: Provision;
  getCreated: () => Pick<OpenShellSandboxResponse, "name"> | undefined;
  setPolicy: (policy: Pick<SandboxPolicySnapshot, "defaults" | "additions">) => void;
  clearPolicy: () => void;
  negotiatedGoogleGuard: () => { implementation_name: string } & Record<
    string,
    string | number | string[]
  >;
}) {
  await ensureNamespace();
  await assert.rejects(provisionWithoutCredentials(), /selected OpenShell provider/);
  const service = negotiatedGoogleGuard();
  client.getGatewayInfo = async () => ({ extensions: [service] });
  service.implementation_name = "other/response-only";
  await assert.rejects(provision, /has not negotiated/);
  assert.equal(getCreated(), undefined);
  assert.equal(client.providers.size, 0);
  assert.equal(client.profiles.size, 0);
  Object.assign(service, negotiatedGoogleGuard());
  setPolicy({
    defaults: {},
    additions: [
      {
        id: "wide",
        host: "gmail.googleapis.com",
        ports: [{ from: 443, to: 443 }],
        binary: "/usr/bin/curl",
      },
    ],
  });
  await assert.rejects(provision, /bypass the managed plugin/);
  clearPolicy();
}

export async function verifySlackLivePolicyAndDetach({
  admitStandardPolicy,
  detachCredentials,
  applyBroadPolicy,
  applyUnrelatedPolicy,
  provision,
  getUpdateCount,
  setBroadenEffective,
  getCreated,
  setCreated,
  ref,
  route,
  routeName,
}: {
  admitStandardPolicy: () => void;
  detachCredentials: () => void;
  applyBroadPolicy: OpenShellPolicyUpdate;
  applyUnrelatedPolicy: OpenShellPolicyUpdate;
  provision: Provision;
  getUpdateCount: () => number;
  setBroadenEffective: (value: boolean) => void;
  getCreated: () => CreatedSandbox | undefined;
  setCreated: (value: undefined) => void;
  ref: string;
  route: { endpoints: [{ mcp: { _strict_tool_names?: string } }, ...object[]] };
  routeName: string;
}) {
  admitStandardPolicy();
  await assert.rejects(applyBroadPolicy(), /overlaps the credentialed managed MCP endpoint/);
  assert.equal(getUpdateCount(), 0);
  await applyUnrelatedPolicy();
  assert.equal(getUpdateCount(), 1);
  setBroadenEffective(true);
  await assert.rejects(provision, /overlaps the credentialed managed MCP endpoint/);
  setBroadenEffective(false);

  detachCredentials();
  await assert.rejects(provision, /exact AgentRevision ownership and content/);
  const created = getCreated();
  assert.ok(created);
  created.spec.providers = created.spec.providers.filter((name) => name !== ref);
  route.endpoints[0].mcp._strict_tool_names = "strict_tool_names";
  await provision();
  setCreated(undefined);
  await provision();
  const detached = getCreated();
  assert.ok(detached);
  assert.equal(detached.spec.policy.network_policies[routeName], undefined);
  assert.ok(!detached.spec.providers.includes(ref));
}
