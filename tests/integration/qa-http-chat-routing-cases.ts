import assert from "node:assert/strict";
import test from "node:test";
import { verifyQaHttpChatIsolation } from "../helpers/qa-http-chat-isolation.ts";

type Fixture = Parameters<typeof verifyQaHttpChatIsolation>[0];
type Agent = Parameters<typeof verifyQaHttpChatIsolation>[1];

// Identities and expected hosts from the rendered production chart with default
// values and with the release, Gateway name and Envoy namespace overridden.
const defaultRouting = {
  gatewayNamespace: "oce-system",
  gatewayName: "openclaw-enterprise-agent-gateways",
  envoyNamespace: "envoy-gateway-system",
};
const customRouting = {
  gatewayNamespace: "qa-control",
  gatewayName: "qa-gateway",
  envoyNamespace: "qa-proxy",
};

function routingFixture(routing: object, controlPlane: "kubernetes" | "compose" = "kubernetes") {
  const stopped = new Error("stopped at QA HTTP chat transport");
  const authorities: string[] = [];
  function recordAuthority(args: string[]): never {
    authorities.push(new URL(args.at(-1)!).host);
    throw stopped;
  }

  // Supply the immutable image metadata the verifier already requires. Stop at
  // the first transport handoff so the fixture runs no commands or requests.
  const fixture = {
    controlPlane,
    configuration: { drivers: { compute: { configuration: { gatewayRouting: routing } } } },
    state: { platformNamespace: "oce-system" },
    async pod() {
      const image = `example.test/gateway@sha256:${"a".repeat(64)}`;
      return { spec: { containers: [{ name: "gateway", image }] } };
    },
    async kubectl(scope: string, _namespace: string, verb: string, ...args: string[]) {
      assert.equal(controlPlane, "kubernetes");
      assert.equal(scope, "-n");
      assert.equal(verb, "exec", "Gateway routing must not look up cluster metadata");
      recordAuthority(args);
    },
    async compose(verb: string, ...args: string[]) {
      assert.equal(controlPlane, "compose");
      assert.equal(verb, "exec");
      recordAuthority(args);
    },
  };
  const agent = { namespaceId: "ns-default", id: "agt-test", revision: { id: "rev-test" } };
  return {
    verify: () => verifyQaHttpChatIsolation(fixture as unknown as Fixture, agent as Agent),
    authorities,
    stopped,
  };
}

export function registerQaHttpChatRoutingCases(): void {
  const cases = [
    {
      name: "QA HTTP chat uses the default chart Gateway hostname when omitted",
      routing: defaultRouting,
      authority: "occ-gateway-acce0c8a7f22.envoy-gateway-system.svc",
    },
    {
      name: "QA HTTP chat uses the chart Gateway hostname for custom Kubernetes namespaces",
      routing: customRouting,
      authority: "occ-gateway-8e72fad22423.qa-proxy.svc",
    },
    {
      name: "QA HTTP chat preserves the explicit Kubernetes Gateway hostname and port",
      routing: { ...customRouting, hostname: "qa.example.test", endpointPort: 8443 },
      authority: "qa.example.test:8443",
    },
    {
      name: "QA HTTP chat preserves the explicit Compose Gateway hostname and port",
      routing: { hostname: "qa.example.test", endpointPort: 9443 },
      controlPlane: "compose" as const,
      authority: "qa.example.test:9443",
    },
  ];
  for (const { name, routing, authority, controlPlane } of cases) {
    test(name, async () => {
      const { verify, stopped, authorities } = routingFixture(routing, controlPlane);
      await assert.rejects(verify(), (error) => error === stopped);
      assert.deepEqual(authorities, [authority]);
    });
  }

  test("QA HTTP chat refuses malformed or missing Kubernetes Gateway identity before transport", async () => {
    for (const invalidIdentity of [
      { gatewayNamespace: "invalid.namespace" },
      { gatewayName: undefined },
      { envoyNamespace: "invalid.namespace" },
    ]) {
      const { verify, authorities } = routingFixture({ ...defaultRouting, ...invalidIdentity });
      await assert.rejects(verify(), /requires valid Installation Gateway routing identity/);
      assert.deepEqual(authorities, []);
    }
  });
}
