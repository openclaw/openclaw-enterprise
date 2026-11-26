import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import type { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { OpenShellProviderProfile } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  LegacyCredentialSource,
  Namespace,
  OpenShellBackendConfiguration,
} from "../../packages/contracts/src/index.ts";
import { storedCredentialSourceConfig } from "../helpers/refusal-text.mjs";

type SourceConfig = LegacyCredentialSource["config"];
type RefusalField = "authorized_base_url" | "host" | "token_url";
type RulePoint = "validate" | "attach";
type RuleRow = readonly [value: string, ...points: [RulePoint, ...RulePoint[]]];

interface StoredSource {
  readonly stored: LegacyCredentialSource;
  readonly name: string;
  readonly profileKey: string;
}

interface EndpointFixture {
  readonly namespace: Pick<Namespace, "id" | "name">;
  readonly profiles: Map<string, OpenShellProviderProfile>;
  readonly providers: { readonly size: number };
  readonly mutations: string[];
  validate(
    type: string,
    config: SourceConfig,
  ): ReturnType<OpenShellCredentialGatewayDriver["validateSourceConfig"]>;
  assertNothingSaved(): Promise<void>;
  seedStored(type: string, config: SourceConfig): StoredSource;
  seedStoredRecord(type: string, config: SourceConfig): Promise<StoredSource>;
  attach(
    stored: LegacyCredentialSource,
  ): ReturnType<OpenShellCredentialGatewayDriver["attachForRevision"]>;
}

interface EndpointSuite {
  fixture(
    t: TestContext,
    options?: {
      toolSources?: boolean;
      gateway?: OpenShellBackendConfiguration;
      modelProvider?: { protocol: "openai-responses"; baseUrl: string };
    },
  ): Promise<EndpointFixture>;
  toolTypes: readonly string[];
  oauth2Types: readonly string[];
}

const TOKEN_URL_MESSAGE = {
  host: (type: string) =>
    `The ${type} token_url host must be a DNS name with at least two labels, not an IP address or a localhost or localdomain name.`,
  port: (type: string) => `The ${type} token_url port must be 1 to 65535.`,
  gateway: (type: string) =>
    `The ${type} token_url host must not be a Kubernetes Pod name or a name in the OpenShell gateway's namespace.`,
};

// Each row names the boundaries that exercise it. Attach uses a source saved before the rule.
function checkedAt(rows: readonly RuleRow[], point: RulePoint): string[] {
  return rows.filter(([, ...points]) => points.includes(point)).map(([value]) => value);
}

function storedConfigRefusal(field: RefusalField, label: string = field) {
  return (error: unknown) => {
    assert.ok(error instanceof Error, label);
    assert.equal(error.name, "StoredCredentialSourceConfigError", label);
    assert.equal(error.message, storedCredentialSourceConfig(field), label);
    return true;
  };
}

