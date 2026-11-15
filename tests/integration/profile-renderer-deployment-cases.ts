import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadStartupConfigurationSnapshot } from "../../apps/controller/src/composition/installation-config.ts";
import { baseInput, codexInput, externalSignInInput } from "./profile-renderer-inputs.ts";
import {
  helmSkip,
  loadYaml,
  helmTemplate,
  syntheticCredentialUrl,
  render,
  renderCli,
  renderError,
  profileFailure,
  readPreflight,
  assertPreflightFailure,
  escapeRegExp,
  assertFieldRefusals,
  propertyAt,
} from "./profile-renderer-fixture.ts";

import { generatedGatewaySecrets } from "./profile-renderer-helm-cases.ts";

export function registerDeploymentCases(): void {
  test("preflight rejects inputs that Helm would reject", async () => {
    await assertFieldRefusals(
      "openclaw",
      baseInput(),
      "controlPlane.gatewayApiKeySecretName",
      ["occ-installation-startup", "occ-database", "occ-auth"],
      "must name a dedicated Secret",
    );
    await assertFieldRefusals(
      "openclaw",
      baseInput(),
      "controlPlane.gatewayApiKeySecretName",
      generatedGatewaySecrets("oce").map(({ name }) => name),
      "must name a dedicated Secret; the chart generates",
    );
    await assertFieldRefusals(
      "codex",
      codexInput(),
      "controlPlane.metrics",
      [{ scraperNamespaceLabels: { name: "monitoring" } }],
      "requires both scraperNamespaceLabels and scraperPodLabels, or neither",
    );
    await assertFieldRefusals(
      "codex",
      codexInput(),
      "controlPlane.agentNativeAdminDomain",
      ["https://agents.oce.example.internal"],
      "must be a DNS hostname without a wildcard, port, scheme, or path",
    );
    await assertFieldRefusals(
      "codex",
      codexInput(),
      "controlPlane.agentNativeAdminDomain",
      ["agents.unrelated.com"],
      "must share a non-public DNS suffix",
    );
    await assertFieldRefusals(
      "codex",
      codexInput(),
      "controlPlane.authBaseUrl",
      ["https://console.unrelated.com"],
      "and controlPlane.agentNativeAdminDomain must share a non-public DNS suffix",
    );

    // The API refuses a public-suffix cookie domain at startup (tldts, private registries
    // included); preflight uses the same list. Helm has none, so the chart renders these.
    const nativeAdminUnder = (sharedCookieDomain: string) =>
      codexInput({
        controlPlane: {
          ...baseInput().controlPlane,
          authBaseUrl: `https://console.${sharedCookieDomain}`,
          agentNativeAdminDomain: `agents.${sharedCookieDomain}`,
        },
      });
    for (const sharedCookieDomain of ["co.uk", "github.io", "CO.UK"]) {
      await assertPreflightFailure(
        "codex",
        nativeAdminUnder(sharedCookieDomain),
        /must share a non-public DNS suffix/,
      );
    }
    for (const sharedCookieDomain of ["example.co.uk", "oce.github.io"]) {
      assert.equal((await render("codex", nativeAdminUnder(sharedCookieDomain))).summary.ok, true);
    }

    await assertFieldRefusals(
      "codex",
      codexInput(),
      "controlPlane.authBaseUrl",
      ["http://console.oce.example.internal"],
      "must use HTTPS for shared browser sessions",
    );

    // The API and the bootstrap Job accept only an absolute HTTP(S) origin.
    const invalidOrigins = [
      "https://console.oce.example.internal/occ",
      "https://console.oce.example.internal?next=1",
      "https://console.oce.example.internal#console",
      // An empty query or fragment, which the API's URL serialization keeps (https://host/?).
      "https://console.oce.example.internal?",
      "https://console.oce.example.internal/?",
      "https://console.oce.example.internal#",
      "https://console.oce.example.internal/#",
      " https://console.oce.example.internal? ",
      "https://admin@console.oce.example.internal",
      "ftp://console.oce.example.internal",
      "console.oce.example.internal",
      // Stricter than the API, like the chart: URL parsing repairs these into an origin.
      "https:console.oce.example.internal",
      "https://console.oce.example.internal/.",
      "https://console.oce.example.internal/%2e",
      // Like the chart: Unicode spaces and invisible characters at either end, which URL
      // parsing keeps (it strips only C0 controls and spaces). URL parsing already refuses most
      // of these, and a trailing unassigned code point (U+0378); a trailing U+FEFF or U+200B,
      // which the host parser drops, is refused by the edge rule alone.
      ...["\u00a0", "\u2003", "\u3000", "\ufeff", "\u200b"].flatMap((space) => [
        `${space}https://console.oce.example.internal`,
        `https://console.oce.example.internal${space}`,
        ` ${space}https://console.oce.example.internal${space} `,
      ]),
      "https://console.oce.example.internal\u0378",
      // A leading zero is octal: 192.168.010.001 publishes 192.168.8.1.
      "https://192.168.010.001",
      "https://127.1",
      "http://0177.0.0.1",
      // Like the chart: spaces, < and > and invisible characters inside the host. The host parser
      // refuses spaces, < and >, and drops tabs and most invisible characters.
      ...[
        " ",
        "<",
        ">",
        "\u00a0",
        "\u2003",
        "\u3000",
        "\u2028",
        "\t",
        "\ufeff",
        "\u200b",
        "\u00ad",
      ].map((space) => `https://console${space}.oce.example.internal`),
    ];
    await assertFieldRefusals(
      "codex",
      codexInput(),
      "controlPlane.authBaseUrl",
      invalidOrigins,
      "must be an absolute HTTP(S) origin URL without a path, query, fragment, or user info",
    );
    // The API accepts these, and so does the renderer: ASCII spaces and tabs at the ends, which
    // URL parsing strips, and hosts with non-ASCII letters, including the joiners U+200C and
    // U+200D that some IDN labels need.
    for (const authBaseUrl of [
      " \thttps://console.oce.example.internal\t ",
      "https://bücher.oce.example.internal",
      "https://\u0646\u0627\u0645\u0647\u200c\u0627\u06cc.oce.example.internal",
      "https://\u0915\u094d\u200d\u0937.oce.example.internal",
    ]) {
      const output = await render(
        "codex",
        codexInput({ controlPlane: { ...baseInput().controlPlane, authBaseUrl } }),
      );
      assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    }
    // An unparsable value is reported once, not again by the native admin checks.
    const error = await renderError(() =>
      render(
        "codex",
        codexInput({
          controlPlane: {
            ...baseInput().controlPlane,
            authBaseUrl: "console.oce.example.internal",
          },
        }),
      ),
    );
    const preflight = readPreflight(profileFailure(error).directory);
    assert.deepEqual(
      preflight.errors.filter((message) => message.includes("authBaseUrl")),
      [
        "controlPlane.authBaseUrl must be an absolute HTTP(S) origin URL without a path, query, fragment, or user info.",
      ],
    );
  });

  test("preflight rejects auth base URLs whose host percent-encodes an ASCII byte", async () => {
    const asciiEncoded = (authBaseUrl: string) =>
      codexInput({
        controlPlane: {
          ...baseInput().controlPlane,
          authBaseUrl,
          agentNativeAdminDomain: "agents.example.com",
        },
      });
    const asciiRefusal =
      "controlPlane.authBaseUrl host must not percent-encode an ASCII byte; the chart's URL parser rejects it.";
    for (const authBaseUrl of ["https://ex%61mple.com", "https://example.com%2e"]) {
      // A real process, so the refusal's exit status is checked.
      const error = await renderError(() => renderCli("codex", asciiEncoded(authBaseUrl)));
      assert.equal(propertyAt(error, "status"), 1);
      assert.match(profileFailure(error).output, new RegExp(escapeRegExp(asciiRefusal)));
      assert.doesNotMatch(
        profileFailure(error).output,
        /must be an absolute HTTP\(S\) origin URL without a path, query, fragment, or user info/,
      );
      assert.equal(existsSync(join(profileFailure(error).directory, "values.yaml")), false);
      const preflight = readPreflight(profileFailure(error).directory);
      assert.equal(preflight.ok, false);
      assert.deepEqual(
        preflight.errors.filter((message) => message.includes("authBaseUrl")),
        [asciiRefusal],
      );
    }

    // A % that decodes to an IPv4 address stays on ipv4HostKept's existing origin refusal.
    const rewrittenIpv4 = await renderError(() =>
      render(
        "codex",
        codexInput({
          controlPlane: {
            ...baseInput().controlPlane,
            authBaseUrl: "https://192%2e168.1.1",
          },
        }),
      ),
    );
    assert.match(
      profileFailure(rewrittenIpv4).output,
      /controlPlane\.authBaseUrl must be an absolute HTTP\(S\) origin URL without a path, query, fragment, or user info\./,
    );
    assert.doesNotMatch(profileFailure(rewrittenIpv4).output, /percent-encode an ASCII byte/);

    const nonAscii = await render(
      "openclaw",
      externalSignInInput({
        trustedProxy: { preset: "ingress-nginx", cidrs: ["10.42.0.0/16"] },
        authBaseUrl: "https://ex%C3%A4.oce.example.internal",
      }),
    );
    assert.equal(nonAscii.summary.ok, true, nonAscii.preflight.errors.join("\n"));
    assert.match(nonAscii.values, /baseUrl: "https:\/\/ex%C3%A4\.oce\.example\.internal"/);
    if (!helmSkip) {
      helmTemplate(nonAscii);
    }
  });

  // Node accepts both and writes a deployable file; the chart then refuses it.
  test("preflight rejects IPv4-mapped auth base URL hosts and encoded invisible characters", async () => {
    const refusals = [
      [
        "host must not be an IPv4-mapped IPv6 address, which Helm 3.19.2's URL parser rejects; write the IPv4 address instead.",
        ["https://[::ffff:192.0.2.1]", "https://[::FFFF:c000:201]:8443", "https://[::ffff:0:0]"],
      ],
      [
        "host must not percent-encode a space or invisible character; the chart refuses it in the decoded host.",
        [
          "https://ex%C2%ADample.com",
          "https://ex%E2%80%8Bample.com:8443",
          "https://ex%ef%bb%bfample.com",
        ],
      ],
    ] satisfies [string, string[]][];
    for (const [refusal, urls] of refusals) {
      for (const authBaseUrl of urls) {
        const error = await renderError(() =>
          render("openclaw", externalSignInInput({ authBaseUrl })),
        );
        assert.equal(existsSync(join(profileFailure(error).directory, "values.yaml")), false);
        const preflight = readPreflight(profileFailure(error).directory);
        assert.deepEqual(
          preflight.errors.filter((message) => message.includes("authBaseUrl")),
          [`controlPlane.authBaseUrl ${refusal}`],
          authBaseUrl,
        );
      }
    }
    for (const authBaseUrl of ["https://[::192.0.2.1]", "https://[::ffff:1:2:3]:8443"]) {
      await assertPreflightFailure(
        "openclaw",
        externalSignInInput({ authBaseUrl }),
        /must share a non-public DNS suffix/,
      );
    }
  });

  // The chart lowercases the header before its checks and before OCC_AUTH_CLIENT_IP_HEADER.
  test("trusted proxy client address headers render lowercase", async () => {
    const trustedProxy = (preset: string, clientAddressHeader: string) =>
      baseInput({
        controlPlane: {
          ...baseInput().controlPlane,
          trustedProxy: { preset, cidrs: ["10.42.0.0/16"], clientAddressHeader },
        },
      });
    for (const [preset, header] of [
      ["generic", "X-Real-IP"],
      ["ingress-nginx", "X-Forwarded-For"],
    ] as const) {
      const output = await render("openclaw", trustedProxy(preset, header));
      assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
      assert.equal(
        propertyAt(loadYaml(output.values), "api", "trustedProxy", "clientAddressHeader"),
        header.toLowerCase(),
      );
    }
    await assertPreflightFailure(
      "openclaw",
      trustedProxy("generic", "Cookie"),
      /controlPlane\.trustedProxy\.clientAddressHeader cannot be cookie;/,
    );
  });

  // The API lowercases both domains at startup, and the chart accepts only lowercase.
  test("native admin domains render lowercase for the chart", async () => {
    const longest = `${"a.".repeat(97)}oce.example.internal`;
    assert.equal(longest.length, 214);
    const boundaryInput = (domain: string) =>
      codexInput({
        controlPlane: { ...baseInput().controlPlane, agentNativeAdminDomain: domain },
      });
    assert.equal((await render("codex", boundaryInput(longest))).summary.ok, true);
    for (const length of [215, 217, 253]) {
      await assertPreflightFailure(
        "codex",
        boundaryInput(`${"a".repeat(length - longest.length)}${longest}`),
        /controlPlane.agentNativeAdminDomain must not exceed 214 characters/,
      );
    }

    const output = await render(
      "codex",
      codexInput({
        controlPlane: {
          ...baseInput().controlPlane,
          authBaseUrl: "https://Console.Example.co.uk",
          agentNativeAdminDomain: "Agents.Example.co.uk",
        },
      }),
    );
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    assert.match(
      output.values,
      /agentNativeAdmin:\n {2}enabled: true\n {2}domain: agents\.example\.co\.uk\n/,
    );
    if (!helmSkip) {
      const manifests = helmTemplate(output);
      assert.match(
        manifests,
        /name: OCC_AGENT_NATIVE_ADMIN_DOMAIN\n\s+value: "agents\.example\.co\.uk"/,
      );
      assert.doesNotMatch(manifests, /name: OCC_AUTH_COOKIE_DOMAIN/);
    }
  });

  test("profiles pass an optional observability URL to Installation startup YAML", async () => {
    const url = "https://grafana.oce.example.internal/d/occ-observability";
    const withoutUrl = await render("openclaw", baseInput());
    assert.doesNotMatch(withoutUrl.installation, /observability:/);

    const output = await render(
      "codex",
      codexInput({ controlPlane: { ...baseInput().controlPlane, observabilityUrl: url } }),
    );
    assert.equal(output.summary.ok, true);
    // The controller's own startup parser must accept the rendered block.
    const snapshot = await loadStartupConfigurationSnapshot({
      mode: "production",
      environment: { OCC_CONFIG_PATH: join(output.directory, "installation.yaml") },
    });
    assert.equal(snapshot.observability?.url, url);

    const genericObservabilityUrl =
      /controlPlane.observabilityUrl must be an absolute HTTP or HTTPS URL/;
    const rewrittenIpv4ObservabilityUrl =
      /controlPlane\.observabilityUrl IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address\./;
    const assertObservabilityPreflight = (
      observabilityUrl: string,
      expected: RegExp,
      absent: RegExp,
    ) =>
      assertPreflightFailure(
        "openclaw",
        baseInput({ controlPlane: { ...baseInput().controlPlane, observabilityUrl } }),
        expected,
        absent,
      );
    for (const invalid of [
      "javascript:alert(1)",
      syntheticCredentialUrl({
        username: "user",
        password: "pass",
        host: "grafana.example.internal",
      }),
      "https://grafana.example.internal/#fragment",
      "grafana.example.internal",
      "ftp://grafana.example.internal/d/occ-observability",
      // Either credential alone is refused too.
      syntheticCredentialUrl({ username: "user", password: "", host: "grafana.example.internal" }),
      syntheticCredentialUrl({ username: "", password: "pass", host: "grafana.example.internal" }),
      // So is an empty user info, which Node drops: any @ before the host, with or without the
      // slashes, and before an IPv4 host too.
      "http://@grafana.example.internal/d",
      syntheticCredentialUrl({
        protocol: "https",
        username: "",
        password: "",
        host: "grafana.example.internal",
        pathname: "/d",
      }),
      "http:@grafana.example.internal/d",
      "http:\t//@grafana.example.internal/d",
      "http://@192.0.2.10:3000/d",
    ]) {
      await assertObservabilityPreflight(
        invalid,
        genericObservabilityUrl,
        rewrittenIpv4ObservabilityUrl,
      );
    }
    for (const shorthand of [
      "http://192.168.1",
      "http://2130706433",
      "http://127.1",
      "http://0177.0.0.1",
    ]) {
      await assertObservabilityPreflight(
        shorthand,
        rewrittenIpv4ObservabilityUrl,
        genericObservabilityUrl,
      );
    }
    const rewrittenHostChars =
      /controlPlane\.observabilityUrl must not contain a tab or newline, or a backslash before the query; the URL parser drops or rewrites them into a different host\./;
    for (const raw of [
      "http://good.example\tevil.com/x",
      "http://evil.com\\.good.example/path",
      "http://good.example\nevil.com/x",
      "http://good.example\revil.com/x",
    ]) {
      await assertObservabilityPreflight(raw, rewrittenHostChars, genericObservabilityUrl);
    }
    const queryBackslash = await render(
      "openclaw",
      baseInput({
        controlPlane: {
          ...baseInput().controlPlane,
          observabilityUrl: "https://grafana.example.test/d/operations?var-pattern=\\d+",
        },
      }),
    );
    assert.equal(queryBackslash.summary.ok, true);

    // URL parsing trims C0 controls and spaces and lowercases the scheme, so this is the
    // written address 192.0.2.10. Preflight and the startup parser must both accept it.
    const spaced = await render(
      "openclaw",
      baseInput({
        controlPlane: { ...baseInput().controlPlane, observabilityUrl: " HTTP://192.0.2.10 " },
      }),
    );
    assert.equal(spaced.summary.ok, true);
    const spacedSnapshot = await loadStartupConfigurationSnapshot({
      mode: "production",
      environment: { OCC_CONFIG_PATH: join(spaced.directory, "installation.yaml") },
    });
    assert.equal(spacedSnapshot.observability?.url, "http://192.0.2.10/");
  });
}
