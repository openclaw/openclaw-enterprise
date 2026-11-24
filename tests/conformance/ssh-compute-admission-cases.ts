import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { Check } from "typebox/value";
import {
  SshComputeDriver,
  type SshComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import {
  ConfigurationValidationError as SharedConfigurationValidationError,
  requireConfiguration,
} from "../../packages/contracts/src/index.ts";
import { fixture, options, parseJson, parseRecord } from "./ssh-compute-fixture.ts";

// The unit's PrivateTmp hides /tmp and /var/tmp, so a state root there timed out every deploy;
// docs already forbade it (finding 2358).
test("SSH startup refuses a runtime.root and Node or OpenClaw paths the unit cannot use", () => {
  const dedicated =
    "Use a dedicated absolute directory without . or .. segments, such as /var/lib/openclaw-enterprise.";
  const privateTmp =
    "Use a path outside /tmp and /var/tmp, such as /var/lib/openclaw-enterprise: the unit's PrivateTmp hides those.";
  for (const [root, message] of [
    ["/", dedicated],
    ["//", dedicated],
    ["/var/lib/../../tmp/oce", dedicated],
    ["/var/lib/./oce", dedicated],
    ["/tmp", privateTmp],
    ["/tmp/openclaw-enterprise", privateTmp],
    ["//var/tmp/oce", privateTmp],
  ] as const) {
    const candidate = options();
    candidate.runtime.root = root;
    assert.throws(
      () => requireConfiguration(SshComputeDriver, candidate),
      (error) => {
        assert.ok(error instanceof SharedConfigurationValidationError, root);
        assert.deepEqual(error.error.details, [
          { path: "/runtime/root", code: "INVALID_VALUE", message },
        ]);
        return true;
      },
    );
  }
  for (const root of [
    "/var/lib/openclaw-enterprise",
    "/srv/tmp/oce",
    "/tmpdata",
    "/var/tmpfiles",
  ]) {
    const candidate = options();
    candidate.runtime.root = root;
    requireConfiguration(SshComputeDriver, candidate);
  }
  // The unit's ExecStart and ExecStartPre run the Node and OpenClaw paths, which PrivateTmp
  // hides just the same.
  const privatePaths: [
    edit: (candidate: ReturnType<typeof options>) => void,
    path: string,
    prefix: string,
  ][] = [
    [(candidate) => (candidate.runtime.nodePath = "/tmp/node"), "/runtime/nodePath", ""],
    [
      (candidate) => (candidate.runtime.openclawPath = "/var/tmp/oc.js"),
      "/runtime/openclawPath",
      "",
    ],
    [
      (candidate) => (candidate.hosts.stable.nodePath = "/tmp/node"),
      "/hosts",
      "hosts.stable.nodePath: ",
    ],
    [
      (candidate) => (candidate.hosts.stable.openclawPath = "//tmp/oc.js"),
      "/hosts",
      "hosts.stable.openclawPath: ",
    ],
    [
      (candidate) => (candidate.runtime.openclawPath = "/var/./tmp/oc.js"),
      "/runtime/openclawPath",
      "",
    ],
    [
      (candidate) => (candidate.hosts.stable.nodePath = "/usr/../tmp/node"),
      "/hosts",
      "hosts.stable.nodePath: ",
    ],
  ];
  for (const [edit, path, prefix] of privatePaths) {
    const candidate = options();
    edit(candidate);
    assert.throws(
      () => requireConfiguration(SshComputeDriver, candidate),
      (error) => {
        assert.ok(error instanceof SharedConfigurationValidationError, path);
        assert.deepEqual(error.error.details, [
          { path, code: "INVALID_VALUE", message: `${prefix}${privateTmp}` },
        ]);
        return true;
      },
    );
  }
  const elsewhere = options();
  elsewhere.hosts.stable.openclawPath = "/srv/tmp/oc.js";
  requireConfiguration(SshComputeDriver, elsewhere);
});

test("SSH closed schema and semantic validation reject every invalid option", () => {
  const schema = SshComputeDriver.configurationSchema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.isFrozen(schema.properties.runtime), true);
  assert.equal(Check(schema, options()), true);
  // Each invalid option names the check that refuses it.
  const invalid: [keys: string[], value: unknown, refusal: RegExp | { message: string }][] = [
    [[], null, /SSH options must be an object/],
    [["executor"], {}, /SSH options contains an unsupported option/],
    [["ssh"], {}, /ssh\.identityFile is required/],
    [["hosts"], {}, /hosts must map exact Namespace names to SSH hosts/],
    [["runtime"], {}, /runtime\.nodePath is required/],
    [["network"], {}, /gatewayPortRange must be an object/],
    [["ssh", "extra"], true, /ssh contains an unsupported option/],
    [["hosts", "stable", "extra"], true, /SSH host contains an unsupported option/],
    [["runtime", "extra"], true, /runtime contains an unsupported option/],
    [["network", "extra"], true, /network contains an unsupported option/],
    [["network", "gatewayPortRange", "extra"], true, /gatewayPortRange contains an unsupported/],
    [["ssh", "connectTimeoutSeconds"], 0, /connectTimeoutSeconds must be a positive safe/],
    [["ssh", "connectTimeoutSeconds"], 1.5, /connectTimeoutSeconds must be a positive safe/],
    [
      ["ssh", "connectTimeoutSeconds"],
      Number.MAX_SAFE_INTEGER + 1,
      /connectTimeoutSeconds must be a positive safe/,
    ],
    // OpenSSH refuses a longer ConnectTimeout, so every probe would fail and blame the host.
    [["ssh", "connectTimeoutSeconds"], 2_147_483_648, /connectTimeoutSeconds must be at most/],
    [["hosts", "stable", "address"], "", /Host address is required/],
    [["hosts", "stable", "address"], "-oProxyCommand=bad", /Host address must be a hostname or IP/],
    [["hosts", "stable", "address"], "host;false", /Host address must be a hostname or IP/],
    [["hosts", "stable", "user"], "nobody", /SSH hosts require user root/],
    [["hosts", "stable", "port"], 0, /Host port must be an integer from 1 to 65535/],
    [["hosts", "stable", "port"], 65536, /Host port must be an integer from 1 to 65535/],
    [["hosts", "stable", "port"], 1.2, /Host port must be an integer from 1 to 65535/],
    [["runtime", "user"], "root", /runtime\.user must be a non-root account-name prefix/],
    [["runtime", "user"], "bad user", /runtime\.user must be a non-root account-name prefix/],
    [["runtime", "user"], "", /runtime\.user is required/],
    [["network", "gatewayPortRange", "start"], 1023, /Gateway port range start must be an integer/],
    [["network", "gatewayPortRange", "end"], 65536, /Gateway port range end must be an integer/],
    [["network", "gatewayPortRange", "start"], 1.1, /Gateway port range start must be an integer/],
  ];
  const paths: [string, string, ...string[]][] = [
    ["ssh", "identityFile"],
    ["ssh", "knownHostsFile"],
    ["runtime", "nodePath"],
    ["runtime", "openclawPath"],
    ["runtime", "root"],
    ["runtime", "systemdUnitDirectory"],
    ["hosts", "stable", "nodePath"],
    ["hosts", "stable", "openclawPath"],
  ];
  for (const key of paths) {
    const description = key[0] === "hosts" ? `Host ${key[2]}` : key.join(".");
    for (const value of [
      "relative",
      "",
      "/has space",
      "/quote'",
      '/quote"',
      "/control\n",
      "/control\u0000",
      "/shell$(bad)",
      "/systemd%u",
    ]) {
      const message =
        value === ""
          ? `${description} is required.`
          : `${description} must be an absolute path without whitespace, quotes, control characters, or shell/systemd expansions.`;
      invalid.push([key, value, { message }]);
    }
  }
  for (const [keys, value, refusal] of invalid) {
    const candidate: unknown = keys.length === 0 ? value : options();
    const key = keys.at(-1);
    if (key !== undefined) {
      let target = parseRecord(candidate);
      for (const segment of keys.slice(0, -1)) {
        target = parseRecord(target[segment]);
      }
      target[key] = value;
    }
    assert.equal(Check(schema, candidate), false, keys.join("."));
    assert.throws(
      () => requireConfiguration(SshComputeDriver, candidate),
      SharedConfigurationValidationError,
      keys.join("."),
    );
    assert.throws(
      // JavaScript callers can supply malformed input to the constructor.
      () => new SshComputeDriver(candidate as SshComputeDriverOptions),
      SharedConfigurationValidationError,
      `${keys.join(".")}: ${refusal}`,
    );
  }
  const reversed = options();
  reversed.network.gatewayPortRange = { start: 2000, end: 1999 };
  assert.throws(
    () => requireConfiguration(SshComputeDriver, reversed),
    SharedConfigurationValidationError,
  );
  const optional = options();
  optional.ssh.connectTimeoutSeconds = 2;
  optional.hosts.stable = {
    address: "::1",
    port: 2222,
    user: "root",
    nodePath: "/usr/bin/node",
    openclawPath: "/opt/openclaw.mjs",
  };
  assert.doesNotThrow(() => new SshComputeDriver(optional));
});

test("SSH preflight probes configured hosts, names failures, and checks local files", async (t) => {
  const f = await fixture(t);
  await f.driver.preflight();
  assert.equal(f.calls.length, 1);
  const [probe] = f.calls;
  assert.ok(probe);
  assert.equal(probe.port, 22);
  assert.equal(probe.connectTimeoutSeconds, 10);
  const operation = parseJson(Buffer.from(probe.operation, "base64").toString("utf8"));
  assert.equal(parseRecord(operation).operation, "probe");
  await rm(f.configured.runtime.openclawPath);
  await assert.rejects(f.driver.preflight(), /host stable \(127\.0\.0\.1\)/);
  await rm(f.configured.ssh.identityFile);
  await assert.rejects(f.driver.preflight(), /identityFile.*existing local file/);
});
