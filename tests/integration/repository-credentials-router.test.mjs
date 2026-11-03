import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { describe, it as test } from "node:test";
import { repositoryClientData } from "../fixtures/repository-credentials/builders.mjs";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { settled as settle } from "../helpers/child-processes.mjs";
import { fileCompileCache } from "../helpers/compile-cache.mjs";
import { parseGhInvocation } from "../../apps/controller/src/drivers/repo/github/credentials/client/commands.ts";
import { createClientEnvironment } from "../../apps/controller/src/drivers/repo/github/credentials/client/environment.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/manifest.ts";
import {
  selectGhRepository,
  selectGitPushDestination,
  selectImplicitGhRepository,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/targets.ts";

// Children get an allowlisted environment, so they only share the lane's Node
// compile cache when it is passed explicitly; outside CI the file keeps its own.
const compileCache = await fileCompileCache("repository-credentials-router");
const clean = (extra = {}) => cleanEnvironment({ NODE_COMPILE_CACHE: compileCache, ...extra });

// Every case spawns Git or Node children, and Git starts the managed hook
// dispatcher for most commands; at most one top-level child per CPU runs.
const slots = Math.max(2, availableParallelism());
const waiting = [];
let active = 0;
async function exec(command, args, options) {
  if (active < slots) {
    active += 1;
  } else {
    // A finishing child hands its slot straight to the oldest waiter.
    await new Promise((resolve) => waiting.push(resolve));
  }
  try {
    return await run(command, args, options);
  } finally {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  }
}
const gitWith =
  (defaults = {}) =>
  (args, options = {}) =>
    exec("/usr/bin/git", args, { ...defaults, ...options });
const git = gitWith();

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const opened = (sessionId, { repository = "example/project", pushRefAllowlist } = {}) => ({
  session: { sessionId, deadlineWallMs: Date.now() + 86400000 },
  bearer: `controlled_gateway_${sessionId}_${"0".repeat(32)}`,
  client: repositoryClientData({ repository, ...(pushRefAllowlist && { pushRefAllowlist }) }),
});
/** Native material from `[repositoryRef, opened]` pairs. */
const nativeMaterial = (t, ...entries) =>
  createNativeClientMaterial(
    t,
    entries.map(([repositoryRef, session]) => ({ opened: session, repositoryRef })),
  );
const protocol = (path = "example/project.git") =>
  `protocol=https\nhost=credentials.example.test\npath=${path}\n\n`;
const environment = (material, extra = {}) => {
  const env = clean({
    HOME: material.root,
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
    ...extra,
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  return env;
};
const fill = (material, extra = {}, path, input = protocol(path)) =>
  git(["credential", "fill"], { env: environment(material, extra), input, allowFailure: true });
const pin = (material, binding) =>
  JSON.stringify([material.manifest.generation, binding.repositoryRef, binding.sessionId]);
const pushLine = (ref, source = "HEAD") => `${source} ${"1".repeat(40)} ${ref} ${"0".repeat(40)}\n`;
/** The pre-push guard's refusal when it cannot check a push, with its public reason. */
const guardFailed = (reason) =>
  `repository-pre-push-guard-failed${reason === undefined ? "" : `: ${reason}`}\n`;
/** Run the managed pre-push hook in `work` with `input` written to `name`. */
const prePush = async (work, env, destination, input, name = "push-input") => {
  await writeFile(join(work, name), input);
  return git(
    ["hook", "run", `--to-stdin=${join(work, name)}`, "pre-push", "--", "origin", destination],
    { cwd: work, env, allowFailure: true },
  );
};
const writeManifest = (material, manifest) =>
  writeFile(join(material.root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
/** A manifest over these bindings with their exact generation digest. */
const manifestOf = (bindings) => ({
  version: 1,
  generation: hash(bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
  bindings,
});
/** Copy another material's sessions into `material`; returns its bindings at their new paths. */
const relocated = async (material, other) => {
  await cp(join(other.root, "sessions"), join(material.root, "sessions"), { recursive: true });
  return other.manifest.bindings.map((binding) => ({
    ...binding,
    directory: binding.directory.replace(other.root, material.root),
  }));
};
/** A refused credential request releases nothing. */
const refused = (result, message) => {
  assert.notEqual(result.code, 0, message);
  assert.equal(result.stdout, "", message);
};
const granted = (result, bearer) => assert.equal(result.stdout.includes(bearer), true);

describe("repository credential router", { concurrency: true }, () => {
  test("manifest requires canonical reference order and its exact generation digest", async (t) => {
    const [material, reused] = await settle([
      nativeMaterial(t, ...["a", "Z", "A"].map((ref) => [ref, opened(ref)])),
      // Valid alone, but it reuses session "a" under another reference.
      nativeMaterial(t, ["b", opened("a")]),
    ]);
    assert.deepEqual(
      (await readRuntimeRepositoryManifest(material.root)).bindings.map(
        ({ repositoryRef }) => repositoryRef,
      ),
      ["A", "Z", "a"],
    );
    const duplicated = [...material.manifest.bindings, ...(await relocated(material, reused))];
    for (const manifest of [
      { ...material.manifest, generation: "0".repeat(64) },
      // A self-consistent digest cannot authorize noncanonical binding order
      // or one session bound to two references.
      manifestOf([...material.manifest.bindings].reverse()),
      manifestOf(duplicated),
    ]) {
      await writeManifest(material, manifest);
      await assert.rejects(readRuntimeRepositoryManifest(material.root), {
        message: "invalid-repository-material",
      });
    }
  });

  test("duplicate bindings select only explicit authority and never an alternate unexpired grant", async (t) => {
    const read = opened("read");
    const write = opened("write");
    const material = await nativeMaterial(t, ["read", read], ["write", write]);
    // A username is an endpoint constraint, not permission to select among duplicate grants.
    const differentUsername = await nativeMaterial(
      t,
      ["read", read],
      ["write", { ...write, client: { ...write.client, gitUsername: "alternate-session" } }],
    );
    const readBinding = material.manifest.bindings[0];
    await settle([
      fill(material).then(refused),
      ...material.manifest.bindings.flatMap((entry, index) =>
        [
          { OCE_REPOSITORY_REF: entry.repositoryRef },
          { OCE_REPOSITORY_SELECTION: pin(material, entry) },
        ].map(async (selection) => {
          const result = await fill(material, selection);
          assert.equal(result.code, 0, result.stderr);
          granted(result, `password=${[read, write][index].bearer}\n`);
        }),
      ),
      fill(
        differentUsername,
        {},
        undefined,
        protocol().replace("\n\n", "\nusername=alternate-session\n\n"),
      ).then(refused),
      ...[
        { OCE_REPOSITORY_REF: "missing" },
        { OCE_REPOSITORY_REF: "write", OCE_REPOSITORY_SELECTION: pin(material, readBinding) },
        { OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "read", "read"]) },
        { OCE_REPOSITORY_SELECTION: "invalid-json" },
      ].map((extra) =>
        fill(material, extra).then((result) => refused(result, JSON.stringify(extra))),
      ),
    ]);
    // Metadata validation covers the whole generation without reading unrelated bearer bytes.
    await writeFile(
      join(material.manifest.bindings[1].directory, "bearer"),
      "invalid unrelated bearer",
      { mode: 0o600 },
    );
    assert.equal((await fill(material, { OCE_REPOSITORY_REF: "read" })).code, 0);
    const metadataPath = join(readBinding.directory, "client.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.deadlineWallMs = 1;
    readBinding.deadlineWallMs = 1;
    await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
    await writeManifest(material, material.manifest);
    refused(await fill(material, { OCE_REPOSITORY_REF: "read" }));
  });

  test("native pre-push uses the exact pinned binding and actual destination", async (t) => {
    const restricted = opened("restricted", { pushRefAllowlist: [] });
    const permitted = opened("permitted", { pushRefAllowlist: ["refs/heads/agent/*"] });
    const other = opened("other", {
      repository: "example/other",
      pushRefAllowlist: ["refs/heads/main"],
    });
    const unrestricted = opened("unrestricted", { repository: "example/open" });
    const material = await nativeMaterial(
      t,
      ["restricted", restricted],
      ["permitted", permitted],
      ["other", other],
      ["unrestricted", unrestricted],
    );
    const work = await temporaryDirectory(t);
    await git(["init", work]);
    // Git writes an object-name source verbatim, spaces included; refnames have none.
    const relative = (ref) => pushLine(ref, "HEAD@{1 hour ago}");
    const inputs = {
      topic: pushLine("refs/heads/agent/topic"),
      relativeTopic: relative("refs/heads/agent/topic"),
      relativeMain: relative("refs/heads/main"),
      // Fields forged inside the source cannot stand in for the actual remote ref.
      forged: relative("refs/heads/main").replace(
        "HEAD@{1 hour ago}",
        pushLine("refs/heads/agent/topic", "x").trimEnd(),
      ),
      malformed: "malformed input\n",
    };
    for (const [name, input] of Object.entries(inputs)) {
      await writeFile(join(work, `push-${name}`), input);
    }
    const ref = (repositoryRef) => ({ OCE_REPOSITORY_REF: repositoryRef });
    // URL usernames constrain the selected endpoint; they cannot choose a grant.
    const named = restricted.client.gitRemote.replace("https://", "https://gateway-session@");
    const selected = material.manifest.bindings.find(
      ({ repositoryRef }) => repositoryRef === "permitted",
    );
    const notAllowed = "repository-push-ref-not-allowed\n";
    // [environment, destination, input, exit code (undefined: any failure), stderr]
    const cases = [
      [{}, undefined, "topic", undefined, guardFailed("name-one-repository-ref")],
      [ref("restricted"), undefined, "topic", 1, notAllowed],
      [ref("permitted"), undefined, "topic", 0],
      [{}, named, "topic", undefined],
      [ref("restricted"), named, "topic", 1],
      [ref("permitted"), named, "topic", 0],
      [ref("permitted"), named.replace("gateway-session@", "other@"), "topic", undefined],
      // Git decodes URL usernames before asking the credential helper, so these
      // gateway destinations still receive the bearer and must not skip the check.
      ...[
        named.replace("gateway-session@", "gateway%2Dsession@"),
        named.replace("gateway-session@", "gateway-session:secret@"),
      ].map((destination) => [
        ref("restricted"),
        destination,
        "topic",
        1,
        guardFailed("unsupported-push-destination"),
      ]),
      // A repository without a policy keeps its pushes, even beside restricted ones.
      [
        ref("unrestricted"),
        unrestricted.client.gitRemote.replace("https://", "https://gateway%2Dsession@"),
        "topic",
        0,
      ],
      [{ OCE_REPOSITORY_SELECTION: pin(material, selected) }, undefined, "topic", 0],
      [ref("permitted"), other.client.gitRemote, "topic", undefined],
      [
        {
          OCE_REPOSITORY_SELECTION: JSON.stringify([
            "0".repeat(64),
            "permitted",
            permitted.session.sessionId,
          ]),
        },
        undefined,
        "topic",
        undefined,
      ],
      [ref("restricted"), "/unmanaged/local/repository", "topic", 0],
      [ref("permitted"), undefined, "relativeTopic", 0],
      [ref("permitted"), undefined, "relativeMain", 1, notAllowed],
      [ref("permitted"), undefined, "forged", 1, notAllowed],
      // Invalid hook input is an inspection failure, not an ordinary policy denial.
      [ref("permitted"), undefined, "malformed", 1, guardFailed("invalid-pre-push-input")],
    ];
    await settle(
      cases.map(async ([extra, destination = restricted.client.gitRemote, input, code, stderr]) => {
        const result = await git(
          [
            "hook",
            "run",
            `--to-stdin=${join(work, `push-${input}`)}`,
            "pre-push",
            "--",
            "origin",
            destination,
          ],
          { cwd: work, env: environment(material, extra), allowFailure: true },
        );
        const label = JSON.stringify([extra, destination, input]);
        if (code === undefined) {
          assert.notEqual(result.code, 0, label);
        } else {
          assert.equal(result.code, code, label);
        }
        if (stderr !== undefined) {
          assert.equal(result.stderr, stderr, label);
        }
      }),
    );
    // A valid next generation that would allow this push cannot replace the generation
    // the installed hook configuration names.
    const next = await nativeMaterial(t, [
      "permitted",
      opened("next", { pushRefAllowlist: ["refs/heads/agent/*"] }),
    ]);
    await writeManifest(material, manifestOf(await relocated(material, next)));
    const replaced = await git(
      [
        "hook",
        "run",
        `--to-stdin=${join(work, "push-topic")}`,
        "pre-push",
        "--",
        "origin",
        permitted.client.gitRemote,
      ],
      { cwd: work, env: environment(material, ref("permitted")), allowFailure: true },
    );
    assert.equal(replaced.code, 1);
    assert.equal(replaced.stderr, guardFailed("invalid-repository-selection"));
  });

  test("material errors refuse pushes only to destinations a binding may name", async (t) => {
    const policy = opened("policy", { pushRefAllowlist: ["refs/heads/agent/*"] });
    const [material, sessionTarget] = await settle([
      nativeMaterial(
        t,
        ["policy", policy],
        ["open", opened("open", { repository: "example/open" })],
      ),
      temporaryDirectory(t),
    ]);
    const work = await temporaryDirectory(t);
    await git(["init", work]);
    const unrelated = [
      "https://unrelated.example.test/example/project.git",
      "https://someone@unrelated.example.test:8443/x/y",
      // A trailing-dot host is not the gateway host for Git's credential helper either.
      "https://credentials.example.test./example/project.git",
    ];
    // Gateway and canonical origins of any binding, and spellings whose host Git and
    // the URL parser could read differently, stay refused.
    const managed = [
      policy.client.gitRemote,
      "https://credentials.example.test/example/open.git",
      "https://credentials.example.test/elsewhere/repository.git",
      "https://github.com/unrelated/repository.git",
      "https://credentials.example.test:443/example/project.git",
      "https://CREDENTIALS.example.test/example/project.git",
      "https://credentials%2Eexample%2Etest/example/project.git",
      "https://user:secret@unrelated.example.test/x/y.git",
      "https://unrelated.example.test\\@credentials.example.test/example/project.git",
      "https://unrelated.example.test:443?@credentials.example.test/example/project.git",
      "https://a@b@credentials.example.test/example/project.git",
    ];
    const push = (destination, extra = {}) =>
      prePush(work, environment(material, extra), destination, pushLine("refs/heads/main"));
    const expect = async (destinations, code, stderr, extra) =>
      settle(
        destinations.map(async (destination) => {
          const result = await push(destination, extra);
          assert.equal(result.code, code, JSON.stringify([destination, extra, result.stderr]));
          if (stderr !== undefined) {
            assert.equal(result.stderr, stderr, destination);
          }
        }),
      );
    // The guard is active on valid material.
    await expect([policy.client.gitRemote], 1, "repository-push-ref-not-allowed\n");
    // A session setting naming other material is read like an unusable session; its
    // file-system error names a path and is never printed.
    const session = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "oce.repository.session" };
    await expect(unrelated, 0, "", {
      ...session,
      GIT_CONFIG_VALUE_0: join(sessionTarget, "absent"),
    });
    await expect(managed, 1, guardFailed(), {
      ...session,
      GIT_CONFIG_VALUE_0: join(sessionTarget, "absent"),
    });
    // Without the manifest and generation the configuration names, nothing proceeds.
    await settle(
      ["manifestRoot", "generation"].map((name) =>
        expect(unrelated, 1, guardFailed(), {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "oce.repository.session",
          GIT_CONFIG_VALUE_0: join(sessionTarget, "absent"),
          GIT_CONFIG_KEY_1: `oce.repository.${name}`,
          GIT_CONFIG_VALUE_1: name === "generation" ? "0".repeat(64) : "",
        }),
      ),
    );
    // One session file outside its custody rules fails the whole generation.
    await chmod(join(material.manifest.bindings[1].directory, "bearer"), 0o640);
    await expect(unrelated, 0, "");
    await expect(managed, 1, guardFailed("invalid-repository-material"));
    // Without readable public origins every destination stays refused.
    await writeFile(join(material.root, "manifest.json"), "{}", { mode: 0o600 });
    await expect(
      [...unrelated, policy.client.gitRemote],
      1,
      guardFailed("invalid-repository-material"),
    );
  });

  test("push destination normalization retains exact repository and host boundaries", async (t) => {
    const material = await nativeMaterial(t, [
      "project",
      opened("boundaries", { pushRefAllowlist: ["refs/heads/agent/*"] }),
    ]);
    const manifest = await readRuntimeRepositoryManifest(material.root);
    const binding = manifest.bindings[0];
    for (const destination of [
      "https://github.com/EXAMPLE/PROJECT/",
      "https://github.com/example/project.git/",
      "https://gateway-session@credentials.example.test/example/project.git/",
    ]) {
      assert.equal(selectGitPushDestination(manifest, destination), binding);
    }
    for (const destination of [
      "https://github.com.example.test/example/project.git",
      "https://credentials.example.test:444/example/project.git",
      "https://credentials.example.test/example/project.git/extra",
      "https://credentials.example.test/example/project.git-extra",
      "https://credentials.example.test/example/project.git.git",
      "https://credentials.example.test/elsewhere/project.git",
      "https://credentials.example.test/example//project.git",
      // Irregular gateway destinations fail closed; other hosts keep native behavior.
      "https://github.com/exa%6dple/project.git",
    ]) {
      assert.equal(selectGitPushDestination(manifest, destination), undefined);
    }
    for (const [destination, error] of [
      ["https://other@credentials.example.test/example/project.git/", /repository-not-admitted/],
      ["https://credentials.example.test/exa%6dple/project.git", /unsupported-push-destination/],
      ["https://credentials.example.test//example/project.git", /unsupported-push-destination/],
    ]) {
      assert.throws(() => selectGitPushDestination(manifest, destination), error);
    }
  });

  test("delegating an ordinary hook back to the managed dispatcher fails without recursion", async (t) => {
    const selected = opened("recursive", { pushRefAllowlist: ["refs/heads/agent/*"] });
    const material = await nativeMaterial(t, ["project", selected]);
    const work = await temporaryDirectory(t);
    await git(["init", work]);
    // A repository may install a symlink to the managed wrapper as its own hook.
    // Delegation must fail promptly, preserving the caller's refs and process lifetime.
    await symlink(join(material.hooks, "pre-push"), join(work, ".git/hooks/pre-push"));
    const inputFile = join(work, "push-input");
    await writeFile(inputFile, pushLine("refs/heads/agent/topic"));
    const result = await git(
      [
        "hook",
        "run",
        `--to-stdin=${inputFile}`,
        "pre-push",
        "--",
        "origin",
        selected.client.gitRemote,
      ],
      { cwd: work, env: environment(material), allowFailure: true, timeout: 3000 },
    );
    assert.equal(result.code, 1);
    // Forwarding is not the guard: the message names the hook and the reason.
    assert.equal(result.stderr, "repository-hook-failed: pre-push: recursive-repository-hook\n");
  });

  test("a forwarded hook killed by a signal keeps Git's status and message", async (t) => {
    const material = await nativeMaterial(t, [
      "project",
      opened("signal", { pushRefAllowlist: ["refs/heads/agent/*"] }),
    ]);
    const work = await temporaryDirectory(t);
    await git(["init", work]);
    await writeFile(join(work, ".git/hooks/post-checkout"), "#!/bin/sh\nkill -TERM $$\n", {
      mode: 0o755,
    });
    const [native, managed] = await settle(
      [clean(), environment(material)].map((env) =>
        git(["hook", "run", "post-checkout", "--", "0", "0", "1"], {
          cwd: work,
          env,
          allowFailure: true,
        }),
      ),
    );
    assert.equal(native.code, 143, native.stderr);
    assert.equal(managed.code, native.code, managed.stderr);
    assert.match(native.stderr, /died of signal 15\n$/);
    assert.equal(managed.stderr, "error: hooks/post-checkout died of signal 15\n");
  });

  test("managed hooks preserve initialization and delegate template transaction hooks", async (t) => {
    const material = await nativeMaterial(t, [
      "project",
      opened("initialization", { pushRefAllowlist: [] }),
    ]);
    const root = await temporaryDirectory(t);
    const template = join(root, "template");
    await mkdir(join(template, "hooks"), { recursive: true });
    await writeFile(
      join(template, "hooks/reference-transaction"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$INIT_HOOK_MARKER"\n',
      { mode: 0o755 },
    );
    await settle(
      [[], ["-b", "main"]].map(async (args, index) => {
        const ordinary = join(root, `ordinary-${index}`);
        const managed = join(root, `managed-${index}`);
        const expected = join(root, `expected-${index}`);
        const actual = join(root, `actual-${index}`);
        await writeFile(expected, "");
        await writeFile(actual, "");
        // Compare native transactions across Git versions: 2.55 invokes the hook
        // before HEAD exists, and the managed dispatcher must delegate it too.
        const init = (directory, env) =>
          git(["init", "--template=" + template, ...args, directory], { env });
        await settle([
          init(ordinary, clean({ INIT_HOOK_MARKER: expected })),
          init(managed, environment(material, { INIT_HOOK_MARKER: actual })),
        ]);
        assert.equal(await readFile(actual, "utf8"), await readFile(expected, "utf8"));
        assert.equal(
          await readFile(join(managed, ".git/HEAD"), "utf8"),
          await readFile(join(ordinary, ".git/HEAD"), "utf8"),
        );
      }),
    );
  });

  test("managed hooks preserve Git's default push-to-checkout behavior", async (t) => {
    const material = await nativeMaterial(t, [
      "project",
      opened("checkout", { pushRefAllowlist: ["refs/heads/agent/*"] }),
    ]);
    const root = await temporaryDirectory(t);
    const source = join(root, "source");
    const target = join(root, "target");
    const native = gitWith({ env: environment(material) });
    const tracked = (directory) => readFile(join(directory, "tracked"), "utf8");
    const targetHead = async () =>
      (await native(["-C", target, "rev-parse", "HEAD"])).stdout.trim();
    await native(["init", "-b", "main", source]);
    await native(["-C", source, "config", "user.name", "Native fixture"]);
    await native(["-C", source, "config", "user.email", "fixture@example.test"]);
    await writeFile(join(source, "tracked"), "first\n");
    await writeFile(join(source, "untouched"), "unchanged\n");
    await native(["-C", source, "add", "tracked", "untouched"]);
    await native(["-C", source, "commit", "-m", "Initial contents"]);
    await native(["clone", "--no-hardlinks", source, target]);
    await native(["-C", target, "config", "receive.denyCurrentBranch", "updateInstead"]);
    // The pushes' receive-pack does not inherit GIT_CONFIG_COUNT (see cleanEnvironment).
    await native(["-C", target, "config", "maintenance.auto", "false"]);
    await writeFile(join(source, "tracked"), "second\n");
    await native(["-C", source, "commit", "-am", "Update contents"]);
    const head = (await native(["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await native(["-C", source, "push", target, "HEAD:refs/heads/main"]);
    assert.equal(await targetHead(), head);
    assert.equal(await tracked(target), "second\n");
    assert.equal((await native(["-C", target, "status", "--porcelain"])).stdout, "");

    await writeFile(join(source, "tracked"), "third\n");
    await native(["-C", source, "commit", "-am", "Next contents"]);
    // Git refuses any unstaged change, even to a file the push does not touch.
    await writeFile(join(target, "untouched"), "local changes\n");
    const deniedUntouched = await native(["-C", source, "push", target, "HEAD:refs/heads/main"], {
      allowFailure: true,
    });
    assert.notEqual(deniedUntouched.code, 0);
    // The refusal names Git's own reason, as the built-in implementation does.
    assert.match(deniedUntouched.stderr, /Working directory has unstaged changes\n/);
    assert.doesNotMatch(deniedUntouched.stderr, /guard-failed|hook-failed/);
    assert.equal(await targetHead(), head);
    assert.equal(await tracked(target), "second\n");
    assert.equal(await readFile(join(target, "untouched"), "utf8"), "local changes\n");
    await native(["-C", target, "checkout", "--", "untouched"]);
    for (const staged of [false, true]) {
      await writeFile(join(target, "tracked"), "local changes\n");
      if (staged) {
        await native(["-C", target, "add", "tracked"]);
      }
      const denied = await native(["-C", source, "push", target, "HEAD:refs/heads/main"], {
        allowFailure: true,
      });
      assert.notEqual(denied.code, 0);
      assert.match(
        denied.stderr,
        staged
          ? /Working directory has staged changes\n/
          : /Working directory has unstaged changes\n/,
      );
      assert.equal(await targetHead(), head);
      assert.equal(await tracked(target), "local changes\n");
    }
  });

  test("literal dot-git names and effective repository endpoints cannot silently switch bindings", async (t) => {
    const a = opened("a");
    const b = opened("b", { repository: "example/project.git" });
    const c = opened("c", { repository: "example/other" });
    const material = await nativeMaterial(t, ["a", a], ["b", b], ["c", c]);
    await settle([
      fill(material).then(refused),
      fill(material, { OCE_REPOSITORY_REF: "a" }).then((result) => granted(result, a.bearer)),
      fill(material, { OCE_REPOSITORY_REF: "b" }).then((result) => granted(result, b.bearer)),
      fill(material, {}, "EXAMPLE/PROJECT.git.git").then((result) => granted(result, b.bearer)),
      fill(material, { OCE_REPOSITORY_REF: "a" }, "example/other.git").then(refused),
      fill(material, {}, "example/other").then((result) => granted(result, c.bearer)),
    ]);
  });

  test("embedded generation fails closed after replacement while local stock Git retains hooks and configuration", async (t) => {
    const replacement = opened("replacement");
    const [material, next] = await settle([
      nativeMaterial(t, ["project", opened("original")]),
      // New material is valid in isolation but cannot be selected by the old emitted helper command.
      nativeMaterial(t, ["project", replacement]),
    ]);
    const work = await temporaryDirectory(t);
    const env = environment(material, {
      OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "project", "stale"]),
      NATIVE_HOOK_MARKER: "normal-environment",
    });
    const local = gitWith({ env, cwd: work });
    const subject = async (...args) =>
      (await local([...args, "log", "-1", "--format=%s"])).stdout.trim();
    await local(["init"]);
    await local(["config", "user.name", "Native fixture"]);
    await local(["config", "user.email", "fixture@example.test"]);
    const marker = join(work, "hook-result");
    await writeFile(
      join(work, ".git/hooks/pre-commit"),
      `#!/bin/sh\nprintf '%s' "$NATIVE_HOOK_MARKER" > '${marker}'\n`,
      { mode: 0o700 },
    );
    await writeFile(join(work, "file.txt"), "native content\n");
    await local(["add", "file.txt"]);
    await local(["commit", "-m", "Native hook"]);
    assert.equal(await readFile(marker, "utf8"), "normal-environment");
    await local(["mv", "file.txt", "moved.txt"]);
    await local(["commit", "-m", "Native move"]);
    await local(["rm", "moved.txt"]);
    await local(["commit", "-m", "Native removal"]);
    await local(["config", "alias.native-status", "status --short"]);
    assert.equal((await local(["native-status"])).stdout.trim(), "?? hook-result");
    const linked = join(work, "linked");
    await local(["worktree", "add", "--detach", linked]);
    assert.equal(await subject("-C", linked), "Native removal");
    await local(["remote", "add", "origin", "https://github.com/ExAmPlE/PrOjEcT"]);
    await local(["remote", "set-url", "--push", "origin", "https://github.com/example/other.git"]);
    const [fetchUrl, pushUrl, stale] = await settle([
      local(["remote", "get-url", "origin"]),
      local(["remote", "get-url", "--push", "origin"]),
      fill(material, { OCE_REPOSITORY_SELECTION: env.OCE_REPOSITORY_SELECTION }),
    ]);
    assert.equal(fetchUrl.stdout.trim(), "https://credentials.example.test/ExAmPlE/PrOjEcT");
    assert.equal(pushUrl.stdout.trim(), "https://credentials.example.test/example/other.git");
    assert.notEqual(stale.code, 0);
    const oldConfig = await readFile(join(material.root, "gitconfig"), "utf8");
    // Install a fully valid next generation; only the old helper generation pin must reject it.
    await writeManifest(material, manifestOf(await relocated(material, next)));
    assert.equal(await readFile(join(material.root, "gitconfig"), "utf8"), oldConfig);
    const current = await readRuntimeRepositoryManifest(material.root);
    assert.equal(current.generation, next.manifest.generation);
    const [acceptedNew, rejected, last] = await settle([
      exec(
        process.execPath,
        [material.helper, "manifest", material.root, current.generation, "get"],
        {
          env: clean(),
          input: protocol(),
        },
      ),
      fill(material),
      subject(),
    ]);
    granted(acceptedNew, replacement.bearer);
    refused(rejected);
    assert.equal(last, "Native removal");
  });

  test("gh selection retains private configuration and exact pins without suppressing native system Git", async (t) => {
    const first = opened("first");
    const second = opened("second", { repository: "example/other" });
    const material = await nativeMaterial(t, ["first", first], ["second", second]);
    const manifest = await readRuntimeRepositoryManifest(material.root);
    const gh = parseGhInvocation(["api", "repos/ExAmPlE/OTHER"]);
    const selected = selectGhRepository(manifest, gh.target.value);
    assert.equal(selected.sessionId, "second");
    assert.throws(
      () => selectGhRepository(manifest, gh.target.value, manifest.bindings[0]),
      /conflicting-repository-selection/,
    );
    for (const endpoint of [
      "https://api.github.com/repos/example/project",
      // The gateway refuses any escape in a path, so the client refuses it first.
      "repos/example/project/%2e%2e/other",
      "repos/example/project/contents/a%2Fb",
    ]) {
      assert.throws(() => parseGhInvocation(["api", endpoint]), /unsupported-client-command/);
    }
    assert.equal(
      parseGhInvocation(["api", "repos/example/project/issues?labels=a%20b"]).target.value,
      "example/project",
    );
    assert.throws(
      () => parseGhInvocation(["pr", "create", "--title", "missing head"]),
      /explicit-head-required/,
    );
    assert.throws(
      () =>
        inheritedRepositoryBinding(manifest, {
          OCE_REPOSITORY_REF: "first",
          OCE_REPOSITORY_SELECTION: pin(material, material.manifest.bindings[1]),
        }),
      /conflicting-repository-selection/,
    );
    const env = createClientEnvironment(selected.configuration, selected.directory, material.root);
    assert.equal(env.HOME, material.root);
    assert.equal(env.GH_CONFIG_DIR, join(selected.directory, "gh"));
    for (const name of [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GH_TOKEN",
    ]) {
      assert.equal(env[name], undefined, name);
    }
    const hosts = await readFile(join(env.GH_CONFIG_DIR, "hosts.yml"), "utf8");
    assert.equal(hosts.includes(second.bearer), true);
    // Implicit selection reads effective remotes with the helper's path rules, so a
    // trailing slash selects the same binding.
    const remotes = await temporaryDirectory(t);
    const local = gitWith({ cwd: remotes, env: clean() });
    await local(["init"]);
    await local(["remote", "add", "origin", "https://github.com/example/other/"]);
    await local([
      "remote",
      "add",
      "gateway",
      "https://credentials.example.test/example/other.git/",
    ]);
    assert.equal(
      selectImplicitGhRepository(manifest, clean({ GIT_DIR: join(remotes, ".git") })).sessionId,
      "second",
    );
    const viewed = parseGhInvocation(["repo", "view", "github.com/example/other"]);
    assert.equal(selectGhRepository(manifest, viewed.target.value).sessionId, "second");
    assert.throws(
      () => selectGhRepository(manifest, viewed.target.value, manifest.bindings[0]),
      /conflicting-repository-selection/,
    );

    const router = resolve("apps/controller/src/drivers/repo/github/credentials/client/router.ts");
    const route = (args) =>
      exec(process.execPath, [router, ...args], { env: clean(), allowFailure: true });
    // Rejection happens before private material is read or a native child starts.
    // These forms could change hosts, select an implicit branch, launch a browser,
    // mutate beyond the supported surface, or trigger gh's push/fork workflow.
    const unsupported = [
      ["auth", "login"],
      ["extension", "exec", "anything"],
      ["repo", "fork"],
      ["repo", "view", "https://github.com/example/project"],
      ["repo", "view", "example/project", "example/other"],
      ["repo", "view", "-R", "example/project"],
      ["issue", "list", "--hostname", "other.example"],
      ["issue", "list", "--limit", "0"],
      ["pr", "list", "--search", "repo:example/other"],
      ["pr", "view", "https://github.com/example/other/pull/1"],
      ["pr", "checks"],
      ["pr", "diff", "some-branch"],
      ["pr", "view", "1", "--web"],
      ["pr", "view", "1", "-R", "example/project", "--repo", "example/other"],
      ["pr", "comment", "1", "--editor"],
      ["issue", "comment", "1", "--edit-last", "--body", "changed"],
      ["pr", "create", "--head", "other:branch"],
      ["pr", "create", "--fill"],
    ];
    await settle([
      route(["git", "status"]).then((rejected) => {
        assert.notEqual(rejected.code, 0);
        assert.equal(rejected.stderr, "unsupported-client-command\n");
      }),
      ...unsupported.map(async (args) => {
        const denied = await route(["gh", ...args]);
        assert.equal(denied.code, 1, JSON.stringify(args));
        assert.equal(denied.stdout, "");
        assert.equal(denied.stderr, "unsupported-client-command\n", JSON.stringify(args));
      }),
    ]);
  });
});
