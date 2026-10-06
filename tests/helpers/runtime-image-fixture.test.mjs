import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProcessGroupSettled,
  isRuntimeImageJob,
  localDockerCli,
  withRuntimeImageFixture,
} from "./runtime-image-fixture.mjs";

test("runtime image test routes only to its dedicated hosted job", () => {
  const job = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_JOB: "runtime-image-fixture",
    OCC_RUNTIME_IMAGE_RECEIPT: "/tmp/receipt",
  };
  assert.equal(isRuntimeImageJob(job), true);
  assert.equal(isRuntimeImageJob({ OCC_TEST_RUNTIME_IMAGE: "node:existing" }), false);
  assert.equal(isRuntimeImageJob({ ...job, GITHUB_JOB: "another-job" }), false);
  assert.equal(isRuntimeImageJob({ ...job, RUNNER_ENVIRONMENT: "self-hosted" }), false);
  assert.equal(isRuntimeImageJob({ ...job, OCC_RUNTIME_IMAGE_RECEIPT: "" }), false);
});

const baseId = `sha256:${"b".repeat(64)}`;
const ids = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
const containerId = "c".repeat(64);

// The fake models command effects and lost responses; no daemon is involved.
function fakeEngine(options = {}) {
  const tags = new Map([["base:fixture", baseId]]);
  const images = new Set([baseId]);
  const containers = new Set();
  const calls = [];
  let builds = 0;
  const docker = async (...args) => {
    calls.push(args);
    if (args[0] === "build") {
      const id = ids[builds++];
      const tag = args[args.indexOf("-t") + 1];
      images.add(id);
      tags.set(tag, id);
      await writeFile(args[args.indexOf("--iidfile") + 1], id);
      if (options.buildResponseLost) {
        throw new Error("build response lost");
      }
      return { stdout: "" };
    }
    if (args[0] === "create") {
      containers.add(containerId);
      if (options.createResponseLost) {
        throw new Error("create response lost");
      }
      return { stdout: `${containerId}\n` };
    }
    if (args[0] === "tag") {
      tags.set(args[2], args[1]);
      if (options.retagResponseLost) {
        throw new Error("retag response lost");
      }
      return { stdout: "" };
    }
    if (args[0] === "rm") {
      if (options.containerRemoveFails) {
        throw new Error("container removal failed");
      }
      assert.equal(args[2], containerId);
      containers.delete(args[2]);
      return { stdout: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const id = tags.get(args[2]) ?? args[2];
      if (!images.has(id)) {
        throw new Error("No such image");
      }
      if (options.omitReferences && args[2] === id) {
        return { stdout: JSON.stringify([{ Id: id }]) };
      }
      return {
        stdout: JSON.stringify([
          {
            Id: id,
            RepoTags: [...tags].filter(([, value]) => value === id).map(([tag]) => tag),
            RepoDigests: [],
          },
        ]),
      };
    }
    if (args[0] === "image" && args[1] === "rm") {
      assert.equal(args[2], "--no-prune");
      const ref = args[3];
      const id = tags.get(ref) ?? ref;
      if (tags.has(ref)) {
        tags.delete(ref);
      }
      const otherTags = [...tags.values()].includes(id);
      let stdout = `Untagged: ${ref}\n`;
      if (!otherTags) {
        images.delete(id);
        stdout += `Deleted: ${id}\n`;
      }
      if (options.imageRemoveResponseLost) {
        throw new Error("image removal response lost");
      }
      return { stdout };
    }
    throw new Error(`unexpected fake command: ${args.join(" ")}`);
  };
  return { docker, tags, images, containers, calls };
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-fixture-control-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildPair(fixture, directory) {
  const first = await fixture.build("fixture:first", join(directory, "first.iid"), "first", baseId);
  const second = await fixture.build(
    "fixture:second",
    join(directory, "second.iid"),
    "second",
    baseId,
  );
  return { first, second };
}

function imageRemovals(engine) {
  return engine.calls.filter((args) => args[0] === "image" && args[1] === "rm");
}

test("runtime fixture completes an acknowledged container-only lifecycle", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine();
    await withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
      await fixture.create("owned-container", ["base:fixture"]);
    });
    assert.equal(engine.containers.size, 0);
    assert.deepEqual([...engine.images], [baseId]);
    assert.equal(imageRemovals(engine).length, 0);
  });
});

test("runtime fixture removes its exact retargeted tags and images", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine();
    await withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
      const { second } = await buildPair(fixture, directory);
      await fixture.create("owned-container", ["fixture:first"]);
      await fixture.retag(second, "fixture:first");
    });
    assert.equal(engine.containers.size, 0);
    assert.deepEqual([...engine.images], [baseId]);
    assert.deepEqual([...engine.tags], [["base:fixture", baseId]]);
    assert.equal(imageRemovals(engine).length, 3);
    assert.ok(imageRemovals(engine).every((args) => args[2] === "--no-prune"));
  });
});

