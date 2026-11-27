import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { link, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { readDefaultCollectorImage } from "../../scripts/ci/logging.ts";
import {
  cleanupLogging,
  execute,
  prepareLogging,
  selectedCollectorSmoke,
  type LoggingResource,
} from "../helpers/ci-logging.ts";

type Executor = NonNullable<NonNullable<Parameters<typeof prepareLogging>[0]>["execFile"]>;
type Journal = LoggingResource & { id: string; kind: string };
const fullId = /^[a-f0-9]{64}$/;
const selected = { skip: !selectedCollectorSmoke, timeout: 90_000 };
const sentinelLabel = "org.openclaw.enterprise.ci.sentinel-attempt";
type SentinelIntent = {
  phase: "create-intent" | "created";
  endpoint: string;
  engineId: string;
  name: string;
  image: string;
  nonce: string;
  receiptPath: string;
  cidPath: string;
  containerId?: string;
};
type ProductRemoval = {
  phase: "remove-intent" | "response-received";
  rawTarget: string;
  containerId: string;
  statusCode?: number;
};

function id(text: string) {
  const value = text.trim();
  assert.match(value, fullId);
  return value;
}

async function writeFixtureReceipt(path: string, value: unknown, initial = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (initial) {
      await link(temporary, path);
    } else {
      await rename(temporary, path);
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function realFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ci-otel-custody-"));
  let server: ReturnType<typeof createServer> | undefined;
  let cleanupContainers = async () => {};
  // Enroll before Docker discovery, relay startup, or any later setup await.
  t.after(async () => {
    let failure: unknown;
    try {
      await cleanupContainers();
    } catch (error) {
      failure = error;
    }
    if (server) {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    if (failure) {
      throw failure;
    }
    await rm(root, { recursive: true, force: true });
  });
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const context =
    process.env.DOCKER_CONTEXT ?? (await execute(docker, ["context", "show"])).stdout.trim();
  const endpoint =
    !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
      ? process.env.DOCKER_HOST
      : (JSON.parse(
          (
            await execute(docker, [
              "context",
              "inspect",
              context,
              "--format",
              "{{json .Endpoints.docker.Host}}",
            ])
          ).stdout,
        ) as string);
  // The response gate forwards an actual local Docker API connection. It does
  // not emulate a daemon or weaken TLS for a remote engine.
  assert.ok(
    endpoint.startsWith("unix://"),
    "custody fault cases require a local Unix Docker endpoint",
  );
  const direct = (args: string[]) => execute(docker, ["--host", endpoint, ...args]);
  const engineId = (await direct(["info", "--format", "{{.ID}}"])).stdout.trim();
  assert.ok(engineId, "Docker must report its engine identity");
  const collector =
    process.env.OCC_TEST_LOGGING_COLLECTOR_IMAGE ?? (await readDefaultCollectorImage());
  const sentinel = process.env.OCC_TEST_LOGGING_NODE_IMAGE;
  assert.ok(sentinel, "logging-collector lane must supply its pinned Node image");
  for (const image of [collector, sentinel]) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/);
    const digests: unknown = JSON.parse(
      (await direct(["image", "inspect", "--format", "{{json .RepoDigests}}", image])).stdout,
    );
    assert.ok(
      Array.isArray(digests) &&
        digests.some(
          (entry: unknown) =>
            typeof entry === "string" && entry.endsWith(image.slice(image.lastIndexOf("@"))),
        ),
      "lane preparation must preload the exact image",
    );
  }
  const owned = new Set<string>();
  const sentinelIntents = new Map<string, SentinelIntent>();
  const deletes: string[] = [];
  const productRemovals = new Map<string, ProductRemoval>();
  const productRemovalTargets = new Set<string>();
  let createForwards = 0;
  let unresolvedCreate = false;
  let unresolvedRemovalTarget = false;
  let gate:
    | { operation: "create" | "remove"; afterCommit: (objectId: string) => Promise<void> }
    | undefined;
  const socket = join(root, "docker.sock");
  server = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://docker");
      const pathname = url.pathname.replace(/^\/v[0-9.]+/, "");
      const create = incoming.method === "POST" && pathname === "/containers/create";
      let removal: ProductRemoval | undefined;
      let upstreamPath = incoming.url;
      if (incoming.method === "DELETE") {
        const rawTarget = /^\/containers\/([^/]+)$/.exec(pathname)?.[1];
        deletes.push(rawTarget ?? pathname);
        try {
          assert.equal(unresolvedRemovalTarget, false, "retain the unresolved DELETE target");
          assert.ok(rawTarget, "only container DELETEs are admitted");
          const target = decodeURIComponent(rawTarget);
          assert.equal(productRemovalTargets.has(target), false, "do not replay a DELETE target");
          productRemovalTargets.add(target);
          const objectId = fullId.test(target)
            ? target
            : id((await direct(["container", "inspect", "--format", "{{.Id}}", target])).stdout);
          assert.ok(owned.has(objectId), "DELETE must resolve to a fixture-owned exact ID");
          assert.equal(productRemovals.has(objectId), false, "do not replay a product removal");
          removal = { phase: "remove-intent", rawTarget, containerId: objectId };
          productRemovals.set(objectId, removal);
          await writeFixtureReceipt(
            join(root, `product-remove-${objectId}.json`),
            { ...removal, endpoint, engineId },
            true,
          );
          // Preserve the product's request target above, but bind this fixture's
          // forwarded destructive request to the resolved object, never its name.
          upstreamPath = `${url.pathname.slice(0, -rawTarget.length)}${objectId}${url.search}`;
        } catch (error) {
          unresolvedRemovalTarget = true;
          await writeFixtureReceipt(
            join(root, `unresolved-delete-${randomUUID()}.json`),
            { phase: "unresolved-target", rawTarget: rawTarget ?? pathname, endpoint, engineId },
            true,
          );
          throw error;
        }
      }
      if (create) {
        createForwards += 1;
        unresolvedCreate = true;
      }
      const upstream = request(
        {
          socketPath: endpoint.slice("unix://".length),
          path: upstreamPath,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            void (async () => {
              const body = Buffer.concat(chunks);
              let created: string | undefined;
              if (create && response.statusCode === 201) {
                const payload: unknown = JSON.parse(body.toString());
                assert.ok(
                  payload &&
                    typeof payload === "object" &&
                    "Id" in payload &&
                    typeof payload.Id === "string",
                );
                created = id(payload.Id);
                owned.add(created);
              }
              if (create) unresolvedCreate = false;
              if (removal && response.statusCode !== undefined) {
                const completed: ProductRemoval = {
                  ...removal,
                  phase: "response-received",
                  statusCode: response.statusCode,
                };
                await writeFixtureReceipt(
                  join(root, `product-remove-${removal.containerId}.json`),
                  {
                    ...completed,
                    endpoint,
                    engineId,
                  },
                );
                productRemovals.set(removal.containerId, completed);
              }
              const objectId = create ? created : removal?.containerId;
              if (
                gate &&
                objectId &&
                gate.operation === (create ? "create" : "remove") &&
                (response.statusCode ?? 500) >= 200 &&
                (response.statusCode ?? 500) < 300
              ) {
                const selectedGate = gate;
                gate = undefined;
                await selectedGate.afterCommit(objectId);
                outgoing.destroy();
                return;
              }
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              outgoing.end(body);
            })().catch(() => outgoing.destroy());
          });
          response.on("error", () => outgoing.destroy());
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    })().catch(() => outgoing.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socket, resolve);
  });
  const relay = `unix://${socket}`;
  assert.equal(
    (await execute(docker, ["--host", relay, "info", "--format", "{{.ID}}"])).stdout.trim(),
    engineId,
  );
  const routedExecute: Executor = (command, args, options) =>
    execute(
      command,
      command === docker && args[0] !== "--host" && args[0] !== "--context"
        ? ["--host", relay, ...args]
        : args,
      options,
    );
  const env = {
    ...process.env,
    DOCKER_CONTEXT: "",
    DOCKER_HOST: relay,
    OCC_DOCKER_BIN: docker,
    OCC_TEST_LOGGING_COLLECTOR_IMAGE: collector,
    OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
    OCC_CI_OTEL_BACKEND_HOST: "127.0.0.1",
  };
  const present = async (objectId: string) => {
    assert.match(objectId, fullId);
    const value = (
      await direct([
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `id=${objectId}`,
      ])
    ).stdout.trim();
    assert.ok(value === "" || value === objectId);
    return value === objectId;
  };
  const captureSentinel = async (intent: SentinelIntent) => {
    const received = await readFile(intent.cidPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (received === undefined) {
      return undefined;
    }
    const objectId = id(received);
    const identity: unknown = JSON.parse(
      (
        await direct([
          "container",
          "inspect",
          "--format",
          `[{{json .Id}},{{json .Config.Image}},{{json (index .Config.Labels ${JSON.stringify(sentinelLabel)})}}]`,
          objectId,
        ])
      ).stdout,
    );
    assert.deepEqual(identity, [objectId, intent.image, intent.nonce]);
    const completed: SentinelIntent = { ...intent, phase: "created", containerId: objectId };
    await writeFixtureReceipt(intent.receiptPath, completed);
    sentinelIntents.set(intent.name, completed);
    owned.add(objectId);
    return objectId;
  };
  cleanupContainers = async () => {
    assert.equal((await direct(["info", "--format", "{{.ID}}"])).stdout.trim(), engineId);
    assert.equal(
      unresolvedRemovalTarget,
      false,
      `retain fixture after an unresolved DELETE: ${root}`,
    );
    for (const intent of sentinelIntents.values()) {
      if (!intent.containerId) {
        await captureSentinel(intent);
      }
    }
    for (const objectId of owned) {
      const receiptPath = join(root, `remove-${objectId}.json`);
      if (await present(objectId)) {
        // A live object after a product DELETE may have an unknown outcome.
        // Fixture teardown must not replay that destructive operation.
        assert.equal(productRemovals.has(objectId), false, "retain unresolved product removal");
        await writeFixtureReceipt(
          receiptPath,
          { phase: "remove-intent", endpoint, engineId, containerId: objectId },
          true,
        );
        try {
          await direct(["rm", "--force", objectId]);
        } catch (error) {
          if (await present(objectId)) {
            throw error;
          }
        }
        assert.equal(await present(objectId), false, "retain unresolved fixture removal");
        await writeFixtureReceipt(receiptPath, {
          phase: "removed",
          endpoint,
          engineId,
          containerId: objectId,
        });
      }
    }
    assert.equal(unresolvedCreate, false, `retain fixture after an unknown create: ${root}`);
    assert.ok(
      [...sentinelIntents.values()].every((intent) => intent.containerId),
      `retain fixture after an unknown sentinel create: ${root}`,
    );
  };
  const sentinelAt = async (name: string, { loseResult = false } = {}) => {
    assert.equal(sentinelIntents.has(name), false, "do not replay a sentinel create");
    const nonce = randomUUID();
    const intent: SentinelIntent = {
      phase: "create-intent",
      endpoint,
      engineId,
      name,
      image: sentinel,
      nonce,
      receiptPath: join(root, `sentinel-${nonce}.json`),
      cidPath: join(root, `sentinel-${nonce}.cid`),
    };
    await assert.rejects(stat(intent.cidPath), { code: "ENOENT" });
    await writeFixtureReceipt(intent.receiptPath, intent, true);
    sentinelIntents.set(name, intent);
    assert.equal((await direct(["info", "--format", "{{.ID}}"])).stdout.trim(), engineId);
    try {
      const created = await direct([
        "create",
        "--name",
        name,
        "--cidfile",
        intent.cidPath,
        "--label",
        "org.openclaw.enterprise.ci.resource=otel-backend",
        "--label",
        `${sentinelLabel}=${nonce}`,
        "--entrypoint",
        "node",
        sentinel,
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      if (loseResult) {
        throw new Error("lost direct sentinel create result");
      }
      const objectId = await captureSentinel(intent);
      assert.equal(objectId, id(created.stdout));
      assert.ok(objectId);
      return objectId;
    } catch (error) {
      // A rejected command may already have committed. The cidfile is the
      // daemon-issued receipt; an absent file is not evidence of absence.
      if (!sentinelIntents.get(name)?.containerId) {
        await captureSentinel(intent);
      }
      throw error;
    }
  };
  const renamed = async (objectId: string) => {
    assert.match(objectId, fullId);
    await direct(["rename", objectId, `ci-otel-spare-${randomUUID()}`]);
  };
  const sibling = join(root, "sibling-marker");
  await writeFile(sibling, "unrelated directory survives\n", { mode: 0o600 });
  let resource: Journal | undefined;
  const prepare = async ({
    beforeCreate,
    execFile = routedExecute,
  }: { beforeCreate?: (entry: Journal) => Promise<void>; execFile?: Executor } = {}) => {
    return prepareLogging({
      directory: root,
      env,
      execFile,
      waitForReady: false,
      registerResource: async (kind, details) => {
        const entry = { id: randomUUID(), kind, ...details };
        resource = entry;
        await writeFile(join(root, "planned.json"), `${JSON.stringify(entry)}\n`, {
          mode: 0o600,
          flush: true,
        });
        await beforeCreate?.(entry);
        return entry;
      },
    });
  };
  const cleanup = (execFile: Executor = routedExecute) =>
    cleanupLogging(resource, { env, execFile });
  const containerAt = async (name: string) => {
    const objectId = id(
      (await direct(["container", "inspect", "--format", "{{.Id}}", name])).stdout,
    );
    return objectId;
  };
  return {
    root,
    prepare,
    cleanup,
    execute: routedExecute,
    present,
    sentinelAt,
    sentinelReceipt: async (name: string) => {
      const intent = sentinelIntents.get(name);
      assert.ok(intent);
      return JSON.parse(await readFile(intent.receiptPath, "utf8")) as SentinelIntent;
    },
    renamed,
    containerAt,
    deletes,
    resource: () => {
      assert.ok(resource);
      return resource;
    },
    gate: (operation: "create" | "remove", afterCommit: (objectId: string) => Promise<void>) => {
      gate = { operation, afterCommit };
    },
    createForwards: () => createForwards,
    siblingSurvives: async () =>
      assert.equal(await readFile(sibling, "utf8"), "unrelated directory survives\n"),
  };
}

test(
  "real CI OTel fixture retains the exact ID after a lost direct sentinel create result",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const name = `ci-otel-lost-sentinel-${randomUUID()}`;
    await assert.rejects(
      f.sentinelAt(name, { loseResult: true }),
      /lost direct sentinel create result/,
    );
    const receipt = await f.sentinelReceipt(name);
    assert.equal(receipt.phase, "created");
    assert.ok(receipt.containerId);
    assert.equal(await f.containerAt(name), receipt.containerId);
    assert.equal(id(await readFile(receipt.cidPath, "utf8")), receipt.containerId);
    assert.equal(await f.present(receipt.containerId), true);
    await assert.rejects(f.sentinelAt(name), /do not replay a sentinel create/);
    assert.deepEqual(f.deletes, []);
  },
);

test(
  "real CI OTel cleanup preserves a foreign container that wins the planned name",
  selected,
  async (t) => {
    const f = await realFixture(t);
    let foreign = "";
    await assert.rejects(
      f.prepare({
        beforeCreate: async (entry) => {
          foreign = await f.sentinelAt(String(entry.containerName));
        },
      }),
    );
    assert.equal(await f.present(foreign), true);
    assert.deepEqual(f.deletes, []);
    await f.siblingSurvives();
  },
);

test("real CI OTel cleanup removes only its recorded container", selected, async (t) => {
  const f = await realFixture(t);
  const other = await f.sentinelAt(`ci-otel-other-${randomUUID()}`);
  const prepared = await f.prepare();
  const original = await f.containerAt(prepared.artifacts.containerName);
  await f.cleanup();
  assert.equal(await f.present(original), false);
  assert.equal(await f.present(other), true);
  assert.deepEqual(f.deletes, [original]);
  await assert.rejects(stat(prepared.artifacts.directory), { code: "ENOENT" });
  await f.siblingSurvives();
});

test(
  "real CI OTel cleanup removes a renamed original and preserves its replacement",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const prepared = await f.prepare();
    const original = await f.containerAt(prepared.artifacts.containerName);
    await f.renamed(original);
    const replacement = await f.sentinelAt(prepared.artifacts.containerName);
    await f.cleanup();
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    await f.cleanup();
    assert.deepEqual(f.deletes, [original]);
    assert.equal(await f.present(replacement), true);
    await f.siblingSurvives();
  },
);

