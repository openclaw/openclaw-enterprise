import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it as test } from "node:test";
import { readRuntimeRepositoryManifest } from "../../apps/controller/src/drivers/repo/github/access/client/manifest.ts";
import { selectGitPushDestination } from "../../apps/controller/src/drivers/repo/github/access/client/targets.ts";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  clean,
  environment,
  fill,
  git,
  gitWith,
  granted,
  guardFailed,
  manifestOf,
  nativeMaterial,
  opened,
  pin,
  prePush,
  protocol,
  pushLine,
  refused,
  relocated,
  settle,
  writeManifest,
} from "./repository-credentials-router-fixture.ts";
import { registerLocalGitCases } from "./repository-credentials-router-local-git-cases.ts";
import { registerGhCases } from "./repository-credentials-router-gh-cases.ts";

describe("repository credential router", { concurrency: true }, () => {
  test("manifest requires canonical reference order and its exact generation digest", async (t) => {
    const [material, reused] = await settle([
      nativeMaterial(
        t,
        ...["a", "Z", "A"].map((ref): [string, ReturnType<typeof opened>] => [ref, opened(ref)]),
      ),
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
    assert.ok(readBinding);
    await settle([
      fill(material).then(refused),
      ...material.manifest.bindings.flatMap((entry, index) =>
        [
          { OCE_REPOSITORY_REF: entry.repositoryRef },
          { OCE_REPOSITORY_SELECTION: pin(material, entry) },
        ].map(async (selection) => {
          const result = await fill(material, selection);
          assert.equal(result.code, 0, result.stderr);
          const session = [read, write][index];
          assert.ok(session);
          granted(result, `password=${session.bearer}\n`);
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
    const otherBinding = material.manifest.bindings[1];
    assert.ok(otherBinding);
    // Metadata validation covers the whole generation without reading unrelated bearer bytes.
    await writeFile(join(otherBinding.directory, "bearer"), "invalid unrelated bearer", {
      mode: 0o600,
    });
    assert.equal((await fill(material, { OCE_REPOSITORY_REF: "read" })).code, 0);
    const metadataPath = join(readBinding.directory, "client.json");
    const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.ok(metadata && typeof metadata === "object" && "deadlineWallMs" in metadata);

    await writeFile(metadataPath, JSON.stringify({ ...metadata, deadlineWallMs: 1 }), {
      mode: 0o600,
    });
    await writeManifest(material, {
      ...material.manifest,
      bindings: material.manifest.bindings.map((binding) =>
        binding === readBinding ? { ...binding, deadlineWallMs: 1 } : binding,
      ),
    });
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
    const relative = (ref: string) => pushLine(ref, "HEAD@{1 hour ago}");
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
    const ref = (repositoryRef: string) => ({ OCE_REPOSITORY_REF: repositoryRef });
    // URL usernames constrain the selected endpoint; they cannot choose a grant.
    const named = restricted.client.gitRemote.replace("https://", "https://gateway-session@");
    const selected = material.manifest.bindings.find(
      ({ repositoryRef }) => repositoryRef === "permitted",
    );
    assert.ok(selected);
    const stalePin = {
      OCE_REPOSITORY_SELECTION: JSON.stringify([
        "0".repeat(64),
        "permitted",
        permitted.session.sessionId,
      ]),
    };
    const notAllowed = "repository-push-ref-not-allowed\n";
    // [environment, destination, input, exit code (undefined: any failure), stderr]
    type PushCase = [
      NodeJS.ProcessEnv,
      string | undefined,
      keyof typeof inputs,
      number | undefined,
      string?,
    ];
    const cases: PushCase[] = [
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
      ].map((destination): PushCase => [
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
      [stalePin, undefined, "topic", undefined],
      [stalePin, "https://unrelated.example.test/example/repository.git", "topic", 0],
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
    const managed: string[] = [
      policy.client.gitRemote,
      "https://credentials.example.test/example/open.git",
      "https://credentials.example.test/elsewhere/repository.git",
      "https://github.com/unrelated/repository.git",
      "https://credentials.example.test:443/example/project.git",
      "https://CREDENTIALS.example.test/example/project.git",
      "https://credentials%2Eexample%2Etest/example/project.git",
      syntheticCredentialUrl({
        username: "user",
        port: undefined,
        password: "secret",
        host: "unrelated.example.test",
        pathname: "/x/y.git",
      }),
      "https://unrelated.example.test\\@credentials.example.test/example/project.git",
      "https://unrelated.example.test:443?@credentials.example.test/example/project.git",
      "https://a@b@credentials.example.test/example/project.git",
    ];
    const push = (destination: string, extra: NodeJS.ProcessEnv = {}) =>
      prePush(work, environment(material, extra), destination, pushLine("refs/heads/main"));
    const expect = async (
      destinations: string[],
      code: number,
      stderr?: string,
      extra?: NodeJS.ProcessEnv,
    ) =>
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
    const otherBinding = material.manifest.bindings[1];
    assert.ok(otherBinding);
    // One session file outside its custody rules fails the whole generation.
    await chmod(join(otherBinding.directory, "bearer"), 0o640);
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
    assert.ok(binding);
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
    ] as const) {
      assert.throws(() => selectGitPushDestination(manifest, destination), error);
    }
  });

  test("delegating an ordinary hook back to the managed dispatcher fails without recursion", async (t) => {
    const selected = opened("recursive", { pushRefAllowlist: ["refs/heads/agent/*"] });
    const material = await nativeMaterial(t, ["project", selected]);
    const work = await temporaryDirectory(t);
    await git(["init", work]);
    // A repository may chain relative symlinks back to the managed wrapper.
    // The wrapper must reach the recursion guard, not resolve imports from .git.
    assert.ok(material.hooks);
    await symlink(relative(work, join(material.hooks, "pre-push")), join(work, "managed-hook"));
    await symlink("../../managed-hook", join(work, ".git/hooks/pre-push"));
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
    assert.ok(native && managed);
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
        const init = (directory: string, env: NodeJS.ProcessEnv) =>
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
    const tracked = (directory: string) => readFile(join(directory, "tracked"), "utf8");
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

  registerLocalGitCases();
  registerGhCases();
});