test("runtime fixture preserves primary and cleanup failures", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine({ containerRemoveFails: true });
    const primary = new Error("primary assertion failed");
    let failure;
    try {
      await withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await buildPair(fixture, directory);
        await fixture.create("owned-container", ["fixture:first"]);
        throw primary;
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof AggregateError);
    assert.ok(failure.errors.includes(primary));
    assert.ok(failure.errors.some((error) => /container removal failed/.test(error.message)));
    assert.ok(failure.errors.some((error) => /outcome.*unknown/.test(error.message)));
    assert.equal(engine.calls.filter((args) => args[0] === "rm").length, 1);
    assert.equal(imageRemovals(engine).length, 0);
  });
});

test("runtime fixture preserves an undefined rejection with and without cleanup errors", async () => {
  await withDirectory(async (directory) => {
    let rejected = false;
    await withRuntimeImageFixture(fakeEngine().docker, directory, async () => {
      throw undefined;
    }).then(
      () => {
        throw new Error("undefined rejection was swallowed");
      },
      (error) => {
        rejected = true;
        assert.equal(error, undefined);
      },
    );
    assert.equal(rejected, true);
  });
  await withDirectory(async (directory) => {
    const engine = fakeEngine({ containerRemoveFails: true });
    let failure;
    try {
      await withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await fixture.create("owned-container", ["base:fixture"]);
        throw undefined;
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors[0], undefined);
    assert.ok(failure.errors.some((error) => /container removal failed/.test(error?.message)));
  });
});

test("runtime fixture reports a lost build response without deleting or replaying", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine({ buildResponseLost: true });
    let failure;
    try {
      await withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await fixture.build("fixture:first", join(directory, "first.iid"), "first", baseId);
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof AggregateError);
    assert.ok(failure.errors.some((error) => /build response lost/.test(error.message)));
    assert.ok(
      failure.errors.some((error) =>
        /build outcome for fixture:first is unknown/.test(error.message),
      ),
    );
    assert.ok(engine.images.has(ids[0]));
    assert.equal(engine.tags.get("fixture:first"), ids[0]);
    assert.equal(engine.calls.filter((args) => args[0] === "build").length, 1);
    assert.equal(imageRemovals(engine).length, 0);
  });
});

test("runtime fixture retains resources when create or retag response is lost", async () => {
  for (const options of [{ createResponseLost: true }, { retagResponseLost: true }]) {
    await withDirectory(async (directory) => {
      const engine = fakeEngine(options);
      await assert.rejects(
        withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
          const { second } = await buildPair(fixture, directory);
          if (options.createResponseLost) {
            await fixture.create("ambiguous-name", ["fixture:first"]);
          } else {
            await fixture.retag(second, "fixture:first");
          }
        }),
        /Runtime image fixture and cleanup failed/,
      );
      assert.equal(imageRemovals(engine).length, 0);
      assert.equal(engine.calls.filter((args) => args[0] === "rm").length, 0);
      if (options.createResponseLost) {
        assert.ok(engine.containers.has(containerId));
      }
      assert.ok(engine.images.has(baseId));
    });
  }
});

test("runtime fixture does not remove a tag changed by another writer", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine();
    await assert.rejects(
      withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        const { second } = await buildPair(fixture, directory);
        await fixture.retag(second, "fixture:first");
        engine.tags.set("fixture:first", baseId);
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((item) => /Tag changed/.test(item.message)),
    );
    assert.equal(engine.tags.get("fixture:first"), baseId);
    assert.ok(engine.images.has(baseId));
    assert.equal(imageRemovals(engine).length, 0);
  });
});

test("runtime fixture does not replay a lost image removal response", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine({ imageRemoveResponseLost: true });
    await assert.rejects(
      withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await buildPair(fixture, directory);
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((item) => /outcome unknown/.test(item.message)),
    );
    assert.equal(imageRemovals(engine).length, 1);
    assert.ok(engine.images.has(baseId));
  });
});

test("runtime fixture blocks later operations after an unknown effect", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine({ buildResponseLost: true });
    await assert.rejects(
      withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await fixture
          .build("fixture:first", join(directory, "first.iid"), "first", baseId)
          .catch(() => {});
        await assert.rejects(fixture.create("late-container", ["base:fixture"]), /unknown effect/);
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        /build outcome for fixture:first is unknown/.test(error.errors[0].message),
    );
    assert.equal(engine.calls.filter((args) => args[0] === "create").length, 0);
    assert.equal(imageRemovals(engine).length, 0);
  });
});

