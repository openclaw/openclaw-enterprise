import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  baseInput,
  codexInput,
  managedCodexInput,
  externalSignInInput,
} from "./profile-renderer-inputs.ts";
import {
  loadYaml,
  syntheticCredentialUrl,
  render,
  assertPreflightFailure,
  propertyAt,
  objectAt,
  textAt,
  computeConfiguration,
} from "./profile-renderer-fixture.ts";

export function registerEgressCases(): void {
  test("profile proxy selection shares one endpoint and limits bundled policy inputs", async (t) => {
    for (const allowedHosts of [["api.example.com", "*.slack.com"], ["*"], []]) {
      const configured = await render(
        "openclaw",
        baseInput({ proxy: { bundled: true, allowedHosts } }),
      );
      t.after(() => rmSync(configured.directory, { recursive: true, force: true }));
      assert.deepEqual(
        propertyAt(loadYaml(configured.values), "gatewayProxy", "allowedHosts"),
        allowedHosts,
      );
    }
    await assertPreflightFailure(
      "openclaw",
      baseInput({ proxy: { bundled: true, url: "http://192.0.2.10:3128" } }),
      /mutually exclusive/,
    );
    await assertPreflightFailure(
      "openclaw",
      baseInput({ proxy: { allowedHosts: ["api.example.com"] } }),
      /requires proxy.bundled/,
    );
  });

  test("directory proxy overrides leave Gateway selection unchanged in both profiles", async (t) => {
    for (const profile of ["openclaw", "codex"]) {
      for (const proxy of [{}, { url: "http://192.0.2.10:3128" }, { bundled: true }]) {
        const input = profile === "codex" ? codexInput({ proxy }) : baseInput({ proxy });
        const baseline = await render(profile, input);
        t.after(() => rmSync(baseline.directory, { recursive: true, force: true }));
        const directoryUrl = "https://192.0.2.20:8443";
        const overridden = await render(profile, {
          ...input,
          channels: { directoryProxyUrl: directoryUrl },
        });
        t.after(() => rmSync(overridden.directory, { recursive: true, force: true }));
        assert.equal(
          propertyAt(loadYaml(overridden.values), "api", "channelDirectoryProxyUrl"),
          directoryUrl,
        );
        assert.deepEqual(
          propertyAt(loadYaml(overridden.values), "gatewayProxy"),
          propertyAt(loadYaml(baseline.values), "gatewayProxy"),
        );
        // Directory-only configuration must not create or change Gateway permissions.
        assert.deepEqual(
          computeConfiguration(overridden.installation),
          computeConfiguration(baseline.installation),
        );
        assert.equal(
          propertyAt(loadYaml(baseline.values), "api", "channelDirectoryProxyUrl"),
          undefined,
        );
      }
    }
  });

  test("retired channel proxy profile keys identify their replacement", async () => {
    for (const [key, value, replacement] of [
      ["runtimeProxyUrl", "http://192.0.2.10:3128", "proxy.url"],
      ["managedSlackProxy", true, "proxy.bundled"],
    ] as const) {
      await assertPreflightFailure(
        "openclaw",
        baseInput({ channels: { [key]: value } }),
        new RegExp(`channels\\.${key} was removed; use ${replacement.replace(".", "\\.")}`),
      );
    }
  });

  test("preflight rejects CIDR prefixes with a leading zero", async () => {
    const controlPlane = baseInput().controlPlane;
    await assertPreflightFailure(
      "openclaw",
      baseInput({
        controlPlane: { ...controlPlane, databaseCidrs: ["192.0.2.10/032"] },
      }),
      /controlPlane\.databaseCidrs\[0\] must be an IPv4 \/32 CIDR/,
    );
    await assertPreflightFailure(
      "openclaw",
      baseInput({
        controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["192.0.2.12/08"] },
      }),
      /controlPlane\.gatewayTrustedProxyCidrs\[0\] must be an IPv4 CIDR/,
    );
    await assertPreflightFailure(
      "openclaw",
      baseInput({
        controlPlane: {
          ...controlPlane,
          trustedProxy: { preset: "ingress-nginx", cidrs: ["2001:db8::/032"] },
        },
      }),
      /controlPlane\.trustedProxy\.cidrs\[0\] must be an IPv4 or IPv6 CIDR/,
    );
    const accepted = await render(
      "openclaw",
      baseInput({
        controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["192.0.2.12/8"] },
      }),
    );
    assert.match(accepted.installation, /192\.0\.2\.12\/8/);
  });

  // Compute refuses a source range that covers every address (scopedCidr) in the same words;
  // a status proxy source wider than one address only warns there and here (bughunt F2).
  test("preflight refuses source CIDRs that cover every address and warns about wide status sources", async () => {
    const controlPlane = baseInput().controlPlane;
    for (const key of ["gatewayTrustedProxyCidrs", "pluginStatusProxySourceCidrs"]) {
      await assertPreflightFailure(
        "openclaw",
        baseInput({ controlPlane: { ...controlPlane, [key]: ["192.0.2.12/32", "0.0.0.0/0"] } }),
        new RegExp(`controlPlane\\.${key}\\[1\\] cannot cover every address\\.`),
      );
    }
    const wide = await render(
      "openclaw",
      baseInput({
        controlPlane: { ...controlPlane, pluginStatusProxySourceCidrs: ["10.42.0.0/16"] },
      }),
    );
    assert.match(
      wide.preflight.warnings.join("\n"),
      /controlPlane\.pluginStatusProxySourceCidrs\[0\] covers more than one address/,
    );
    const exact = await render("openclaw", baseInput());
    assert.doesNotMatch(exact.preflight.warnings.join("\n"), /covers more than one address/);
    const widerTrust = await render(
      "openclaw",
      baseInput({ controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["10.42.0.0/16"] } }),
    );
    assert.doesNotMatch(widerTrust.preflight.warnings.join("\n"), /covers more than one address/);
  });

  test("preflight rejects channel proxy URLs with an invalid octet or port", async () => {
    const message = /must be an HTTP\(S\) literal IPv4 endpoint with an explicit port/;
    await assertPreflightFailure(
      "openclaw",
      baseInput({ proxy: { url: "http://192.0.2.999:8080" } }),
      message,
    );
    await assertPreflightFailure(
      "openclaw",
      baseInput({ proxy: { url: "http://192.0.2.10:99999" } }),
      message,
    );
    // Compute and the API's Slack directory refuse an unspecified proxy host, which names no proxy.
    await assertPreflightFailure(
      "openclaw",
      baseInput({ proxy: { url: "http://0.0.0.0:3128" } }),
      /proxy\.url must not use host 0\.0\.0\.0, which names no proxy address\./,
    );
    const accepted = await render(
      "openclaw",
      baseInput({
        proxy: { url: "http://192.0.2.10:8080" },
      }),
    );
    assert.match(accepted.values, /url: http:\/\/192\.0\.2\.10:8080/);
    assert.match(accepted.installation, /proxyUrl: http:\/\/192\.0\.2\.10:8080/);
    requireConfiguration(KubernetesComputeDriver, computeConfiguration(accepted.installation));
  });

  for (const profile of ["openclaw", "codex"]) {
    for (const proxyUrl of ["http://192.0.2.10:80", "https://192.0.2.10:443"]) {
      test(`${profile} preserves explicit default channel proxy port in ${proxyUrl}`, async (t) => {
        const input = profile === "codex" ? codexInput() : baseInput();
        input.proxy = { url: proxyUrl };
        const output = await render(profile, input);
        t.after(() => rmSync(output.directory, { recursive: true, force: true }));
        assert.equal(output.preflight.ok, true);
        assert.equal(propertyAt(loadYaml(output.values), "gatewayProxy", "url"), proxyUrl);
        const compute = computeConfiguration(output.installation);
        assert.equal(propertyAt(compute, "runtime", "proxy", "proxyUrl"), proxyUrl);
        // Installation validation runs even before an Agent enables a channel.
        assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, compute));
      });
    }
  }

  test("channel proxy validation preserves explicit ports and exact managed peers", async (t) => {
    const output = await render("openclaw", baseInput());
    t.after(() => rmSync(output.directory, { recursive: true, force: true }));
    const compute = computeConfiguration(output.installation);
    const runtime = objectAt(compute, "runtime");
    const managed = structuredClone(objectAt(runtime, "proxy"));
    const managedProxy = objectAt(managed, "managedProxy");
    const hostname = textAt(managedProxy, "hostname");
    assert.equal(managedProxy.port, 3128);
    requireConfiguration(KubernetesComputeDriver, compute);

    // IPv6 is supported by Compute directly; profile input intentionally remains IPv4-only.
    for (const proxyUrl of [
      " http://192.0.2.10:8080 ",
      "http://[2001:db8::10]:80",
      "https://[2001:db8::10]:443/",
      "http://192.0.2.10:443",
      "https://192.0.2.10:80/",
    ]) {
      runtime.proxy = { proxyUrl };
      assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, compute), proxyUrl);
    }
    for (const [scheme, port] of [
      ["http", 80],
      ["https", 443],
    ]) {
      runtime.proxy = {
        ...managed,
        proxyUrl: `${scheme}://${hostname}:${port}/`,
        managedProxy: { ...managedProxy, port },
      };
      assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, compute));
    }

    for (const proxyUrl of [
      "http://192.0.2.10",
      "https://[2001:db8::10]",
      "http://192.0.2.10:0",
      "http://192.0.2.10:65536",
      syntheticCredentialUrl({
        protocol: "http",
        username: "proxy-user",
        password: "synthetic-password",
        host: "192.0.2.10",
        port: 80,
      }),
      "http://192.0.2.10:80/path",
      "http://192.0.2.10:80?query=1",
      "https://192.0.2.10:443#fragment",
      "ftp://192.0.2.10:80",
      "http://proxy.example.invalid:80",
    ]) {
      runtime.proxy = { proxyUrl };
      assert.throws(
        () => requireConfiguration(KubernetesComputeDriver, compute),
        SharedConfigurationValidationError,
      );
    }
    // A valid peer grant never authorizes a different Service, port, or URL credentials.
    for (const proxyUrl of [
      "http://other.openclaw-system.svc:80",
      `http://${hostname}:443`,
      `http://${hostname}`,
      syntheticCredentialUrl({
        protocol: "http",
        username: "proxy-user",
        password: "synthetic-password",
        host: hostname,
        port: 80,
      }),
    ]) {
      runtime.proxy = {
        ...managed,
        proxyUrl,
        managedProxy: { ...managedProxy, port: 80 },
      };
      assert.throws(
        () => requireConfiguration(KubernetesComputeDriver, compute),
        SharedConfigurationValidationError,
      );
    }
  });

  test("channel proxy validation preserves omitted-port endpoint diagnostics", async (t) => {
    const output = await render("openclaw", baseInput());
    t.after(() => rmSync(output.directory, { recursive: true, force: true }));
    const compute = computeConfiguration(output.installation);
    const runtime = objectAt(compute, "runtime");
    const managed = structuredClone(objectAt(runtime, "proxy"));
    const hostname = textAt(managed, "managedProxy", "hostname");

    for (const proxyUrl of [
      "http://192.0.2.10",
      "https://[2001:db8::10]",
      "http://proxy.example.invalid:8080",
      "http://192.0.2.10:8080/path",
    ]) {
      runtime.proxy = { proxyUrl };
      assert.throws(
        () => requireConfiguration(KubernetesComputeDriver, compute),
        SharedConfigurationValidationError,
      );
    }
    for (const proxyUrl of [
      `http://${hostname}`,
      `http://${hostname}:8080`,
      "http://other.openclaw-system.svc:3128",
    ]) {
      runtime.proxy = { ...managed, proxyUrl };
      assert.throws(
        () => requireConfiguration(KubernetesComputeDriver, compute),
        SharedConfigurationValidationError,
      );
    }
  });

  test("profiles refuse database CA keys the chart refuses", async () => {
    const withCa = (key?: string) =>
      baseInput({
        controlPlane: {
          ...baseInput().controlPlane,
          databaseCa: { secretName: "occ-db-ca", ...(key === undefined ? {} : { key }) },
        },
      });
    const accepted = await render("openclaw", withCa("db_ca.pem"));
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    assert.match(accepted.values, /caKey: db_ca.pem/);
    const omitted = await render("openclaw", withCa(undefined));
    assert.equal(omitted.summary.ok, true, omitted.preflight.errors.join("\n"));
    assert.match(omitted.values, /caKey: ca.pem/);
    const maxKey = "a".repeat(253);
    const acceptedMax = await render("openclaw", withCa(maxKey));
    assert.equal(acceptedMax.summary.ok, true, acceptedMax.preflight.errors.join("\n"));
    assert.match(acceptedMax.values, new RegExp(`caKey: ${maxKey}`));
    for (const key of [".", "..", "..ca.pem", "ca/pem", "ca pem", "a".repeat(254)]) {
      await assertPreflightFailure(
        "openclaw",
        withCa(key),
        /controlPlane\.databaseCa\.key must be a Kubernetes Secret key of at most 253 characters/,
      );
    }
  });

  test("profiles refuse ChatGPT credential lifetimes the API refuses", async () => {
    const accounts = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      adminSecretName: "occ-chatgpt-admin",
      adminSecretKey: "admin-key",
      providerCidr: "192.0.2.21/32",
    };
    const accepted = await render(
      "codex",
      managedCodexInput({
        codex: { managedServiceAccounts: { ...accounts, credentialTtlSeconds: 2_592_000 } },
      }),
    );
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    assert.match(accepted.installation, /credentialTtlSeconds: 2592000/);
    await assertPreflightFailure(
      "codex",
      managedCodexInput({
        codex: { managedServiceAccounts: { ...accounts, credentialTtlSeconds: 2_592_001 } },
      }),
      /codex.managedServiceAccounts.credentialTtlSeconds must be an integer from 1 through 2592000/,
    );
  });

  test("profiles refuse administrator emails the bootstrap Job refuses", async () => {
    const accepted = await render(
      "openclaw",
      baseInput({
        controlPlane: { ...baseInput().controlPlane, adminEmail: " Admin@Example.invalid " },
      }),
    );
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    assert.match(accepted.values, /adminEmail: " Admin@Example.invalid "/);
    for (const adminEmail of ["not-an-email", "admin@example", "a @b.c"]) {
      await assertPreflightFailure(
        "openclaw",
        baseInput({ controlPlane: { ...baseInput().controlPlane, adminEmail } }),
        /controlPlane.adminEmail must be a valid administrator email/,
      );
    }
  });

  test("preflight rejects a Google hosted domain the chart and API refuse", async () => {
    const label63 = `a${"b".repeat(61)}c`;
    const domain254 = [label63, label63, label63, `d${"e".repeat(60)}f`].join(".");
    const domain253 = [label63, label63, label63, `d${"e".repeat(59)}f`].join(".");
    assert.equal(domain254.length, 254);
    assert.equal(domain253.length, 253);
    const googleInput = (allowedDomains: string[]) =>
      externalSignInInput({
        google: { allowedDomains },
      });
    for (const allowedDomains of [["example.123"], ["example.1"], [domain254]]) {
      await assertPreflightFailure(
        "openclaw",
        googleInput(allowedDomains),
        /controlPlane\.google\.allowedDomains\[0\] must be a lowercase DNS domain name of at most 253 characters whose last label starts with a letter, such as example\.com/,
      );
    }
    const accepted = await render("openclaw", googleInput([domain253]));
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    assert.match(accepted.values, new RegExp(domain253));
  });
}