export function registerCredentialSourceEndpointCases({
  fixture,
  toolTypes,
  oauth2Types,
}: EndpointSuite): void {
  test("concrete credential authorizations retain normalized profile scope", async (t) => {
    const cases: readonly (readonly [string, string, number, string])[] = [
      ["https://models.example.test/v1", "models.example.test", 443, "/v1/**"],
      ["https://MODELS.example.test:443/api/./v1/", "models.example.test", 443, "/api/v1/**"],
      [
        "https://bücher.example.test:8443/api/v1/",
        "xn--bcher-kva.example.test",
        8443,
        "/api/v1/**",
      ],
      ["https://API.OpenAI.com:443/v1/", "api.openai.com", 443, "/v1/**"],
      // Spellings the URL parser rewrites: the source stores and returns the rewritten URL.
      ["HTTPS://models.example.test/v1", "models.example.test", 443, "/v1/**"],
      ["https://models.example.test:00443/v1", "models.example.test", 443, "/v1/**"],
      ["https://ｍｏｄｅｌｓ.example.test/v1", "models.example.test", 443, "/v1/**"],
      ["https:\\\\models.example.test/v1", "models.example.test", 443, "/v1/**"],
    ];
    for (const [authorized_base_url, host, port, path] of cases) {
      const normalized = `https://${host}${port === 443 ? "" : ":" + port}${path.slice(0, -3)}`;
      const f = await fixture(t, {
        modelProvider: { protocol: "openai-responses", baseUrl: normalized },
      });
      const { stored, profileKey } = f.seedStored("openai", { authorized_base_url });
      await f.attach(stored);
      const profile = f.profiles.get(profileKey);
      assert.ok(profile, "a retained Source must attach its exact profile");
      assert.deepEqual(profile.endpoints, [{ host, port, protocol: "rest", path }]);
    }
  });

  test("credential source endpoints refuse spellings the URL parser would rewrite", async (t) => {
    const f = await fixture(t);
    // Each parses as https://models.example.test/v1, so it used to be stored as written while the
    // profile used another URL (finding 1292). The shared baseUrl rules refuse these spellings.
    for (const [authorized_base_url, message] of [
      ["https://@models.example.test/v1", /must not contain user info or an @ before the host/],
      ["https://:@models.example.test/v1", /must not contain user info or an @ before the host/],
      ["https:models.example.test/v1", /must start with https:\/\/ \(the \/\/ after the scheme/],
      ["https:/models.example.test/v1", /must start with https:\/\/ \(the \/\/ after the scheme/],
      ["https:///models.example.test/v1", /requires HTTPS/],
      ["  https://models.example.test/v1  ", /must not contain spaces or control characters/],
      ["https://models.example.test\t/v1", /must not contain spaces or control characters/],
      ["https://models.exam\nple.test/v1", /must not contain spaces or control characters/],
      // The API schema already refuses a NUL in any string (INVALID_FORMAT).
    ] as const) {
      assert.throws(
        () => f.validate("openai", { authorized_base_url }),
        { name: "CredentialSourceConfigError", message },
        JSON.stringify(authorized_base_url),
      );
    }
    await f.assertNothingSaved();
  });

  test("credential source endpoints require an exact DNS host name", async (t) => {
    const f = await fixture(t);
    // The bearer-token host rule: IP addresses in any spelling the URL parser accepts, and labels
    // with `_` or an edge `-`, widened the member's Sandbox egress (finding 1293).
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "192.0.2.1",
      "169.254.169.254",
      "0x7f000001",
      "2130706433",
      "127.1",
      "models_internal.example.test",
      "-models.example.test",
      "models-.example.test",
    ]) {
      assert.throws(
        () => f.validate("openai", { authorized_base_url: `https://${host}/v1` }),
        {
          name: "CredentialSourceConfigError",
          message: "The openai authorized_base_url host must be an exact DNS name.",
        },
        host,
      );
    }
    await f.assertNothingSaved();
    // A source stored before the rule, with its provider, cannot be attached to a new revision,
    // nor can its value be replaced: a 409 that names the replacement, not a 404 (finding 2536).
    const { stored } = await f.seedStoredRecord("openai", {
      authorized_base_url: "https://169.254.169.254/v1",
    });
    await assert.rejects(f.attach(stored), storedConfigRefusal("authorized_base_url"));
    assert.equal(f.profiles.size, 0);
    assert.ok(!f.mutations.includes("updateProvider"));
  });

  test("bearer-token and OAuth2 hosts must not end in a numeric or 0x label", async (t) => {
    const f = await fixture(t, { toolSources: true });
    // The URL parser and inet_aton-style resolvers (glibc's, the Sandbox proxy's) read a host whose
    // last label is a decimal or 0x number as an IPv4 address (finding 1360). Stored sources are
    // checked at attach too, and a stored DNS host still attaches (finding 1363).
    const refused: readonly RuleRow[] = [
      ["0xa000005", "validate", "attach"],
      ["0xa.0.0.5", "validate"],
      ["10.0x0.0.5", "validate"],
      ["0x7f.0x1", "validate", "attach"],
      ["0xa9.0xfe.0xa9.0xfe", "validate"],
      ["example.123", "validate", "attach"],
      ["example.123.", "attach"],
      ["example.0x", "validate", "attach"],
      ["api.example.0x10", "validate"],
      ["10.0.0.5", "attach"],
      ["169.254.169.254", "attach"],
    ];
    const accepted: readonly RuleRow[] = [
      ["api.example.com", "validate", "attach"],
      ["a1.example.com", "validate"],
      ["0xdead.example.com", "validate", "attach"],
      ["123.example.com", "validate", "attach"],
      // Only a whole-label number is one; this last label is a name.
      ["example.0xg", "validate"],
    ];
    const message = (type: string) => `The ${type} host must be an exact DNS name.`;
    for (const type of toolTypes) {
      for (const host of checkedAt(refused, "validate")) {
        assert.throws(
          () => f.validate(type, { host }),
          { name: "CredentialSourceConfigError", message: message(type) },
          host,
        );
      }
      for (const host of checkedAt(accepted, "validate")) {
        assert.doesNotThrow(() => f.validate(type, { host }), host);
      }
    }
    await f.assertNothingSaved();
    // A refused stored source's profile is not written either. Only a stored source reaches the
    // profile check, so it names the replacement (finding 2536).
    for (const type of toolTypes) {
      for (const host of checkedAt(refused, "attach")) {
        await assert.rejects(
          f.attach(f.seedStored(type, { host }).stored),
          storedConfigRefusal("host", host),
        );
      }
      if (type !== "bearer-token") {
        const { stored } = f.seedStored(type, {
          host: "0x7f.0x1",
          token_url: "https://169.254.169.254/token",
        });
        await assert.rejects(f.attach(stored), storedConfigRefusal("host", "with token_url"));
      }
      assert.equal(f.profiles.size, 0, type);
      assert.deepEqual(f.mutations, [], type);
      for (const host of checkedAt(accepted, "attach")) {
        const { stored, name, profileKey } = f.seedStored(type, { host });
        assert.deepEqual(await f.attach(stored), [{ sourceId: stored.id, ref: name }], host);
        const profile = f.profiles.get(profileKey);
        assert.ok(profile, host);
        assert.deepEqual(
          profile.endpoints.map((endpoint) => endpoint.host),
          [host],
          host,
        );
      }
      f.profiles.clear();
      f.mutations.length = 0;
    }
  });

  test("OAuth2 token_url hosts must be multi-label DNS names, not IP addresses or localhost names", async (t) => {
    const f = await fixture(t, { toolSources: true });
    // The OpenShell gateway, not the Sandbox, posts the issuer material to token_url, so the
    // protected host's rule applies to its parsed hostname, plus localhost (finding 1348).
    const refused: readonly RuleRow[] = [
      ["https://10.0.0.5/token", "validate"],
      ["https://127.0.0.1:8443/token", "validate"],
      ["https://169.254.169.254/latest", "validate"],
      ["https://169.254.169.254/token", "attach"],
      ["https://0x7f000001/token", "validate"],
      ["https://2130706433/token", "validate"],
      ["https://127.1/token", "validate"],
      ["https://0177.0.0.1/token", "validate"],
      ["https://[::1]:8443/token", "validate"],
      ["https://[::ffff:127.0.0.1]/token", "validate"],
      ["https://localhost/token", "validate"],
      ["https://LOCALHOST:8443/token", "validate"],
      ["https://issuer.localhost/token", "validate"],
      // The gateway resolves names through its Pod's /etc/hosts, where the kubelet and
      // container runtimes map these to loopback, link-local or multicast addresses, and the
      // Pod's own single-label hostname to the Pod itself (finding 1354).
      ["https://ip6-localhost/token", "validate", "attach"],
      ["https://ip6-loopback:8443/token", "validate"],
      ["https://IP6-LOOPBACK/token", "validate"],
      ["https://ip6-localnet/token", "validate"],
      ["https://ip6-allnodes/token", "validate"],
      ["https://localhost4/token", "validate"],
      ["https://localhost6/token", "validate"],
      ["https://localhost.localdomain/token", "validate", "attach"],
      ["https://LOCALHOST.LOCALDOMAIN:8443/token", "validate"],
      ["https://localhost4.localdomain4/token", "validate"],
      ["https://localhost6.localdomain6/token", "validate"],
      ["https://keycloak/token", "validate"],
      ["https://openshell-gateway-0:8443/token", "validate"],
      // An SRV-style `_port._protocol` name is not a host name (finding 1366).
      ["https://_grpc._tcp.openshell-gateway/token", "validate"],
      // A stored token_url that does not parse (save never accepts one) is refused the same way,
      // not with a parser error.
      ["https://login example.test/token", "attach"],
    ];
    const port = "https://login.example.test:0/token";
    // In-cluster issuers have DNS names, which the protected host accepts too.
    const accepted = [
      "https://login.example.test/oauth2/token",
      "https://localhost.example/token",
      "https://localdomain.example/token",
      "https://keycloak.idp/token",
      "https://kubernetes.default.svc/token",
      "https://keycloak.idp.svc.cluster.local:8443/realms/occ/protocol/openid-connect/token",
    ];
    for (const type of oauth2Types) {
      for (const token_url of checkedAt(refused, "validate")) {
        assert.throws(
          () => f.validate(type, { token_url }),
          { name: "CredentialSourceConfigError", message: TOKEN_URL_MESSAGE.host(type) },
          token_url,
        );
      }
      assert.throws(
        () => f.validate(type, { token_url: port }),
        { name: "CredentialSourceConfigError", message: TOKEN_URL_MESSAGE.port(type) },
        port,
      );
      for (const token_url of accepted) {
        assert.doesNotThrow(() => f.validate(type, { token_url }), token_url);
      }
    }
    await f.assertNothingSaved();
    // A stored source is not attached to a new revision, and its profile is not rewritten.
    for (const token_url of [...checkedAt(refused, "attach"), port]) {
      const { stored } = f.seedStored("oauth2-client-credentials", { token_url });
      await assert.rejects(f.attach(stored), storedConfigRefusal("token_url", token_url));
    }
    assert.equal(f.profiles.size, 0);
  });

  test("the OpenShell Backend names its gateway's namespace only from Service-shaped hosts", () => {
    const placement = (configuration: OpenShellBackendConfiguration, namespace?: string) =>
      createOpenShellBackend({
        id: "openshell",
        type: "openshell",
        configuration,
        drivers: { sandbox: "s", credential_gateway: "c" },
      }).client.placement(namespace);
    const named = { service: "openshell-gateway", namespace: "openshell-system" };
    for (const configuration of [
      { endpoint: "https://openshell-gateway.openshell-system.svc:8080" },
      { endpoint: "http://openshell-gateway.openshell-system.svc.cluster.local:8080" },
      { endpoint: "openshell-gateway.openshell-system.svc.example.internal:8080" },
      { endpoint: "https://openshell-gateway-0.openshell-gateway-peer.openshell-system.svc:8080" },
      // CoreDNS answers a port and protocol before the Service name like the Service (finding 1369).
      { endpoint: "https://grpc.tcp.openshell-gateway.openshell-system.svc:8080" },
      { endpoint: "http://_grpc._tcp.openshell-gateway.openshell-system.svc.cluster.local:8080" },
      { serviceName: "openshell-gateway.openshell-system" },
      { serviceName: "openshell-gateway.openshell-system.svc.cluster.local" },
      { serviceName: "openshell-gateway-0.openshell-gateway-peer.openshell-system.svc" },
      // DNS names are case-insensitive, and token_url hosts are compared after URL parsing.
      { serviceName: "OpenShell-Gateway.OpenShell-System" },
      { serviceName: "OpenShell-Gateway.OpenShell-System.SVC.Cluster.Local" },
      { serviceName: "GRPC.TCP.OpenShell-Gateway.OpenShell-System.SVC" },
    ]) {
      assert.deepEqual(
        placement(configuration, "oce-0123456789abcde"),
        named,
        JSON.stringify(configuration),
      );
    }
    // A Service name, with or without a port and protocol, is kept as written.
    for (const endpoint of [
      "https://openshell-gateway-peer.openshell-system.svc:8080",
      "https://_grpc._tcp.openshell-gateway-peer.openshell-system.svc:8080",
    ]) {
      assert.deepEqual(
        placement({ endpoint }),
        { service: "openshell-gateway-peer", namespace: "openshell-system" },
        endpoint,
      );
    }
    // Only a trailing `-peer` names the peer Service of the gateway Service.
    assert.deepEqual(
      placement({ endpoint: "https://gateway-0.gateway-peering.openshell-system.svc:8080" }),
      { service: "gateway-peering", namespace: "openshell-system" },
    );
    // A bare Service name resolves in each tenant namespace, so only a tenant names it.
    assert.equal(placement({ serviceName: "openshell-gateway" }), undefined);
    assert.deepEqual(placement({ serviceName: "openshell-gateway" }, "oce-0123456789abcde"), {
      service: "openshell-gateway",
      namespace: "oce-0123456789abcde",
    });
    for (const endpoint of [
      "http://127.0.0.1:1",
      "http://[::1]:8080",
      "http://k3d-occ-dev-server-0:30080",
      "https://openshell.example.com",
      "openshell-gateway.openshell-system:8080",
      // CoreDNS answers at most two labels before the Service name.
      "https://a.grpc.tcp.openshell-gateway.openshell-system.svc:8080",
    ]) {
      assert.equal(placement({ endpoint }, "oce-0123456789abcde"), undefined, endpoint);
    }
  });

  test("OAuth2 token_url hosts must not name the OpenShell gateway's own namespace or a Pod", async (t) => {
    // The gateway Pod's /etc/hosts and its cluster DNS search list resolve these to the gateway's
    // own Pod or Service, which no egress NetworkPolicy polices (finding 1356).
    const gatewayOwn = [
      "https://openshell-gateway-0.openshell-gateway-peer.openshell-system.svc.cluster.local:8080/token",
      "https://openshell-gateway-0.openshell-gateway-peer.openshell-system.svc/token",
      "https://openshell-gateway-0.openshell-gateway-peer.openshell-system/token",
      "https://openshell-gateway-0.openshell-gateway-peer/token",
      "https://openshell-gateway-peer.openshell-system.svc.cluster.local/token",
      "https://openshell-gateway.openshell-system.svc/token",
      "https://openshell-gateway.openshell-system/token",
      "https://openshell-gateway-0.openshell-gateway/token",
      // CoreDNS reads two leading labels as a port and protocol, case-insensitively, and the
      // search list completes them; whatever the port name, they are refused (finding 1366).
      "https://grpc.tcp.openshell-gateway/token",
      "https://GRPC.TCP.openshell-gateway/token",
      "https://grpc.tcp.openshell-gateway-peer/token",
      "https://any.any.openshell-gateway/token",
      "https://keycloak.openshell-system.svc.example.internal/token",
      "https://10-42-0-5.openshell-system.pod.cluster.local/token",
      // The namespace's `pod` zone itself, with no Pod label in front.
      "https://openshell-system.pod.cluster.local/token",
    ];
    // CoreDNS's default `pods insecure` answers a Pod name with its written address, in any
    // namespace, so these name an address (here loopback) and are refused without a gateway.
    const podNames = [
      "https://127-0-0-1.default.pod.cluster.local/token",
      "https://10-42-0-5.idp.pod/token",
      // CoreDNS also answers one or two leading labels (an endpoint, or a port and protocol)
      // before a Pod name and ignores them; the search list completes the short forms, and
      // any cluster domain may follow (finding 1359).
      "https://x.127-0-0-1.default.pod.cluster.local/token",
      "https://a.b.127-0-0-1.default.pod.cluster.local/token",
      "https://x.127-0-0-1.default.pod/token",
      "https://a.b.127-0-0-1.default.pod/token",
      "https://x.0--1.default.pod.cluster.local/token",
      "https://x.169-254-169-254.idp.pod.k8s.example.internal/token",
      // Any `pod` label after the second is refused, so a public name of that shape is too
      // (deliberately fail-closed), and so is any prefix depth.
      "https://login.idp.pod.example.com/token",
      "https://a.b.c.127-0-0-1.default.pod.cluster.local/token",
    ];
    // Issuers in other namespaces, including the test and development Keycloaks, keep working.
    const accepted = [
      "https://keycloak.idp.svc.cluster.local:8443/realms/occ/protocol/openid-connect/token",
      "https://keycloak.oce-keycloak-0a1b2c3d.svc.cluster.local:8443/realms/occ/token",
      "https://keycloak.occ-development-keycloak.svc.cluster.local/token",
      "https://keycloak.idp/token",
      // Three labels ending in another Service name the gateway's namespace only through a
      // Service the OpenShell chart does not create there, and never the gateway itself.
      "https://a.b.keycloak/token",
      // A Service that only shares the gateway Service's name as a prefix, without the `-` its
      // peer Service adds.
      "https://grpc.tcp.openshell-gateway2/token",
      // CoreDNS answers at most two labels before a Service name, so four labels ending in the
      // gateway Service resolve only through the `svc.<zone>` search entry, as Service `c` in a
      // namespace named after the last label, never the gateway's.
      "https://a.b.c.openshell-gateway/token",
      "https://a.b.c.openshell-gateway-peer/token",
      "https://kubernetes.default.svc/token",
      "https://openshell-system.example/token",
      "https://login.openshell-gateway.example/token",
      "https://login.example.test/oauth2/token",
      "https://example.com/token",
      "https://pod.example.com/token",
      "https://login.pod.example.com/token",
      "https://keycloak.pod.svc.cluster.local/token",
    ];
    const message = TOKEN_URL_MESSAGE.gateway;
    for (const gateway of [
      { endpoint: "https://openshell-gateway.openshell-system.svc:8080" },
      { serviceName: "openshell-gateway.openshell-system" },
      { endpoint: "https://grpc.tcp.openshell-gateway.openshell-system.svc:8080" },
    ]) {
      const f = await fixture(t, { toolSources: true, gateway });
      for (const type of oauth2Types) {
        for (const token_url of [...gatewayOwn, ...podNames]) {
          assert.throws(
            () => f.validate(type, { token_url }),
            { name: "CredentialSourceConfigError", message: message(type) },
            token_url,
          );
        }
        for (const token_url of accepted) {
          assert.doesNotThrow(() => f.validate(type, { token_url }), token_url);
        }
      }
      await f.assertNothingSaved();
    }

    // Without a named gateway namespace only Pod names are refused at save.
    const unnamed = await fixture(t, { toolSources: true });
    for (const token_url of podNames) {
      assert.throws(
        () => unnamed.validate("oauth2-client-credentials", { token_url }),
        { name: "CredentialSourceConfigError", message: message("oauth2-client-credentials") },
        token_url,
      );
    }

    // A gateway in each tenant namespace is known at registration and attach, which carry it.
    const f = await fixture(t, {
      toolSources: true,
      gateway: { serviceName: "openshell-gateway" },
    });
    const tenant = f.namespace.name;
    const tenantOwn = [
      `https://openshell-gateway-0.openshell-gateway-peer.${tenant}.svc.cluster.local/token`,
      `https://openshell-gateway.${tenant}.svc/token`,
      "https://openshell-gateway-0.openshell-gateway-peer/token",
      "https://grpc.tcp.openshell-gateway/token",
      "https://GRPC.TCP.openshell-gateway-peer/token",
    ] as const;
    for (const token_url of tenantOwn) {
      assert.doesNotThrow(() => f.validate("oauth2-client-credentials", { token_url }));
    }
    // A source stored before the rule, with its provider, cannot be attached to a new revision.
    for (const token_url of [...tenantOwn, ...podNames]) {
      await assert.rejects(
        f.attach(f.seedStored("oauth2-client-credentials", { token_url }).stored),
        storedConfigRefusal("token_url", token_url),
      );
    }
    assert.equal(f.profiles.size, 0);
  });
}