test("runtime fixture records pending effects and successful cleanup", async () => {
  await withDirectory(async (directory) => {
    const receiptPath = join(directory, "receipt.json");
    const engine = fakeEngine({ imageRemoveResponseLost: true });
    await assert.rejects(
      withRuntimeImageFixture(
        engine.docker,
        undefined,
        async (fixture) => {
          await buildPair(fixture, directory);
        },
        { receiptPath },
      ),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0].message === "image removal response lost" &&
        /image cleanup incomplete or outcome unknown/.test(error.errors.at(-1).message),
    );
    const result = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(result.status, "unknown");
    assert.equal(result.pending.operation, "image-tag-remove");
    assert.equal(result.pending.reference, "fixture:second");
    assert.deepEqual(result.images, ids);
    assert.ok(
      result.history.some(
        (entry) => entry.operation === "image-tag-remove" && entry.status === "pending",
      ),
    );
  });
  await withDirectory(async (directory) => {
    const receiptPath = join(directory, "receipt.json");
    const engine = fakeEngine();
    await withRuntimeImageFixture(
      engine.docker,
      undefined,
      async (fixture) => {
        await buildPair(fixture, directory);
      },
      { receiptPath },
    );
    const result = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(result.status, "complete");
    assert.equal(result.pending, undefined);
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.tags, []);
  });
});

test("runtime fixture retains images when Docker omits reference information", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine({ omitReferences: true });
    await assert.rejects(
      withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await buildPair(fixture, directory);
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((item) => /omitted reference information/.test(item.message)),
    );
    assert.equal(imageRemovals(engine).length, 0);
    assert.ok(ids.every((id) => engine.images.has(id)));
  });
});

test("runtime fixture refuses existing tags and foreign image references", async () => {
  await withDirectory(async (directory) => {
    const engine = fakeEngine();
    await assert.rejects(
      withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        await fixture.build("base:fixture", join(directory, "base.iid"), "nonce", baseId);
      }),
      /Refusing to overwrite/,
    );
    assert.equal(engine.calls.filter((args) => args[0] === "build").length, 0);
    assert.ok(engine.images.has(baseId));
  });
  await withDirectory(async (directory) => {
    const engine = fakeEngine();
    await assert.rejects(
      withRuntimeImageFixture(engine.docker, directory, async (fixture) => {
        const { first } = await buildPair(fixture, directory);
        engine.tags.set("foreign:tag", first);
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((item) => /unowned references/.test(item.message)),
    );
    assert.equal(imageRemovals(engine).length, 0);
    assert.equal(engine.tags.get("foreign:tag"), ids[0]);
  });
});

test("runtime fixture CLI binds the driver's socket without inherited endpoint overrides", async () => {
  const inherited = {
    PATH: "/bin",
    DOCKER_HOST: "tcp://remote.example:2376",
    DOCKER_CONTEXT: "remote",
    DOCKER_TLS: "1",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/foreign",
    BUILDX_BUILDER: "remote-builder",
    OTHER: "kept",
  };
  let call;
  const docker = localDockerCli(
    (...args) => {
      call = args;
      const execution = Promise.resolve({ stdout: "ok" });
      execution.child = { pid: 123 };
      return execution;
    },
    inherited,
    (pid) => assert.equal(pid, 123),
  );
  assert.deepEqual(await docker("image", "inspect", "owned"), { stdout: "ok" });
  assert.equal(call[0], "docker");
  assert.deepEqual(call[1], ["--host=unix:///var/run/docker.sock", "image", "inspect", "owned"]);
  assert.deepEqual(call[2].env, { PATH: "/bin", OTHER: "kept" });
  assert.equal(call[2].detached, true);
  assert.deepEqual(docker.disposition(), {
    started: 1,
    settled: 1,
    unknown: 0,
    escapedDescendants: "not-observed",
  });
  assert.equal(inherited.DOCKER_CONTEXT, "remote");
});

test("runtime fixture refuses further Docker commands after an unsettled group", async () => {
  let calls = 0;
  const docker = localDockerCli(
    () => {
      calls += 1;
      const execution = Promise.resolve({ stdout: `${containerId}\n` });
      execution.child = { pid: 123 };
      return execution;
    },
    {},
    () => {
      throw new Error("group still active");
    },
  );
  await assert.rejects(
    withRuntimeImageFixture(docker, undefined, async (fixture) => {
      await fixture.create("owned", ["base"]);
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((item) => /process group did not settle/.test(item?.message)),
  );
  await assert.rejects(docker("image", "inspect", "base"), /unsettled process group/);
  assert.equal(calls, 1);
  assert.equal(docker.disposition().unknown, 1);
});

test("process group observation detects a surviving descendant", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], {stdio:"ignore"}).unref()',
    ],
    { detached: true, stdio: "ignore" },
  );
  await once(child, "close");
  assert.throws(() => assertProcessGroupSettled(child.pid), /still active/);
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      assertProcessGroupSettled(child.pid);
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});
