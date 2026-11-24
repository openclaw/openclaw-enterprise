import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import {
  refuseRewrittenIpv4Host,
  refuseWrittenUserinfo,
} from "../../apps/controller/src/auth/configuration.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  bootstrapEnv,
  deploymentEnv,
  repository,
  signInSettings,
  type SignInSettings,
} from "../helpers/sign-in-chart.ts";
import type { ChartValues } from "../helpers/production-chart-network-fixture.ts";
import {
  googleUpgradeSettings,
  googleUpgradeValues,
  oidcUpgradeSettings,
  oidcUpgradeValues,
} from "../helpers/production-sign-in.mjs";
import {
  jobRefusal,
  recoveryUserId,
  refusal,
  render,
  resolveSecrets,
  settle,
  startsUp,
  startupCode,
  tooling,
} from "./sign-in-chart-parity-fixture.ts";

// Read a character class from the Helm helper as a JavaScript regular expression.
let helpersSource: Promise<string> | undefined;
async function helperPattern(name: string) {
  helpersSource ??= readFile(
    join(repository, "deploy/helm/openclaw-enterprise/templates/_helpers.tpl"),
    "utf8",
  );
  const helpers = await helpersSource;
  const [, source] = helpers.match(new RegExp(`\\$${name} := "(\\[[^"]+\\])"`)) ?? [];
  assert.ok(source, `_helpers.tpl defines $${name}`);
  return new RegExp(source.replaceAll("\\\\x{", "\\u{"), "u");
}
const codePointName = (codePoint: number) =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

// Base URL cases: `chart` is the refusal (or undefined when it renders), `api` and `job` whether
// the API and the bootstrap Job accept the URL.
const urls = (
  list: readonly string[],
  chart: RegExp | undefined,
  { api, job = api }: { api: boolean; job?: boolean },
) => list.map((baseUrl) => ({ baseUrl, chart, api, job }));

