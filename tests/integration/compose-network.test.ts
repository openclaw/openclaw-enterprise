import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { selectComposeSubnet } from "../helpers/compose-network.mjs";
import { writeFirstAgentCliFixture } from "../helpers/ci-runner-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

function inventory(subnets: string[]) {
  return subnets.map((Subnet) => JSON.stringify([{ Subnet }])).join("\n") + "\n";
}

function runner(subnets: string[]) {
  const ids = subnets.map((_, index) => `network-${index}`);
  return async (args: string[]) => {
    if (args.join(" ") === "network ls -q") {
      return ids.join("\n") + "\n";
    }
    assert.deepEqual(args, ["network", "inspect", "--format", "{{json .IPAM.Config}}", ...ids]);
    return inventory(subnets);
  };
}

test("Compose fixture selection avoids enclosing and enclosed Docker subnets", async () => {
  assert.equal(
    await selectComposeSubnet({
      runDocker: runner(["172.20.0.0/16", "172.21.1.128/25", "2001:db8::/64"]),
    }),
    "172.21.2.0/24",
  );
  // A busy host can consume the entire original candidate pool. The fallback
  // must still reject a smaller network inside its first candidate.
  assert.equal(
    await selectComposeSubnet({ runDocker: runner(["172.16.0.0/12", "10.254.1.128/25"]) }),
    "10.254.2.0/24",
  );
});

test("Compose fixtures preserve explicit selection without inspecting another endpoint", async () => {
  assert.equal(
    await selectComposeSubnet({
      subnet: "10.253.4.0/24",
      runDocker: () => assert.fail("explicit selection must not inspect Docker"),
    }),
    "10.253.4.0/24",
  );
  // A misplaced private value must fail before the QA caller can record it.
  await assert.rejects(
    selectComposeSubnet({
      subnet: "private-value-in-the-wrong-setting",
      runDocker: async () => assert.fail("invalid override must not inspect Docker"),
    }),
    { message: "Compose selection received an invalid IPv4 subnet." },
  );
});

test("Compose selection reports inventory failure and exhaustion instead of using the default", async () => {
  const failure = new Error("selected Docker endpoint unavailable");
  await assert.rejects(
    selectComposeSubnet({
      runDocker: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    selectComposeSubnet({ runDocker: runner(["172.16.0.0/12", "10.0.0.0/8"]) }),
    /No unused private Compose subnet available.*OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR/,
  );
  await assert.rejects(
    selectComposeSubnet({ runDocker: runner(["172.20.0.0/33"]) }),
    /invalid IPv4 subnet/,
  );
});

test("Compose fixture selects from an empty Docker inventory without inspecting nonexistent networks", async () => {
  assert.equal(
    await selectComposeSubnet({
      runDocker: async (args) => {
        assert.deepEqual(args, ["network", "ls", "-q"]);
        return "";
      },
    }),
    "172.20.1.0/24",
  );
});

test("first-Agent passes the selected subnet to startup on the inventoried Docker endpoint", async (t) => {
  const root = await temporaryDirectory(t, "compose-subnet-");
  await mkdir(join(root, "tests"));
  // These executables substitute only external processes. The actual stack
  // helper selects the subnet and supplies startup's environment. No Docker
  // daemon, model request or successful deployment is claimed by this test.
  await writeFirstAgentCliFixture(
    root,
    `
import { writeFileSync } from "node:fs";
if (process.argv[3] === "up") {
  writeFileSync(process.env.SUBNET_RECEIPT, JSON.stringify({
    subnet: process.env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR,
    endpoint: process.env.DOCKER_HOST,
    credential: process.env.OPENAI_API_KEY !== undefined,
  }));
  process.exitCode = 23;
}
`,
  );
  const endpoint = "unix:///fixture-selected-docker.sock";
  await writeFile(
    join(root, "bin/docker"),
    `#!${process.execPath}
import assert from "node:assert/strict";
assert.equal(process.env.DOCKER_HOST, ${JSON.stringify(endpoint)});
assert.equal(process.env.OPENAI_API_KEY, undefined);
const args = process.argv.slice(2);
if (args.join(" ") === "network ls -q") console.log("network-0\\nnetwork-1");
else {
  assert.deepEqual(args, ["network", "inspect", "--format", "{{json .IPAM.Config}}", "network-0", "network-1"]);
  console.log(${JSON.stringify(inventory(["172.16.0.0/12", "10.254.1.0/24"]))});
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(root, "startup.test.mjs"),
    `
import assert from "node:assert/strict";
import test from "node:test";
import { localFirstAgentStack } from "./tests/helpers/local-first-agent-stack.mjs";
test("startup", async (t) => {
  await assert.rejects(localFirstAgentStack(t), /Start Local Setup exited with status 23/);
});
`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(OCC_|OPENAI_|CODEX_|DOCKER_|NODE_TEST_|OPENCLAW_)/.test(name),
    ),
  );
  const receipt = join(root, "subnet.json");
  const result = spawnSync(process.execPath, ["--test", join(root, "startup.test.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      DOCKER_HOST: endpoint,
      SUBNET_RECEIPT: receipt,
      OCC_TEST_LOCAL_FIRST_AGENT_REAL: "1",
      OCC_TEST_LOCAL_FIRST_AGENT_CONTROL_PLANE: "compose",
      OPENAI_API_KEY: "synthetic-unused-credential",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
    subnet: "10.254.2.0/24",
    endpoint,
    credential: false,
  });
});
