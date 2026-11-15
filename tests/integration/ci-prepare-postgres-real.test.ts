import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import fs, { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { setEnvironment } from "../helpers/environment.ts";
import { attachKeycloakToK3d, attachPostgresToK3d } from "../helpers/k3d-postgres-network.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test(
  "PostgreSQL preparation uses distinct Docker-assigned loopback ports and cleans its projects",
  { skip: process.env.OCC_TEST_CI_POSTGRES_REAL !== "1", timeout: 180_000 },
  async (t) => {
    const managed = process.env.OCC_TEST_CI_POSTGRES_STATES;
    const parentPath = managed === undefined ? undefined : process.env.OPENCLAW_ENTERPRISE_CI_STATE;
    const states: { path: string; owner: string }[] =
      managed !== undefined ? JSON.parse(managed) : [];
    if (managed !== undefined) {
      assert.ok(parentPath, "Managed PostgreSQL states require their parent journal");
      // Validate and read the same file even if the pathname is replaced.
      const parentFile = await open(
        parentPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        assert.ok(
          (await parentFile.stat()).isFile(),
          "Managed PostgreSQL parent must be a regular journal",
        );
        const parent = JSON.parse(await parentFile.readFile("utf8"));
        assert.equal(parent.version, 1);
        assert.equal(parent.statePath, resolve(parentPath));
        assert.equal(parent.repositoryRoot, resolve(repositoryRoot));
        assert.equal(parent.lane, "postgres");
        assert.match(parent.prefix, /^openclaw-ci-[a-z0-9-]+$/);
        const children = parent.resources.filter(
          (resource: { kind: string }) => resource.kind === "child-state",
        );
        assert.equal(
          children.length,
          2,
          "Managed PostgreSQL requires exactly two registered children",
        );
        const registered = children.map((child: { owner: string; id: string; name: string }) => {
          assert.equal(child.owner, parent.prefix);
          assert.match(child.id, /^child-state-[a-f0-9]{12}$/);
          assert.ok(child.name.startsWith(`${parent.prefix}-child-`));
          assert.match(child.name.slice(`${parent.prefix}-child-`.length), /^[a-f0-9]{12}$/);
          return {
            path: join(dirname(resolve(parentPath)), `${child.name}.json`),
            owner: child.id,
          };
        });
        assert.equal(new Set(registered.map((child: { path: string }) => child.path)).size, 2);
        assert.equal(new Set(registered.map((child: { owner: string }) => child.owner)).size, 2);
        assert.deepEqual(states, registered, "Managed PostgreSQL states must match their parent");
      } finally {
        await parentFile.close();
      }
    }
    const root = await mkdtemp(join(tmpdir(), "ci-postgres-real-"));
    if (managed === undefined) {
      states.push(
        ...["first.json", "second.json"].map((file) => ({
          path: join(root, file),
          owner: randomUUID(),
        })),
      );
    }
    const started: typeof states = [];
    const projects: string[] = [];
    const env = { ...process.env, GITHUB_ENV: "", GITHUB_OUTPUT: "" };
    const node = (args: string[]) =>
      execFileSync(process.execPath, args, {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 90_000,
      });
    const docker = (args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
    t.after(async () => {
      const errors: unknown[] = [];
      for (const state of started) {
        try {
          node([
            "scripts/ci/cleanup.ts",
            "--state",
            state.path,
            "--cleanup-owner",
            state.owner,
            "--lane",
            "postgres-auth",
          ]);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(
          errors,
          `PostgreSQL cleanup failed; retained ${parentPath ?? root}`,
        );
      }
      for (const project of projects) {
        const filter = ["--filter", `label=com.docker.compose.project=${project}`];
        assert.equal(docker(["ps", "-aq", ...filter]), "");
        assert.equal(docker(["volume", "ls", "-q", ...filter]), "");
        assert.equal(docker(["network", "ls", "-q", ...filter]), "");
      }
      await rm(root, { recursive: true });
    });
    const ports = new Set<number>();
    // Keep both real servers alive: Docker, rather than a released caller-side
    // probe, must assign distinct usable ports to the independent preparations.
    for (const { path: statePath, owner } of states) {
      await assert.rejects(
        lstat(statePath),
        { code: "ENOENT" },
        "CI state already exists; refusing to adopt it",
      );
      started.push({ path: statePath, owner });
      node([
        "scripts/ci/prepare.mjs",
        "--lane",
        "postgres-auth",
        "--state",
        statePath,
        "--cleanup-owner",
        owner,
      ]);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const server = state.resources.find(
        (resource: { kind: string }) => resource.kind === "compose-postgres",
      );
      projects.push(server.name);
      assert.equal(server.status, "ready");
      assert.ok(server.port > 0 && server.port <= 65535 && server.port !== 55432);
      ports.add(server.port);
      const container = docker([
        "compose",
        "-f",
        server.composeFile,
        "-p",
        server.name,
        "ps",
        "-q",
        "postgres",
      ]);
      const bindings = JSON.parse(
        docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", container]),
      );
      assert.deepEqual(bindings["5432/tcp"], [{ HostIp: "127.0.0.1", HostPort: "0" }]);
      const published = JSON.parse(
        docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]),
      );
      assert.deepEqual(published["5432/tcp"], [
        { HostIp: "127.0.0.1", HostPort: String(server.port) },
      ]);
    }
    assert.equal(ports.size, 2);
    const envFile = join(root, "test.env");
    node([
      "scripts/ci/prepare.mjs",
      "--lane",
      "postgres-auth",
      "--state",
      states[0]!.path,
      "--file",
      "tests/integration/native-admin-session-postgres.test.mjs",
      "--github-env",
      envFile,
    ]);
    const connectionString = (await readFile(envFile, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("OCC_TEST_DATABASE_URL="))
      ?.slice("OCC_TEST_DATABASE_URL=".length);
    assert.ok(connectionString);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      // The migrator created this table; bootstrap alone creates only schemas.
      assert.deepEqual(
        (
          await client.query(
            "select current_user as role, to_regclass('occ.installation') is not null as migrated",
          )
        ).rows,
        [{ role: "occ_app", migrated: true }],
      );
    } finally {
      await client.end();
    }
  },
);