test(
  "real CI OTel cleanup retains an unreceived creation and preserves a replacement",
  selected,
  async (t) => {
    const f = await realFixture(t);
    let original = "";
    let replacement = "";
    f.gate("create", async (objectId) => {
      original = objectId;
      assert.equal(await f.present(original), true);
      await f.renamed(original);
      replacement = await f.sentinelAt(String(f.resource().containerName));
    });
    await assert.rejects(f.prepare());
    assert.equal(f.createForwards(), 1);
    assert.equal(await f.present(original), true);
    assert.equal(await f.present(replacement), true);
    assert.deepEqual(f.deletes, []);
    assert.ok((await stat(String(f.resource().directory))).isDirectory());
    await f.siblingSurvives();
  },
);

test(
  "real CI OTel cleanup recovers a completed create with a lost command result",
  selected,
  async (t) => {
    const f = await realFixture(t);
    let original = "";
    let replacement = "";
    const execFile: Executor = async (command, args, options) => {
      const result = await f.execute(command, args, options);
      if (args.includes("run")) {
        original = id(result.stdout);
        await f.renamed(original);
        replacement = await f.sentinelAt(String(f.resource().containerName));
        throw new Error("lost Docker run command result");
      }
      return result;
    };
    await assert.rejects(f.prepare({ execFile }));
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    assert.deepEqual(f.deletes, [original]);
    await f.siblingSurvives();
  },
);

test(
  "real CI OTel cleanup reconciles a lost remove response without replay",
  selected,
  async (t) => {
    const f = await realFixture(t);
    const prepared = await f.prepare();
    const original = await f.containerAt(prepared.artifacts.containerName);
    let replacement = "";
    let gateFired = false;
    f.gate("remove", async (objectId) => {
      assert.equal(objectId, original);
      assert.equal(await f.present(original), false);
      replacement = await f.sentinelAt(prepared.artifacts.containerName);
      gateFired = true;
    });
    const cleanupResult = await f.cleanup().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    assert.equal(gateFired, true, "the genuine after-remove response gate must complete");
    assert.equal(await f.present(original), false);
    assert.equal(await f.present(replacement), true);
    assert.equal(cleanupResult.ok, true, "cleanup must reconcile the lost remove response");
    await f.cleanup();
    assert.deepEqual(f.deletes, [original]);
    assert.equal(await f.present(replacement), true);
    await f.siblingSurvives();
  },
);
