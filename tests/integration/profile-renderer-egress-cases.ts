import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { baseInput, managedCodexInput, externalSignInInput } from "./profile-renderer-inputs.ts";
import {
  helmSkip,
  helmTemplate,
  loadYaml,
  render,
  assertPreflightFailure,
  propertyAt,
  objectAt,
  computeConfiguration,
} from "./profile-renderer-fixture.ts";

export function registerEgressCases(): void {
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

  test("managed channel egress preserves listener ownership and rejects unsupported settings", async (t) => {
    const output = await render("codex", managedCodexInput());
    t.after(() => rmSync(output.directory, { recursive: true, force: true }));
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    const compute = computeConfiguration(output.installation);
    const runtime = objectAt(compute, "runtime");
    const egress = objectAt(runtime, "channelEgress");
    assert.equal(egress.listenerPortStart, 10001);
    assert.equal(egress.listenerPortEnd, 10062);
    assert.equal(egress.occListenerPort, 10000);
    assert.match(output.values, /channelEgress:/);
    for (const change of [
      { listenerPortEnd: 10063 },
      { occListenerPort: 10001 },
      { inspectionPort: 10000 },
      { excludedCidrs: [] },
      { excludedCidrs: ["192.0.2.1/24"] },
    ]) {
      runtime.channelEgress = { ...egress, ...change };
      assert.throws(
        () => requireConfiguration(KubernetesComputeDriver, compute),
        SharedConfigurationValidationError,
      );
    }
    await assertPreflightFailure(
      "openclaw",
      baseInput({ channels: { runtimeProxyUrl: "http://192.0.2.1:3128" } }),
      /runtimeProxyUrl/,
    );
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

  test(
    "clusterPort reaches the Kubernetes API egress rule in the rendered chart",
    { skip: helmSkip },
    async () => {
      // OVN-Kubernetes matches egress after Service translation, so OpenShift needs 6443.
      const input = baseInput();
      input.controlPlane.clusterPort = 6443;
      const output = await render("openclaw", input);
      assert.equal(propertyAt(loadYaml(output.values), "cluster", "port"), 6443);
      assert.match(
        helmTemplate(output),
        /cidr: 192\.0\.2\.11\/32\s+ports:\s+- protocol: TCP\s+port: 6443/,
      );

      // The port is optional: omitting it keeps the chart default of 443.
      const defaults = await render("openclaw", baseInput());
      assert.equal(propertyAt(loadYaml(defaults.values), "cluster", "port"), undefined);

      for (const bad of [0, 65536, "6443"]) {
        input.controlPlane.clusterPort = bad;
        await assertPreflightFailure(
          "openclaw",
          input,
          /controlPlane\.clusterPort must be an integer from 1 through 65535/,
        );
      }
    },
  );
}