async function recordingAttachment(t: TestContext, fixture: "postgres" | "keycloak" = "postgres") {
  const containerId = "a".repeat(64);
  const serverId = "d".repeat(64);
  const networkId = "b".repeat(64);
  const composeNetworkId = "e".repeat(64);
  const replacementId = "c".repeat(64);
  const replacementContainerId = "1".repeat(64);
  const connect = ["network", "connect", networkId, containerId];
  const disconnect = ["network", "disconnect", "--force", networkId, containerId];
  const root = await mkdtemp(join(tmpdir(), "ci-k3d-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state.json");
  const providerState = join(root, "provider.json");
  const engineState = join(root, "engine.json");
  const nextObservation = join(root, "next-membership.json");
  const mutationsPath = join(root, "mutations.jsonl");
  const connectIntent = join(root, "connect-intent.json");
  const engine = join(root, "engine.mjs");
  const registry = join(root, `${fixture}-k3d-fixture.json`);
  const lock = registry.replace(/\.json$/, ".lock");
  const attachment = { networkId, containerId };
  const updateEngine = (input: {
    attached?: boolean;
    endpointId?: string;
    networkEndpointId?: string;
    replacement?: boolean;
    keepOriginalNetwork?: boolean;
    replaceContainer?: boolean;
    originalContainerAttached?: boolean;
    unavailable?: boolean;
    serverWithoutNetworkId?: "bound" | "unbound" | "podman" | "empty-id";
    legacy?: "all" | "target" | "unrelated" | "hex-unrelated";
    memberListing?: "present" | "empty";
    peerListing?:
      | "name-only"
      | "id-only"
      | "first-id-only"
      | "omitted"
      | "malformed"
      | "malformed-map"
      | "after-disconnect";
    filter?: "empty" | "short" | "wrong" | "fails" | "disconnect-fails";
    nameLookup?: "wrong-name" | "wrong-id";
    fullIdLookup?: "wrong-name" | "wrong-id" | "unavailable";
    ambiguousHexName?: boolean;
    connectExit?: "before" | "after" | undefined;
    keepOnDisconnect?: boolean;
    disconnectExit?: boolean;
  }) => writeFile(engineState, JSON.stringify(input));

  await writeFile(
    state,
    JSON.stringify({
      resources: [
        { kind: "compose-postgres", status: "ready", name: "fixture" },
        { kind: "k3d-cluster", status: "ready", name: "fixture" },
      ],
    }),
  );
  if (fixture === "keycloak") {
    await writeFile(
      providerState,
      JSON.stringify({
        prefix: "provider",
        resources: [
          { kind: "keycloak-server", status: "ready", name: "keycloak", owner: "provider" },
        ],
      }),
    );
  }
  await updateEngine({});
  await writeFile(mutationsPath, "");
  await writeFile(
    engine,
    stripTypeScriptTypes(`#!${process.execPath}
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(engineState)};
const nextObservation = ${JSON.stringify(nextObservation)};
const state = JSON.parse(readFileSync(statePath, "utf8"));

function saveState() {
  // Parallel engine commands must read a complete state snapshot.
  const temporary = statePath + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, statePath);
}

const args = process.argv.slice(2);
const [command, subcommand, field, reference] = args;
const originalName = "k3d-fixture";
const name = state.replacement && state.keepOriginalNetwork ? "k3d-fixture-v2" : originalName;
const container = ${JSON.stringify(containerId)};
const replacementContainer = ${JSON.stringify(replacementContainerId)};
const selected = state.replaceContainer ? replacementContainer : container;
const server = "k3d-fixture-server-0";
const serverId = ${JSON.stringify(serverId)};
const original = ${JSON.stringify(networkId)};
const composeName = state.legacy === "hex-unrelated" ? "f".repeat(64) : "fixture_default";
const composeId = state.ambiguousHexName ? composeName : ${JSON.stringify(composeNetworkId)};
const current = state.replacement ? ${JSON.stringify(replacementId)} : original;
if (command === "ps" && args.includes("--no-trunc") && args.includes("{{.ID}}")) {
  if (field === "network=" + current || field === "network=" + composeId) {
    const requested = args[4]?.slice(3);
    if (args[3] !== "--filter" || args[4] !== "id=" + requested || ![serverId, container, selected].includes(requested)) {
      throw new Error("Expected exact container filter " + JSON.stringify(args));
    }
    const fail = state.filter === "fails" || (state.releaseAttempted && state.filter === "disconnect-fails");
    if (fail) process.exit(8);
    if (state.filter === "empty") process.exit(0);
    const members = field === "network=" + current ? [serverId] : [container, selected];
    if (field === "network=" + current && state.attached) members.push(selected);
    if (state.filter === "short") {
      console.log(requested.slice(0, 12));
    } else if (state.filter === "wrong") {
      console.log("9".repeat(64));
    } else if (members.includes(requested)) {
      console.log(requested);
    }
  } else if (field === "label=com.docker.compose.project=fixture") {
    console.log(selected);
  } else {
    throw new Error("Unexpected recording engine filter " + JSON.stringify(args));
  }
} else if (command === "ps" && args.includes("{{.Names}}")) {
  console.log("postgres");
} else if (command === "inspect" && field === "{{.Id}}") {
  console.log(reference === server ? serverId : reference === container ? container : selected);
} else if (command === "inspect" && field === "{{json .NetworkSettings.Networks}}") {
  if (reference === selected && existsSync(nextObservation)) {
    const [inventory, ...remaining] = JSON.parse(readFileSync(nextObservation, "utf8"));
    console.log(JSON.stringify(inventory));
    if (remaining.length) {
      writeFileSync(nextObservation, JSON.stringify(remaining));
    } else {
      unlinkSync(nextObservation);
    }
  } else {
    const attached = (reference === selected && state.attached) ||
      (reference === container && state.originalContainerAttached);
    let membership = attached
      ? { [name]: {
          NetworkID: ["all", "target"].includes(state.legacy) ? name : current,
          EndpointID: state.endpointId,
        } }
      : {};
    if (reference === server || reference === serverId) {
      let endpoint = { NetworkID: state.legacy === "all" ? name : current };
      if (state.serverWithoutNetworkId) {
        endpoint = state.serverWithoutNetworkId === "empty-id" ? { NetworkID: "" } : {};
      }
      membership = { [name]: endpoint };
    } else if (state.legacy) {
      membership[composeName] = { NetworkID: state.legacy === "target" ? composeId : composeName };
    }
    console.log(JSON.stringify(membership));
  }
} else if (command === "inspect" && field.includes("IPAddress")) {
  console.log("192.0.2.4");
} else if (command === "network" && subcommand === "inspect") {
  if (state.unavailable) process.exit(7);
  if (state.replacement && field === original) {
    if (!state.keepOriginalNetwork) process.exit(7);
    console.log(JSON.stringify([{ Name: originalName, Id: original, Containers: {} }]));
    process.exit(0);
  }
  const isCompose = field === composeName || field === composeId;
  if (!isCompose && field !== name && field !== current) process.exit(8);
  const canonicalId = isCompose ? composeId : current;
  const lookup = isCompose && (field === canonicalId ? state.fullIdLookup : state.nameLookup);
  if (lookup === "unavailable") process.exit(8);
  const id = lookup === "wrong-id" ? current : canonicalId;
  const networkName = isCompose && lookup !== "wrong-name" ? composeName : name;
  let containers = { [serverId]: { Name: server } };
  if (isCompose) containers = { [container]: { Name: "postgres" }, [selected]: { Name: "postgres" } };
  if (!isCompose && (state.attached || (state.releaseAttempted && state.peerListing === "after-disconnect"))) {
    const reportPeer =
      state.peerListing === "name-only" ? field === name :
      ["id-only", "first-id-only"].includes(state.peerListing) ? field === current : state.peerListing !== "omitted";
    if (reportPeer) {
      containers[selected] = state.peerListing === "malformed" ? null : {
        Name: "postgres",
        EndpointID: state.networkEndpointId ?? state.endpointId,
      };
      if (state.peerListing === "first-id-only") {
        state.peerListing = "omitted";
        saveState();
      }
    }
  }
  if (!isCompose && state.originalContainerAttached) containers[container] = { Name: "postgres-old" };
  if (state.serverWithoutNetworkId === "unbound" || state.memberListing === "empty") containers = {};
  if (state.legacy && !state.memberListing) containers = undefined;
  if (!isCompose && state.attached && state.peerListing === "malformed-map") containers = null;
  const lowerCase = state.legacy || state.serverWithoutNetworkId === "podman";
  console.log(JSON.stringify([lowerCase
    ? { name: networkName, id, containers }
    : { Name: networkName, Id: id, Containers: containers }]));
} else if (command === "network" && ["connect", "disconnect"].includes(subcommand)) {
  appendFileSync(${JSON.stringify(mutationsPath)}, JSON.stringify(args) + "\\n");
  if (subcommand === "connect") {
    const registry = ${JSON.stringify(registry)};
    if (existsSync(registry)) {
      writeFileSync(${JSON.stringify(connectIntent)}, readFileSync(registry));
    }
    if (state.connectExit === "before") process.exit(7);
    state.attached = true;
  } else {
    state.releaseAttempted = true;
    if (!state.keepOnDisconnect) {
      state.attached = false;
    }
  }
  saveState();
  if (subcommand === "connect" ? state.connectExit === "after" : state.disconnectExit) {
    process.exit(7);
  }
} else {
  throw new Error("Unexpected recording engine call " + JSON.stringify(args));
}
`),
    { mode: 0o700 },
  );

  const consoleError = t.mock.method(console, "error", () => {});
  setEnvironment(t, { OPENCLAW_ENTERPRISE_CI_STATE: state, OCC_DOCKER_BIN: engine });
  const releases: Array<() => Promise<void>> = [];
  const register = (release: () => Promise<void>) => releases.push(release);
  const acquire = () =>
    fixture === "keycloak"
      ? attachKeycloakToK3d(register, { container: "keycloak", statePath: providerState })
      : attachPostgresToK3d(register);
  const readRegistry = async () => JSON.parse(await readFile(registry, "utf8"));
  const mutations = async (): Promise<string[][]> =>
    (await readFile(mutationsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const gone = () => assert.rejects(readFile(registry, "utf8"), { code: "ENOENT" });
  const expectNoAdmission = async () => {
    await gone();
    assert.equal(releases.length, 0);
    assert.deepEqual(await mutations(), []);
  };
  const pending = async (
    operation: "pendingConnect" | "pendingRelease",
    connectRollback = false,
    endpointId?: string,
  ) =>
    assert.deepEqual(await readRegistry(), {
      ...(connectRollback ? { connectRollback: true } : {}),
      attachment: { ...attachment, ...(endpointId ? { endpointId } : {}) },
      connectedByHarness: true,
      holders: {},
      [operation]: true,
    });
  const refused = async (message: RegExp | ((error: unknown) => boolean)) => {
    const bytes = await readFile(registry);
    const before = await mutations();
    const count = releases.length;
    await assert.rejects(acquire, message);
    assert.deepEqual(await readFile(registry), bytes);
    assert.deepEqual(await mutations(), before);
    assert.equal(releases.length, count);
  };
  const recovery = (message: string) => {
    for (const expected of [registry, lock, containerId, networkId]) {
      assert.ok(message.includes(expected), message);
    }
    assert.match(message, /full ID/);
    assert.match(message, /unchanged empty pending record/);
    assert.match(message, /Keep the record if the outcome remains unclear/);
  };

  // Fault only the selected atomic write. The actual prior record stays on
  // disk, so the test can distinguish persistence from a diagnostic alone.
  const failRegistryWrite = (...occurrences: number[]) => {
    const original = fs.rename;
    let writes = 0;
    const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof original>) => {
      if (args[1] === registry && occurrences.includes(++writes)) {
        throw Object.assign(new Error("recording registry write failure"), { code: "EIO" });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      fault.mock.restore();
      syncBuiltinESMExports();
    });
  };
  const failUnlock = () => {
    const injected = Object.assign(new Error("recording lock removal failure"), { code: "EROFS" });
    const original = fs.rm;
    const fault = t.mock.method(fs, "rm", async (...args: Parameters<typeof original>) => {
      if (args[0] === lock) {
        throw injected;
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      fault.mock.restore();
      syncBuiltinESMExports();
    });
    return injected;
  };
  return {
    acquire,
    acquireWithoutCleanup: () => {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { attachPostgresToK3d } from ${JSON.stringify(
            new URL("../helpers/k3d-postgres-network.mjs", import.meta.url).href,
          )};
        await attachPostgresToK3d(() => {});`,
        ],
        { timeout: 15_000, stdio: "pipe" },
      );
    },
    attachment,
    replacementContainerId,
    inspectNetworks: (id: string): object =>
      JSON.parse(
        execFileSync(engine, ["inspect", "--format", "{{json .NetworkSettings.Networks}}", id], {
          encoding: "utf8",
          timeout: 5_000,
        }),
      ),
    isAttached: async () => JSON.parse(await readFile(engineState, "utf8")).attached === true,
    connect,
    readConnectIntent: () => readFile(connectIntent),
    disconnect,
    releases,
    gone,
    expectNoAdmission,
    lock,
    registry,
    updateEngine,
    observeNext: (...inventories: [object, ...object[]]) =>
      writeFile(nextObservation, JSON.stringify(inventories)),
    readRegistry,
    mutations,
    pending,
    refused,
    recovery,
    failRegistryWrite,
    failUnlock,
    consoleError,
  };
}

test("k3d fixture attachments preserve exact engine ownership", async (t) => {
  for (const reversed of [false, true]) {
    await t.test(reversed ? "last holder in reverse order" : "last holder", async (t) => {
      const f = await recordingAttachment(t);
      assert.deepEqual(await Promise.all([f.acquire(), f.acquire()]), ["192.0.2.4", "192.0.2.4"]);
      const [first, last] = reversed ? [...f.releases].reverse() : f.releases;
      assert.ok(first && last);
      await first();
      await first();
      assert.deepEqual(await f.mutations(), [f.connect]);
      await last();
      await f.gone();
      assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
    });
  }

  await t.test("Keycloak shares preexisting membership and releases its own", async (t) => {
    const f = await recordingAttachment(t, "keycloak");
    await f.updateEngine({ attached: true });
    await f.acquire();
    await f.acquire();
    assert.equal((await f.readRegistry()).connectedByHarness, false);
    await f.releases[0]!();
    await f.releases[1]!();
    await f.gone();
    assert.deepEqual(await f.mutations(), []);

    // The same caller may later create and release a connection of its own.
    await f.updateEngine({});
    await f.acquire();
    await f.releases[2]!();
    await f.gone();
    assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
  });

  for (const live of [true, false]) {
    await t.test(live ? "live legacy holder" : "inactive legacy holder", async (t) => {
      const f = await recordingAttachment(t);
      const holders = live ? { prior: process.pid } : {};
      await writeFile(f.registry, JSON.stringify({ connectedByHarness: true, holders }));
      await f.updateEngine({ attached: true });
      if (live) {
        await f.refused(/unverified engine binding/);
      } else {
        await f.acquire();
        assert.equal((await f.readRegistry()).connectedByHarness, false);
        await f.releases[0]!();
        await f.gone();
      }
      assert.deepEqual(await f.mutations(), []);
    });
  }

  for (const scenario of [
    "same endpoint",
    "replacement endpoint",
    "missing endpoint",
    "conflicting endpoint",
    "bound legacy holder",
    "engine does not supply endpoint IDs",
    "unbound legacy holder",
    "empty registry",
  ] as const) {
    await t.test(`recovers after holder exit with ${scenario}`, async (t) => {
      const f = await recordingAttachment(t);
      const originalEndpoint = "1".repeat(64);
      const replacementEndpoint = "2".repeat(64);
      const initialEndpoint =
        scenario === "engine does not supply endpoint IDs" ? "" : originalEndpoint;
      await f.updateEngine({ endpointId: initialEndpoint });
      f.acquireWithoutCleanup();
      const initial = await f.readRegistry();
      const { holders } = initial;
      const [pid] = Object.values<number>(holders);
      assert.ok(pid);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.deepEqual(await f.mutations(), [f.connect]);
      if (["bound legacy holder", "unbound legacy holder", "empty registry"].includes(scenario)) {
        await writeFile(
          f.registry,
          JSON.stringify({
            connectedByHarness: true,
            holders: scenario === "empty registry" ? {} : holders,
            ...(scenario === "unbound legacy holder" ? {} : { attachment: f.attachment }),
          }),
        );
      }
      await f.updateEngine({
        attached: true,
        endpointId: scenario === "missing endpoint" ? "" : initialEndpoint,
        ...(scenario === "replacement endpoint" ? { endpointId: replacementEndpoint } : {}),
        ...(scenario === "conflicting endpoint" ? { networkEndpointId: replacementEndpoint } : {}),
      });

      if (
        [
          "missing endpoint",
          "conflicting endpoint",
          "bound legacy holder",
          "unbound legacy holder",
          "engine does not supply endpoint IDs",
        ].includes(scenario)
      ) {
        await f.refused(
          new RegExp(
            `Cannot verify k3d attachment ownership.*${f.attachment.networkId}.*${f.attachment.containerId}.*Stop this lane`,
          ),
        );
        assert.deepEqual(initial.attachment, {
          ...f.attachment,
          ...(initialEndpoint ? { endpointId: initialEndpoint } : {}),
        });
        assert.deepEqual(await f.mutations(), [f.connect]);
        assert.equal(await f.isAttached(), true);
        return;
      }

      const owned = scenario === "same endpoint";
      assert.equal(await f.acquire(), "192.0.2.4");
      const record = await f.readRegistry();
      assert.equal(record.connectedByHarness, owned);
      assert.deepEqual(Object.values(record.holders), [process.pid]);
      if (owned) {
        assert.equal(record.attachment.endpointId, originalEndpoint);
      }
      await f.releases[0]!();
      await f.gone();
      assert.deepEqual(await f.mutations(), owned ? [f.connect, f.disconnect] : [f.connect]);
      assert.equal(await f.isAttached(), !owned);
      assert.equal(initial.attachment.endpointId, originalEndpoint);
    });
  }

  await t.test("a live holder cannot detach a replacement endpoint", async (t) => {
    const f = await recordingAttachment(t);
    const endpointId = "1".repeat(64);
    await f.updateEngine({ endpointId });
    await f.acquire();
    await f.updateEngine({ attached: true, endpointId: "2".repeat(64) });
    await f.refused(/Cannot verify k3d attachment ownership.*endpoint/);
    await f.releases[0]!();
    await f.pending("pendingRelease", false, endpointId);
    await f.refused(/Pending k3d disconnect.*still attached/);
    assert.equal(await f.isAttached(), true);
    assert.equal(f.consoleError.mock.callCount(), 1);
    assert.match(String(f.consoleError.mock.calls[0]?.arguments[0]), /endpoint identity changed/);
    assert.deepEqual(await f.mutations(), [f.connect]);
  });

  await t.test("replacement with live holders", async (t) => {
    const f = await recordingAttachment(t);
    await f.acquire();
    await f.updateEngine({ attached: true, replacement: true });
    await f.refused(/different or unverified engine binding/);
    assert.deepEqual(await f.mutations(), [f.connect]);
    await f.updateEngine({ attached: true });
    await f.releases[0]!();
    await f.gone();
    assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
  });

  await t.test("unreadable registry", async (t) => {
    const f = await recordingAttachment(t);
    await f.acquire();
    // Admission and an already issued cleanup both preserve unreadable bytes.
    await writeFile(f.registry, "{");
    await f.refused(/invalid attachment registry JSON/);
    await f.releases[0]!();
    assert.equal(await readFile(f.registry, "utf8"), "{");
    assert.equal(f.consoleError.mock.callCount(), 1);
    assert.deepEqual(await f.mutations(), [f.connect]);
  });

  for (const outcome of ["after", "before"] as const) {
    await t.test(`connect reports failure ${outcome} membership changes`, async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit: outcome });
      await assert.rejects(f.acquire, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, 7);
        assert.equal((error.cause as NodeJS.ErrnoException)?.code, 7);
        f.recovery(error.message);
        return true;
      });
      assert.equal(f.releases.length, 0);
      await f.pending("pendingConnect");
      if (outcome === "after") {
        await f.refused(/Pending k3d connect.*still attached/);
        assert.deepEqual(await f.mutations(), [f.connect]);
      } else {
        // Exact absence settles the old intent before a fresh attempt.
        await f.updateEngine({});
        await f.acquire();
        await f.releases[0]!();
        await f.gone();
        assert.deepEqual(await f.mutations(), [f.connect, f.connect, f.disconnect]);
      }
    });
  }

  const fullEndpoint = "1".repeat(64);
  for (const [label, input, diagnostic] of [
    [
      "missing network member",
      { peerListing: "omitted", endpointId: fullEndpoint },
      /listing omits the container/,
    ],
    [
      "malformed network member",
      { peerListing: "malformed", endpointId: fullEndpoint },
      /invalid network member entry/,
    ],
    [
      "malformed member map",
      { peerListing: "malformed-map", endpointId: fullEndpoint },
      /invalid network member listing/,
    ],
    [
      "container-only endpoint ID",
      { endpointId: fullEndpoint, networkEndpointId: "" },
      /endpoint identities disagree/,
    ],
    [
      "network-only endpoint ID",
      { networkEndpointId: fullEndpoint },
      /endpoint identities disagree/,
    ],
    [
      "omitted member map with a container endpoint ID",
      { legacy: "all", endpointId: fullEndpoint },
      /endpoint identities disagree/,
    ],
    [
      "different full endpoint IDs",
      { endpointId: fullEndpoint, networkEndpointId: "2".repeat(64) },
      /endpoint identities disagree/,
    ],
    [
      "malformed endpoint ID",
      { endpointId: fullEndpoint, networkEndpointId: "short" },
      /invalid attachment endpoint identity/,
    ],
  ] as const) {
    await t.test(`fences a successful connect with ${label}`, async (t) => {
      const f = await recordingAttachment(t);
      // The contradictory report appears only after the recorder's connect exits zero.
      await f.updateEngine(input);
      await assert.rejects(f.acquire, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Pending k3d connect.*Connect exited 0.*Endpoint readback/);
        assert.match(error.message, diagnostic);
        f.recovery(error.message);
        return true;
      });
      assert.equal(await f.isAttached(), true);
      await f.pending("pendingConnect");
      assert.deepEqual(await readFile(f.registry), await f.readConnectIntent());
      assert.equal(f.releases.length, 0);
      assert.deepEqual(await f.mutations(), [f.connect]);

      // Converging reports still cannot settle who owns a possibly replaced endpoint.
      await f.updateEngine({ attached: true, endpointId: "3".repeat(64) });
      await f.refused(/Pending k3d connect.*still attached/);
      assert.equal(f.releases.length, 0);

      // Confirmed absence permits a new connection and gives only that holder cleanup rights.
      await f.updateEngine({ endpointId: fullEndpoint });
      assert.equal(await f.acquire(), "192.0.2.4");
      assert.equal(f.releases.length, 1);
      await f.releases[0]!();
      await f.gone();
      assert.equal(await f.isAttached(), false);
      assert.deepEqual(await f.mutations(), [f.connect, f.connect, f.disconnect]);
    });
  }

  const membershipCases = [
    ["malformed membership value", { unexpected: "unavailable" }],
    ["original ID under a conflicting name", { unexpected: { NetworkID: "b".repeat(64) } }],
    [
      "unrelated ID under multiple names",
      { first: { NetworkID: "e".repeat(64) }, second: { NetworkID: "e".repeat(64) } },
    ],
    ["name-only endpoint", { "k3d-fixture": {} }],
    ["symbolic endpoint cannot be resolved", { unexpected: { NetworkID: "unexpected" } }],
  ] as const;

  for (const [name, observation] of membershipCases) {
    await t.test(`fresh acquire refuses ${name}`, async (t) => {
      const f = await recordingAttachment(t);
      await f.observeNext(observation);
      await assert.rejects(
        f.acquire,
        name === "symbolic endpoint cannot be resolved"
          ? { code: 8 }
          : /container network membership/,
      );
      await f.expectNoAdmission();
    });
  }

  await t.test("pending connect survives malformed membership", async (t) => {
    const f = await recordingAttachment(t);
    await f.updateEngine({ connectExit: "after" });
    await assert.rejects(f.acquire, { code: 7 });
    await f.pending("pendingConnect");

    await f.observeNext({ unexpected: "unavailable" });
    await f.refused(/Pending k3d connect.*Exact membership inspection failed/);
    await f.refused(/Pending k3d connect.*still attached/);
    assert.equal(f.releases.length, 0);
    assert.deepEqual(await f.mutations(), [f.connect]);
  });

  await t.test(
    "release keeps intent and does not disconnect on name-only endpoint evidence",
    async (t) => {
      const f = await recordingAttachment(t);
      await f.acquire();
      await f.observeNext({ "k3d-fixture": {} });
      await f.releases[0]!();
      await f.pending("pendingRelease");
      assert.deepEqual(await f.mutations(), [f.connect]);
      f.recovery(String(f.consoleError.mock.calls[0]?.arguments[0]));
      await f.refused(/Pending k3d disconnect.*still attached/);
    },
  );

  for (const [name, observation] of [
    ["empty map", {}],
    ["unrelated valid endpoint", { unrelated: { NetworkID: "e".repeat(64) } }],
  ] as const) {
    await t.test(`pending connect settles on ${name}`, async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit: "before" });
      await assert.rejects(f.acquire, { code: 7 });
      await f.pending("pendingConnect");
      await f.updateEngine({});
      await f.observeNext(observation);
      assert.equal(await f.acquire(), "192.0.2.4");
      assert.equal(f.releases.length, 1);
      assert.equal((await f.readRegistry()).pendingConnect, undefined);
      await f.releases[0]!();
      await f.gone();
      assert.deepEqual(await f.mutations(), [f.connect, f.connect, f.disconnect]);
    });
  }

  for (const serverWithoutNetworkId of ["bound", "unbound", "podman", "empty-id"] as const) {
    await t.test(
      `name-only server discovery with ${serverWithoutNetworkId} network readback`,
      async (t) => {
        const f = await recordingAttachment(t);
        await f.updateEngine({ serverWithoutNetworkId });
        if (serverWithoutNetworkId === "unbound") {
          await assert.rejects(f.acquire, /server membership could not be verified by full ID/);
          await f.expectNoAdmission();
          return;
        }
        assert.equal(await f.acquire(), "192.0.2.4");
        assert.deepEqual((await f.readRegistry()).attachment, f.attachment);
        assert.equal(f.releases.length, 1);
        await f.releases[0]!();
        await f.gone();
        assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
      },
    );
  }

  // Podman 4.9.5 reports names for all running named networks and omits the
  // members field. Mixed cases also exercise each symbolic entry on its own.
  for (const [label, input, fixture] of [
    ["all", { legacy: "all" }, "postgres"],
    ["target", { legacy: "target" }, "postgres"],
    ["unrelated", { legacy: "unrelated" }, "postgres"],
    ["ID-shaped unrelated name", { legacy: "hex-unrelated" }, "postgres"],
    ["network-side", { legacy: "all", memberListing: "present", filter: "fails" }, "keycloak"],
  ] as const) {
    await t.test(
      `accepts corroborated legacy ${label} membership without taking ownership`,
      async (t) => {
        const f = await recordingAttachment(t, fixture);
        await f.updateEngine({ attached: true, ...input });
        assert.equal(await f.acquire(), "192.0.2.4");
        const registry = await f.readRegistry();
        assert.deepEqual(registry.attachment, f.attachment);
        assert.equal(registry.connectedByHarness, false);
        assert.deepEqual(Object.values(registry.holders), [process.pid]);
        assert.equal(f.releases.length, 1);
        await f.releases[0]!();
        await f.gone();
        assert.deepEqual(await f.mutations(), []);
      },
    );
  }

  await t.test(
    "reconciles an absent target from a corroborated unrelated legacy endpoint",
    async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit: "before" });
      await assert.rejects(f.acquire, { code: 7 });
      await f.pending("pendingConnect");
      await f.updateEngine({ legacy: "all" });
      await f.acquire();
      assert.equal(f.releases.length, 1);
      assert.equal((await f.readRegistry()).connectedByHarness, true);
      assert.deepEqual(await f.mutations(), [f.connect, f.connect]);
      await f.releases[0]!();
      await f.gone();
      assert.deepEqual(await f.mutations(), [f.connect, f.connect, f.disconnect]);
    },
  );

  for (const [name, engine, expected, legacy = "unrelated"] of [
    ["empty filter", { filter: "empty" }, /could not be verified by full ID/],
    ["truncated filter ID", { filter: "short" }, /could not be verified by full ID/],
    ["other container in filter", { filter: "wrong" }, /could not be verified by full ID/],
    ["failed filter", { filter: "fails" }, /Command failed: .*ps --filter network=/],
    ["empty explicit listing", { memberListing: "empty" }, /could not be verified by full ID/],
    ["name lookup resolves another name", { nameLookup: "wrong-name" }, /name changed/],
    ["unrelated name resolves target ID", { nameLookup: "wrong-id" }, /name and ID disagree/],
    ["unrelated ID resolves another name", { fullIdLookup: "wrong-name" }, /name changed/],
    ["unrelated ID resolves replacement", { fullIdLookup: "wrong-id" }, /ID changed/],
    [
      "symbolic name cannot resolve a distinct ID",
      { ambiguousHexName: true },
      /ambiguous endpoint identity/,
      "hex-unrelated",
    ],
    [
      "unrelated lookup unavailable",
      { fullIdLookup: "unavailable" },
      /Command failed: .*network inspect/,
    ],
  ] as const) {
    await t.test(`fresh acquire refuses ${name}`, async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ legacy, ...engine });
      await assert.rejects(f.acquire, expected);
      await f.expectNoAdmission();
    });

    if (name !== "empty filter" && name !== "unrelated ID resolves replacement") {
      continue;
    }
    await t.test(`pending readback refuses ${name}`, async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit: "before" });
      await assert.rejects(f.acquire, { code: 7 });
      await f.pending("pendingConnect");
      await f.updateEngine({ legacy, ...engine });
      await f.refused(/Pending k3d connect.*Exact membership inspection failed/);
      assert.equal(f.releases.length, 0);
      assert.deepEqual(await f.mutations(), [f.connect]);
    });
  }

  await t.test(
    "keeps pending bytes when fixture validation fails after exact absence",
    async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit: "before" });
      await assert.rejects(f.acquire, { code: 7 });
      await f.pending("pendingConnect");
      await f.updateEngine({ legacy: "all", filter: "empty" });
      await f.observeNext({});
      await f.refused(/k3d server membership could not be verified by full ID/);
      assert.equal(f.releases.length, 0);
      assert.deepEqual(await f.mutations(), [f.connect]);
    },
  );

  await t.test(
    "keeps the pending record if the original pair reappears before admission",
    async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit: "after" });
      await assert.rejects(f.acquire, { code: 7 });
      await f.pending("pendingConnect");
      await f.updateEngine({ legacy: "all", attached: true });
      await f.observeNext({});
      await f.refused(/Pending k3d connect.*Acquisition membership reports disagree/);
      assert.equal(f.releases.length, 0);
      assert.deepEqual(await f.mutations(), [f.connect]);
    },
  );

  for (const originalReappears of [true, false]) {
    await t.test(
      originalReappears
        ? "keeps pending intent when replacement inventory reports the original pair"
        : "keeps pending intent when original inventory reports the replacement pair",
      async (t) => {
        const f = await recordingAttachment(t);
        await f.updateEngine({ connectExit: "before" });
        await assert.rejects(f.acquire, { code: 7 });
        await f.pending("pendingConnect");

        const replacementId = "c".repeat(64);
        await f.updateEngine({ replacement: true, keepOriginalNetwork: true });
        // The same peer's two inventories disagree about one pair. The
        // selected network and the still-inspectable old one have distinct IDs.
        if (originalReappears) {
          await f.observeNext({}, { "k3d-fixture": { NetworkID: f.attachment.networkId } });
        } else {
          await f.observeNext({ "k3d-fixture-v2": { NetworkID: replacementId } }, {});
        }
        const conflictingId = originalReappears ? f.attachment.networkId : replacementId;
        await f.refused(
          new RegExp(
            `Pending k3d connect.*container ${f.attachment.containerId} reported membership on network ${conflictingId}`,
          ),
        );
      },
    );
  }

  await t.test("refuses a symbolic target when only the server is a network member", async (t) => {
    const f = await recordingAttachment(t);
    await f.observeNext({ "k3d-fixture": { NetworkID: "k3d-fixture" } });
    await f.updateEngine({ legacy: "all" });
    await assert.rejects(
      f.acquire,
      /container network membership could not be verified by full ID/,
    );
    await f.expectNoAdmission();
  });

  await t.test(
    "keeps a pending release when legacy readback fails after a failed disconnect",
    async (t) => {
      const f = await recordingAttachment(t);
      await f.acquire();
      await f.updateEngine({
        attached: true,
        legacy: "all",
        disconnectExit: true,
        filter: "disconnect-fails",
      });
      await f.releases[0]!();
      await f.pending("pendingRelease");
      assert.equal(f.consoleError.mock.callCount(), 1);
      const message = String(f.consoleError.mock.calls[0]?.arguments[0]);
      assert.match(message, /Disconnect reported 7.*Exact membership inspection failed \(8\)/);
      f.recovery(message);
      await f.releases[0]!();
      await f.refused(/Pending k3d disconnect.*Exact membership inspection failed/);
      assert.equal(f.releases.length, 1);
      assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
    },
  );

  for (const connectExit of ["after", undefined] as const) {
    await t.test(connectExit ? "connect and unlock both fail" : "only unlock fails", async (t) => {
      const f = await recordingAttachment(t);
      await f.updateEngine({ connectExit });
      const injected = f.failUnlock();
      await assert.rejects(f.acquire, (error: unknown) => {
        assert.ok(error instanceof Error);
        let unlockError = error;
        if (connectExit) {
          assert.ok(error instanceof AggregateError);
          assert.equal((error as NodeJS.ErrnoException).code, 7);
          const [primary, unlock] = error.errors;
          assert.equal(error.cause, primary);
          assert.equal(primary.code, 7);
          assert.equal(primary.cause?.code, 7);
          assert.match(error.message, /Connect reported 7/);
          f.recovery(error.message);
          unlockError = unlock;
        }
        assert.equal((unlockError as NodeJS.ErrnoException).code, "EROFS");
        assert.equal(unlockError.cause, injected);
        assert.match(error.message, /Could not remove attachment lock.*EROFS/);
        assert.ok(error.message.includes(f.lock));
        assert.ok(error.message.includes(f.registry));
        assert.match(
          error.message,
          /Confirm the lock holder cannot resume before clearing the lock/,
        );
        assert.match(error.message, /before retrying any attachment operation/);
        return true;
      });
      if (connectExit) {
        await f.pending("pendingConnect");
      } else {
        assert.deepEqual(Object.values((await f.readRegistry()).holders), [process.pid]);
      }
      assert.equal(await readFile(f.lock, "utf8"), String(process.pid));
      assert.equal(f.releases.length, 0);
      assert.deepEqual(await f.mutations(), [f.connect]);
    });
  }

  for (const [name, write, rollbackBlocked] of [
    ["before connect", 1, false],
    ["after connect", 2, false],
    ["and unresolved rollback", 2, true],
  ] as const) {
    await t.test(`registry write failure ${name}`, async (t) => {
      const f = await recordingAttachment(t);
      f.failRegistryWrite(write);
      await f.updateEngine({ keepOnDisconnect: rollbackBlocked });
      await assert.rejects(f.acquire, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, "EIO");
        if (rollbackBlocked) {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0]?.code, "EIO");
          assert.equal(error.errors[1], error.cause);
          f.recovery(error.message);
        }
        return true;
      });
      assert.equal(f.releases.length, 0);
      if (rollbackBlocked) {
        await f.pending("pendingRelease", true);
        await f.refused(/Pending k3d disconnect to roll back a successful connect.*still attached/);
      } else {
        await f.gone();
      }
      assert.deepEqual(await f.mutations(), write === 1 ? [] : [f.connect, f.disconnect]);
    });
  }

  await t.test("rollback preserves the disconnect and legacy observation errors", async (t) => {
    const f = await recordingAttachment(t);
    f.failRegistryWrite(2);
    await f.updateEngine({ legacy: "all", disconnectExit: true, filter: "disconnect-fails" });
    await assert.rejects(f.acquire, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal((error as NodeJS.ErrnoException).code, "EIO");
      assert.equal(error.errors[0]?.code, "EIO");
      const reconciliation = error.errors[1];
      assert.equal(error.cause, reconciliation);
      assert.equal(reconciliation.code, 7);
      assert.ok(reconciliation.cause instanceof AggregateError);
      const [disconnect, observation] = reconciliation.cause.errors;
      assert.equal(reconciliation.cause.cause, disconnect);
      assert.equal(disconnect.code, 7);
      assert.equal(observation.code, 8);
      f.recovery(error.message);
      return true;
    });
    assert.equal(f.releases.length, 0);
    await f.pending("pendingRelease", true);
    await f.refused(/Pending k3d disconnect.*Exact membership inspection failed/);
    assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
  });

  await t.test("registry write failure before the rollback can be recorded", async (t) => {
    const f = await recordingAttachment(t);
    f.failRegistryWrite(2, 3);
    await assert.rejects(f.acquire, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure.code),
        ["EIO", "EIO"],
      );
      assert.equal(error.cause, error.errors[1]);
      assert.match(
        error.message,
        /Connect exited 0.*Holder write failed.*Rollback record write failed.*Disconnect was not attempted/,
      );
      f.recovery(error.message);
      return true;
    });
    assert.equal(f.releases.length, 0);
    await f.pending("pendingConnect");
    await f.refused(/Pending k3d connect.*still attached/);
    assert.deepEqual(await f.mutations(), [f.connect]);
  });

  await t.test("registry write failure before release", async (t) => {
    const f = await recordingAttachment(t);
    await f.acquire();
    f.failRegistryWrite(1);
    const bytes = await readFile(f.registry);
    await f.releases[0]!();
    assert.deepEqual(await readFile(f.registry), bytes);
    assert.deepEqual(await f.mutations(), [f.connect]);
    assert.equal(f.consoleError.mock.callCount(), 1);
    // The first attempt stopped before the engine call. The holder can still release.
    await f.releases[0]!();
    await f.gone();
    assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
  });

  await t.test("disconnect fails after removing membership", async (t) => {
    const f = await recordingAttachment(t);
    await f.acquire();
    await f.updateEngine({ attached: true, disconnectExit: true });
    await f.releases[0]!();
    await f.gone();
    assert.equal(f.consoleError.mock.callCount(), 0);
    assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
  });

  await t.test("disconnect succeeds but membership remains", async (t) => {
    const f = await recordingAttachment(t);
    await f.acquire();
    await f.updateEngine({ attached: true, keepOnDisconnect: true });
    await f.releases[0]!();
    await f.pending("pendingRelease");
    assert.equal(f.consoleError.mock.callCount(), 1);
    f.recovery(String(f.consoleError.mock.calls[0]?.arguments[0]));
    await f.releases[0]!();
    await f.refused(/Pending k3d disconnect.*still attached/);
    assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
  });

  for (const [label, peerListing] of [
    ["initial network report", "name-only"],
    ["full-ID network report", "id-only"],
    ["full-ID network report during server verification", "first-id-only"],
    ["malformed exact member entry", "malformed"],
  ] as const) {
    await t.test(`refuses fresh acquisition on ${label}`, async (t) => {
      const f = await recordingAttachment(t, "keycloak");
      await f.updateEngine({
        attached: true,
        peerListing,
        // Only the server's corroborating read lists the peer in this case.
        ...(peerListing === "first-id-only" ? { serverWithoutNetworkId: "bound" } : {}),
      });
      await f.observeNext({});
      const diagnostic =
        peerListing === "malformed" ? "invalid member entry" : "own network inventory omits";
      await assert.rejects(f.acquire, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(diagnostic));
        assert.ok(error.message.includes(f.attachment.networkId));
        assert.ok(error.message.includes(f.attachment.containerId));
        return true;
      });
      await f.expectNoAdmission();
    });
  }

  await t.test(
    "fences release and later acquisition while membership reports disagree",
    async (t) => {
      const f = await recordingAttachment(t);
      await f.acquire();
      await f.observeNext({ unrelated: { NetworkID: "e".repeat(64) } });
      await f.releases[0]!();

      await f.pending("pendingRelease");
      const bytes = await readFile(f.registry);
      assert.equal(f.consoleError.mock.callCount(), 1);
      const message = String(f.consoleError.mock.calls[0]?.arguments[0]);
      assert.match(message, /Disconnect preflight.*own network inventory omits/);
      f.recovery(message);

      await f.releases[0]!();
      await f.observeNext({});
      await f.refused(/Pending k3d disconnect.*Acquisition readback.*own network inventory omits/);
      assert.deepEqual(await readFile(f.registry), bytes);
      assert.equal(f.consoleError.mock.callCount(), 1);
      assert.equal(f.releases.length, 1);
      assert.deepEqual(await f.mutations(), [f.connect]);

      await f.updateEngine({ attached: false });
      assert.equal(await f.acquire(), "192.0.2.4");
      assert.equal((await f.readRegistry()).connectedByHarness, true);
      await f.releases[1]!();
      await f.gone();
      assert.deepEqual(await f.mutations(), [f.connect, f.connect, f.disconnect]);
    },
  );

  await t.test(
    "fences rollback when the network still lists the peer after disconnect",
    async (t) => {
      const f = await recordingAttachment(t);
      f.failRegistryWrite(2);
      await f.updateEngine({ peerListing: "after-disconnect" });
      await assert.rejects(f.acquire, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0]?.code, "EIO");
        assert.match(error.message, /Connect rollback exited 0.*own network inventory omits/);
        f.recovery(error.message);
        return true;
      });
      await f.pending("pendingRelease", true);
      await f.refused(/Pending k3d disconnect to roll back.*own network inventory omits/);
      assert.equal(f.releases.length, 0);
      assert.deepEqual(await f.mutations(), [f.connect, f.disconnect]);
    },
  );

  await t.test("unverified release and replacement", async (t) => {
    const f = await recordingAttachment(t);
    await f.acquire();
    await f.updateEngine({ attached: true, unavailable: true });
    await f.releases[0]!();
    await f.pending("pendingRelease");
    assert.equal(f.consoleError.mock.callCount(), 1);
    f.recovery(String(f.consoleError.mock.calls[0]?.arguments[0]));
    await f.releases[0]!();
    await f.updateEngine({ replacement: true });
    await f.refused(/Pending k3d disconnect.*Exact membership inspection failed/);
    assert.deepEqual(await f.mutations(), [f.connect]);

    // Once the original identities can be inspected and show absence, the
    // pending marker can retire, and the next acquisition starts independently.
    await f.updateEngine({});
    await f.acquire();
    await f.releases[1]!();
    await f.gone();
    assert.deepEqual(await f.mutations(), [f.connect, f.connect, f.disconnect]);
  });
});

test("retains an owned PID-only record when the selected container changes", async (t) => {
  const f = await recordingAttachment(t);
  f.acquireWithoutCleanup();
  const { holders } = await f.readRegistry();
  const [pid] = Object.values<number>(holders);
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await f.mutations(), [f.connect]);
  // The old writer recorded only the ownership flag and holder PIDs.
  await writeFile(f.registry, JSON.stringify({ connectedByHarness: true, holders }));

  // Both containers still exist. The lane now selects the unattached replacement.
  await f.updateEngine({ replaceContainer: true, originalContainerAttached: true });
  const original = { "k3d-fixture": { NetworkID: f.attachment.networkId } };
  assert.deepEqual(f.inspectNetworks(f.attachment.containerId), original);
  assert.deepEqual(f.inspectNetworks(f.replacementContainerId), {});
  await f.refused((error: unknown) => {
    assert.ok(error instanceof Error);
    for (const expected of [f.registry, f.lock, f.attachment.networkId, f.replacementContainerId]) {
      assert.ok(error.message.includes(expected), error.message);
    }
    assert.match(
      error.message,
      /record has no network or container ID for the original attachment/,
    );
    assert.match(error.message, /currently selected network.*do not identify the original pair/);
    assert.match(error.message, /Stop this lane's participants.*fence/);
    assert.match(error.message, /recover the original pair from lane logs or engine records/);
    assert.match(
      error.message,
      /Retire the unchanged record only after confirming the original attachment is gone/,
    );
    assert.match(error.message, /Keep the record if ownership remains unclear/);
    return true;
  });
  assert.deepEqual(f.inspectNetworks(f.attachment.containerId), original);
  assert.deepEqual(f.inspectNetworks(f.replacementContainerId), {});
});

test("keeps the pending record when an earlier report lists the replacement", async (t) => {
  const f = await recordingAttachment(t);
  await f.updateEngine({ connectExit: "before" });
  await assert.rejects(f.acquire, { code: 7 });
  await f.pending("pendingConnect");

  // The old container is detached. Its first network inspection lists the
  // replacement, and all subsequent reports omit that member.
  await f.updateEngine({ replaceContainer: true, attached: true, peerListing: "first-id-only" });
  await f.observeNext({});
  await f.refused(
    new RegExp(
      `network ${f.attachment.networkId} lists container ${f.replacementContainerId} but its own network inventory omits`,
    ),
  );
  assert.equal(await f.isAttached(), true);

  // A new acquisition can settle the genuinely absent old pair once the
  // replacement's container inventory also confirms its own membership.
  await f.updateEngine({ replaceContainer: true, attached: true });
  assert.equal(await f.acquire(), "192.0.2.4");
  const registry = await f.readRegistry();
  assert.deepEqual(registry.attachment, { ...f.attachment, containerId: f.replacementContainerId });
  assert.equal(registry.pendingConnect, undefined);
  assert.equal(registry.connectedByHarness, false);
  assert.equal(f.releases.length, 1);
  await f.releases[0]!();
  await f.gone();
  assert.equal(await f.isAttached(), true);
  assert.deepEqual(await f.mutations(), [f.connect]);
});

test("admits an absent replacement after observing unrelated members and networks", async (t) => {
  const f = await recordingAttachment(t);
  await f.updateEngine({ connectExit: "before" });
  await assert.rejects(f.acquire, { code: 7 });
  await f.pending("pendingConnect");

  // Before replacement admission the bound network lists the server, and
  // the corroborating Compose network lists both old and new containers.
  await f.updateEngine({ replaceContainer: true, legacy: "unrelated", memberListing: "present" });
  assert.equal(await f.acquire(), "192.0.2.4");
  const registry = await f.readRegistry();
  assert.deepEqual(registry.attachment, { ...f.attachment, containerId: f.replacementContainerId });
  assert.equal(registry.pendingConnect, undefined);
  assert.equal(registry.connectedByHarness, true);
  assert.equal(f.releases.length, 1);
  await f.releases[0]!();
  await f.gone();
  assert.equal(await f.isAttached(), false);
  assert.deepEqual(await f.mutations(), [
    f.connect,
    [...f.connect.slice(0, -1), f.replacementContainerId],
    [...f.disconnect.slice(0, -1), f.replacementContainerId],
  ]);
});