export function registerUrlCases() {
  // The API refuses an auth base URL that is not an absolute HTTP(S) origin: startApi parses
  // OCC_AUTH_BASE_URL, and createControllerAuth (validHttpBaseURL, which the bootstrap Job also
  // runs before it) refuses the rest, both as AUTH_BASE_URL_INVALID. The bootstrap Job also
  // refuses plain HTTP unless the host is 127.0.0.1 or localhost. The chart refuses the same
  // values at render time and still renders every origin both accept. Native admin is off, so
  // only the origin checks apply.
  test(
    "the chart refuses auth base URLs the API or the bootstrap Job refuses",
    tooling,
    async () => {
      const values = { "agentNativeAdmin.enabled": "false" };
      const environment = resolveSecrets(
        signInSettings(deploymentEnv(await render(values), "api")),
      );
      // Use the controller's origin and cookie-scope checks on the normalized URL.
      const apiAccepts = (baseUrl: string) => {
        const parsed = URL.parse(baseUrl);
        if (parsed === null) {
          return false;
        }
        try {
          refuseWrittenUserinfo("OCC_AUTH_BASE_URL", baseUrl);
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.match(error.message, /^OCC_AUTH_BASE_URL must not contain user info/);
          return false;
        }
        try {
          refuseRewrittenIpv4Host("OCC_AUTH_BASE_URL", baseUrl, parsed);
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /^OCC_AUTH_BASE_URL IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
          );
          return false;
        }
        const normalized = parsed.toString().replace(/\/$/, "");
        try {
          createControllerAuth({
            mode: "production",
            installationId: "ins_chart_parity_url",
            secret: "s".repeat(32),
            baseURL: normalized,
            agentDomain: "agents.oce.example.internal",
          });
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /OCC_AUTH_BASE_URL|Shared session cookies|Console and Agent hostnames/,
          );
          return false;
        }
        return true;
      };
      const notOrigin = /auth\.baseUrl must be an absolute HTTP\(S\) origin|unable to parse url/;
      const plainHttp = /auth\.baseUrl must use HTTPS for (?:shared )?browser sessions/;
      const unicodeEdge =
        /auth\.baseUrl must not begin or end with Unicode spaces or invisible characters/;
      const unicodeInside = /auth\.baseUrl must not contain spaces, invisible characters, < or >/;
      const compatibility = /auth\.baseUrl must not contain compatibility characters/;
      const cases = [
        ...urls(
          [
            "https://console.oce.example.internal/occ",
            "https://console.oce.example.internal/occ/",
            "https://console.oce.example.internal?next=1",
            "https://console.oce.example.internal/?next=1",
            "https://console.oce.example.internal#console",
            // An empty query or fragment parses as none, but survives serialization
            // (https://host/?), which would move Better Auth's routes under /?/auth.
            "https://console.oce.example.internal?",
            "https://console.oce.example.internal/?",
            "https://console.oce.example.internal#",
            "https://console.oce.example.internal/#",
            " https://console.oce.example.internal? ",
            "https://admin@console.oce.example.internal",
            syntheticCredentialUrl({
              username: "admin",
              password: "secret",
              host: "console.oce.example.internal",
            }),
            syntheticCredentialUrl({
              username: "",
              password: "secret",
              host: "console.oce.example.internal",
            }),
            // Node drops an empty user info and publishes the host alone; Go keeps it.
            "https://@console.oce.example.internal",
            "https://:@console.oce.example.internal",
            "https:@console.oce.example.internal",
            "console.oce.example.internal",
            "//console.oce.example.internal",
            "ftp://console.oce.example.internal",
            "https://console.oce.example.internal:65536",
            // Go keeps everything before the last colon in the host name and accepts an IPv6 zone
            // ID; Node refuses both.
            "https://console.oce.example.internal:80:1",
            "https://192.0.2.10:80:1",
            "https://[fe80::1%25eth0]",
            "https://",
            "http://localhost/occ",
          ],
          notOrigin,
          { api: false },
        ),
        ...urls(
          [
            "https://console.oce.example.internal",
            "https://console.oce.example.internal/",
            "https://console.oce.example.internal:8443",
            "https://console.oce.example.internal:0443/",
            "https://console.oce.example.internal:65535",
            "HTTPS://Console.OCE.example.internal",
            "https://console.oce.example.internal.",
            " https://console.oce.example.internal ",
            // A bare 0x, a full-width digit, or an ideographic dot inside a DNS name is not an
            // IPv4 host. Node keeps the name (mapping the borrowed characters) and the chart
            // must render it.
            "https://0x.oce.example.internal",
            "https://console\u3002oce.example.internal",
            "https://\uFF11\uFF12\uFF17.oce.example.internal",
            "https://bücher.oce.example.internal",
            "https://console.例え.oce.example.internal",
            // Only the last label decides whether a host is IPv4, after the parser maps
            // compatibility characters (⑩ becomes 10, so this label is 10x).
            "https://192.0.2.10.oce.example.internal",
            "https://example.\u2469x.oce.example.internal",
            // Helm reads http://[::1] as hostname ::1, which the bootstrap Job admits.
          ],
          undefined,
          { api: true },
        ),
        ...urls(
          [
            "https://192.0.2.10",
            "https://192.168.10.1",
            "https://10.0.0.1",
            "https://[2001:db8::10]:8443",
            "https://localhost",
          ],
          /must share a non-public DNS suffix/,
          { api: false, job: false },
        ),
        ...urls(
          [
            "http://127.0.0.1",
            "http://127.0.0.1:8080/",
            "http://localhost:8080",
            "HTTP://LocalHost:8080",
            " http://localhost ",
            "http://[::1]:8080",
          ],
          plainHttp,
          { api: false, job: false },
        ),
        // URL parsing strips only C0 controls and spaces from the ends, so other Unicode spaces
        // and invisible characters there reach the parser, which refuses them in the scheme or
        // a host. The chart refuses them all; it is deliberately stricter for U+FEFF and U+200B
        // at the end, which the host parser drops. A trailing unassigned code point (U+0378),
        // which RE2's \p{C} does not cover, is refused too.
        ...urls(["https://console.oce.example.internal\u0378"], unicodeEdge, { api: false }),
        ...(
          [
            ["\u00a0", false],
            ["\u2003", false],
            ["\u3000", false],
            ["\uFEFF", true],
            ["\u200b", true],
          ] as const
        ).flatMap(([space, trailingAccepted]) => [
          ...urls([`${space}https://console.oce.example.internal`], unicodeEdge, { api: false }),
          ...urls([`https://console.oce.example.internal${space}`], unicodeEdge, {
            api: trailingAccepted,
          }),
          ...urls([` ${space}https://console.oce.example.internal${space} `], unicodeEdge, {
            api: false,
          }),
        ]),
        // Inside the host, the parser refuses spaces, < and >, and drops tabs and most invisible
        // characters. The chart refuses them all (deliberately stricter for the dropped ones),
        // but keeps the joiners U+200C and U+200D that some IDN labels need.
        ...(
          [
            [" ", false],
            ["\u00a0", false],
            ["\u2003", false],
            ["\u3000", false],
            ["\u2028", false],
            // Go's URL parser keeps these, but the API's refuses them.
            ["<", false],
            [">", false],
            ["\t", true],
            ["\uFEFF", true],
            ["\u200b", true],
            ["\u00ad", true],
          ] as const
        ).flatMap(([space, accepted]) =>
          urls([`https://console${space}.oce.example.internal`], unicodeInside, { api: accepted }),
        ),
        // Both parsers percent-decode the host, so the chart checks the decoded name too.
        ...urls(
          ["%C2%A0", "%E3%80%80"].map((space) => `https://console${space}.oce.example.internal`),
          unicodeInside,
          { api: false },
        ),
        // The host parser maps compatibility characters first and refuses those that map to a
        // forbidden host code point (full-width ? # / @, ?? from U+2047) or that UTS #46
        // disallows (U+2488 maps to "1.", U+FFFD). Go's URL parser keeps them. A sample here;
        // the next test checks the chart's whole list against Node.
        ...urls(
          [
            "https://console%EF%BC%9F.oce.example.internal",
            ...["\uff1f", "\uff03", "\uff0f", "\uff20", "\ufe56", "\u2047", "\u2488", "\ufffd"].map(
              (character) => `https://console${character}.oce.example.internal`,
            ),
          ],
          compatibility,
          { api: false },
        ),
        ...urls(
          [
            "https://\u0646\u0627\u0645\u0647\u200c\u0627\u06cc.oce.example.internal",
            "https://\u0915\u094d\u200d\u0937.oce.example.internal",
          ],
          undefined,
          { api: true },
        ),
        // The API serves plain HTTP anywhere, but the bootstrap Job refuses it off loopback.
        ...urls(
          [
            "http://console.oce.example.internal",
            "HTTP://console.oce.example.internal",
            "http://192.0.2.10:8080",
            "http://127.0.0.2",
            "http://localhost.",
            "http://localhost.oce.example.internal",
          ],
          plainHttp,
          { api: false, job: false },
        ),
        // Node repairs these degenerate spellings into an origin. They are not IPv4 hosts.
        ...urls(
          [
            "https:console.oce.example.internal",
            "https://console.oce.example.internal/.",
            "https://console.oce.example.internal/%2e",
          ],
          notOrigin,
          { api: true },
        ),
        // A leading zero is octal (192.168.010.001 publishes 192.168.8.1). Hex, including a
        // bare 0x (which is 0), shorthand, a single integer and a trailing dot also publish
        // a different host. The parser first maps compatibility digits, letters and dots
        // (１２７.0.0.1, ①②⑦.0.0.1, 𝟏𝟐𝟕.0.0.1 and 127。0。0。1 publish 127.0.0.1; ０ｘ７ｆ is
        // 0x7f) and drops variation selectors. A host whose last label is then a number but
        // that is not IPv4 (example.123, foo.1.) does not parse at all. The chart, the API
        // and the bootstrap Job all refuse those spellings.
        ...urls(
          [
            "https://192.168.010.001",
            "https://192.168.001.010",
            "https://010.0.0.1",
            "https://127.1",
            "https://0x7f.0.0.1",
            "https://0x",
            "https://0x.0.0.1",
            "https://2130706433",
            "http://127.1",
            "http://2130706433",
            "http://0177.0.0.1",
            "http://127.0.0.1.",
            "https://\uFF11\uFF12\uFF17.0.0.1",
            "https://127\u30020\u30020\u30021",
            "https://127\uFF0E0\uFF0E0\uFF0E1",
            "https://127\uFF610\uFF610\uFF611",
            "https://\u2460\u2461\u2466.0.0.1",
            "https://\u{1D7CF}\u{1D7D0}\u{1D7D5}.0.0.1",
            "https://\u00B9\u00B2\u2077.0.0.1",
            "https://\u2081\u2082\u2087.0.0.1",
            "https://\u{1FBF1}\u{1FBF2}\u{1FBF7}.0.0.1",
            "https://10.0.0.\u2460",
            "https://\u2469.0.0.1",
            "https://\u24EA.0.0.0",
            "https://\uFF10\uFF58\uFF17\uFF46.0.0.1",
            "https://0x\u33C8.0.0.1",
            "https://127.0.0.1\uFE0F",
            "https://example.123",
            "https://example.0x",
            "https://foo.1.",
            "https://1e3.0.0.1",
            "https://b\u00fccher.1",
            "https://example.\u2460",
          ],
          /auth\.baseUrl IPv4 host must be four decimal octets from 0 to 255 with no leading zeros/,
          { api: false },
        ),
      ];
      // The bootstrap Job, then the chart; a rendered value also starts the API.
      const checks = cases.map(async ({ baseUrl, chart, api, job }) => {
        const label = JSON.stringify(baseUrl);
        assert.equal(apiAccepts(baseUrl), api, label);
        assert.equal(jobRefusal(baseUrl), job ? undefined : "AUTH_BASE_URL_INVALID", label);
        if (chart !== undefined) {
          assert.match(await refusal({ ...values, "auth.baseUrl": baseUrl }), chart, label);
          return;
        }
        const objects = await render({ ...values, "auth.baseUrl": baseUrl });
        for (const [workload, env] of [
          ["api", deploymentEnv(objects, "api")],
          ["bootstrap", bootstrapEnv(objects)],
        ] as const) {
          assert.ok(
            env.some(({ name, value }) => name === "OCC_AUTH_BASE_URL" && value === baseUrl),
            `${label} ${workload}`,
          );
        }
        // The API's startup gets past configuration with the rendered value.
        await startsUp({ ...environment, OCC_AUTH_BASE_URL: baseUrl }, label);
      });
      // The API startup's own code for a value it cannot parse, and its own refusals of a
      // rewritten IPv4 host and an empty user info: apiAccepts copies refuseRewrittenIpv4Host
      // and refuseWrittenUserinfo, and the cases above start the API only for values the chart
      // renders, so deleting a call in api-startup.ts leaves the rest of this test green.
      const ownRefusals = [
        "console.oce.example.internal",
        "https://192.168.010.001",
        "https://@console.oce.example.internal",
      ].map(async (baseUrl) =>
        assert.equal(
          await startupCode({ ...environment, OCC_AUTH_BASE_URL: baseUrl }),
          "AUTH_BASE_URL_INVALID",
          baseUrl,
        ),
      );
      await settle([...checks, ...ownRefusals]);
    },
  );

  // The chart refuses a listed set of compatibility characters ($baseUrlHostRefused) that the
  // API's URL parser refuses in a host. This re-derives the list from Node: of the non-ASCII
  // letters, marks, numbers, punctuation and symbols (what the chart's other Unicode checks let
  // through), exactly those that URL parsing refuses in every host context tried are listed. The
  // contexts put Latin, Arabic, Hebrew and virama neighbours on each side, in every label
  // position, so a character refused only by the Bidi or joiner rules, or at a label start, is
  // never listed. The refusals follow the IDNA tables of Node's URL parser (ada), so a Node
  // upgrade can change them; this test then names the code points to add or remove.
  // JavaScript's Unicode tables can be newer than Go's: a listed code point that Go's RE2 reads
  // as unassigned is refused by the chart's earlier check instead, which is harmless.
  test("the chart lists exactly the compatibility characters the API's URL parser refuses in a host", async () => {
    const listed = await helperPattern("baseUrlHostRefused");
    const parses = (host: string) => URL.canParse(`https://${host}`);
    const labels = (character: string) =>
      ["", "a", "\u0627", "\u05d0", "\u0915\u094d"].flatMap((before) =>
        ["", "a", "\u0627", "\u05d0"].map((after) => `${before}${character}${after}`),
      );
    const refusedEverywhere = (character: string) =>
      !labels(character).some((label) =>
        [label, `${label}.example`, `example.${label}`, `${label}.\u0627`].some(parses),
      );
    const missing: string[] = [];
    const extra: string[] = [];
    let count = 0;
    // Surrogates are category Cs, so the property test skips them.
    for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint++) {
      const character = String.fromCodePoint(codePoint);
      if (/[\p{L}\p{M}\p{N}\p{P}\p{S}]/u.test(character)) {
        const isListed = listed.test(character);
        count += isListed ? 1 : 0;
        if (refusedEverywhere(character) !== isListed) {
          (isListed ? extra : missing).push(codePointName(codePoint));
        }
      }
    }
    assert.ok(count > 0, "the list matches no letter, mark, number, punctuation or symbol");
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });

  // Before deciding whether a host is IPv4, the API's URL parser maps compatibility characters
  // (UTS #46). The chart lists the ones that become ASCII the IPv4 check reads: dropped
  // characters, dots, a zero, other digit runs, x, and hex letter runs. This re-derives each
  // list from Node by parsing the character between two letters. A Node upgrade can change
  // them; this test then names the code points to add or remove.
  test("the chart maps exactly the characters the API's URL parser maps to IPv4 syntax", async () => {
    const classes: Readonly<Record<string, (mapped: string) => boolean>> = {
      ipv4Ignored: (mapped) => mapped === "",
      ipv4Dots: (mapped) => mapped === ".",
      ipv4Zeros: (mapped) => mapped === "0",
      ipv4Digits: (mapped) => /^[0-9]+$/.test(mapped) && mapped !== "0",
      ipv4X: (mapped) => mapped === "x",
      ipv4Hex: (mapped) => /^[0-9a-f]*[a-f][0-9a-f]*$/.test(mapped),
    };
    const patterns = await Promise.all(
      Object.entries(classes).map(async ([name, matches]) => {
        const pattern = await helperPattern(name);
        const differences: string[] = [];
        return { name, matches, pattern, differences };
      }),
    );
    for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint++) {
      const character = String.fromCodePoint(codePoint);
      // What the chart's earlier checks let through. Surrogates are category Cs.
      if (!/[\p{L}\p{M}\p{N}\p{P}\p{S}\u200c\u200d]/u.test(character)) {
        continue;
      }
      const url = URL.parse(`https://q${character}q.example`);
      const mapped = url === null ? undefined : /^q([ -~]*)q\.example$/.exec(url.hostname)?.[1];
      for (const { matches, pattern, differences } of patterns) {
        if ((mapped !== undefined && matches(mapped)) !== pattern.test(character)) {
          differences.push(codePointName(codePoint));
        }
      }
    }
    assert.ok((await helperPattern("ipv4Digits")).test("\u2460"), "the digit list matches U+2460");
    for (const { name, differences } of patterns) {
      assert.deepEqual(differences, [], name);
    }
  });

  // The chart's sign-in checks read the scheme as URL parsing does, like the API: an uppercase
  // HTTPS origin, or one with surrounding spaces, passes for Google and OIDC. Plain HTTP
  // stays refused even on loopback, where the bootstrap Job would accept it. The API also
  // requires HTTPS for production external sign-in, but only after its database opens, so only
  // the chart's refusal is checked here.
  test("external sign-in accepts the HTTPS spellings the API accepts", tooling, async () => {
    const providers: readonly [provider: string, values: ChartValues, settings: SignInSettings][] =
      [
        ["Google", googleUpgradeValues(recoveryUserId), googleUpgradeSettings(recoveryUserId)],
        ["OIDC", oidcUpgradeValues(recoveryUserId), oidcUpgradeSettings(recoveryUserId)],
      ];
    const refusals = providers.map(async ([provider, values]) =>
      assert.match(
        await refusal({ ...values, "auth.baseUrl": "http://localhost:8080" }),
        new RegExp(`auth\\.${provider.toLowerCase()} requires an HTTPS auth\\.baseUrl`),
        provider,
      ),
    );
    const accepted = providers.flatMap(([provider, values, settings]) =>
      ["HTTPS://Console.OCE.example.internal", " https://console.oce.example.internal "].map(
        async (baseUrl) => {
          const label = `${provider} ${JSON.stringify(baseUrl)}`;
          assert.equal(jobRefusal(baseUrl), undefined, label);
          const objects = await render({ ...values, "auth.baseUrl": baseUrl });
          const rendered = signInSettings(deploymentEnv(objects, "api"));
          assert.deepEqual(rendered, { ...settings, OCC_AUTH_BASE_URL: baseUrl }, label);
          await startsUp(resolveSecrets(rendered), label);
        },
      ),
    );
    await settle([...refusals, ...accepted]);
  });
}
