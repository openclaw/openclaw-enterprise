import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { parseGhInvocation } from "../../apps/controller/src/drivers/repo/github/credentials/client/commands.ts";
import { createClientEnvironment } from "../../apps/controller/src/drivers/repo/github/credentials/client/environment.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/manifest.ts";
import {
  selectGhRepository,
  selectGitPushDestination,
} from "../../apps/controller/src/drivers/repo/github/credentials/client/targets.ts";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const opened = (
  sessionId,
  repository = "example/project",
  deadlineWallMs = Date.now() + 86400000,
) => ({
  session: { sessionId, deadlineWallMs },
  bearer: `controlled_gateway_${sessionId}_${"0".repeat(32)}`,
  client: {
    gatewayOrigin: "https://credentials.example.test",
    gitRemote: `https://credentials.example.test/${repository}.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "credentials.example.test",
    repository,
  },
});
const protocol = (path = "example/project.git") =>
  `protocol=https\nhost=credentials.example.test\npath=${path}\n\n`;
const environment = (material, extra = {}) => {
  const env = cleanEnvironment({
    HOME: material.root,
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
    ...extra,
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  return env;
};
const fill = (material, extra = {}, path) =>
  run("/usr/bin/git", ["credential", "fill"], {
    env: environment(material, extra),
    input: protocol(path),
    allowFailure: true,
  });
const pin = (material, binding) =>
  JSON.stringify([material.manifest.generation, binding.repositoryRef, binding.sessionId]);

test("manifest requires canonical reference order and its exact generation digest", async (t) => {
  const material = await createNativeClientMaterial(
    t,
    ["a", "Z", "A"].map((repositoryRef) => ({ opened: opened(repositoryRef), repositoryRef })),
  );
  assert.deepEqual(
    (await readRuntimeRepositoryManifest(material.root)).bindings.map(
      ({ repositoryRef }) => repositoryRef,
    ),
    ["A", "Z", "a"],
  );
  const reversed = [...material.manifest.bindings].reverse();
  for (const manifest of [
    { ...material.manifest, generation: "0".repeat(64) },
    {
      ...material.manifest,
      bindings: reversed,
      // A self-consistent digest cannot authorize noncanonical binding order.
      generation: hash(reversed.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
    },
  ]) {
    await writeFile(join(material.root, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    await assert.rejects(readRuntimeRepositoryManifest(material.root), {
      message: "invalid-repository-material",
    });
  }
});

test("duplicate bindings select only explicit authority and never an alternate unexpired grant", async (t) => {
  const read = opened("read");
  const write = opened("write");
  const material = await createNativeClientMaterial(t, [
    { opened: read, repositoryRef: "read" },
    { opened: write, repositoryRef: "write" },
  ]);
  const denied = await fill(material);
  assert.notEqual(denied.code, 0);
  assert.equal(denied.stdout, "");
  for (const [entry, bearer] of material.manifest.bindings.map((binding, index) => [
    binding,
    [read, write][index].bearer,
  ])) {
    for (const selection of [
      { OCE_REPOSITORY_REF: entry.repositoryRef },
      { OCE_REPOSITORY_SELECTION: pin(material, entry) },
    ]) {
      const result = await fill(material, selection);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.includes(`password=${bearer}\n`), true);
    }
  }
  // A username is an endpoint constraint, not permission to select among duplicate grants.
  const differentUsername = await createNativeClientMaterial(t, [
    { opened: read, repositoryRef: "read" },
    {
      opened: { ...write, client: { ...write.client, gitUsername: "alternate-session" } },
      repositoryRef: "write",
    },
  ]);
  const usernameSelection = await run("/usr/bin/git", ["credential", "fill"], {
    env: environment(differentUsername),
    input: protocol().replace("\n\n", "\nusername=alternate-session\n\n"),
    allowFailure: true,
  });
  assert.notEqual(usernameSelection.code, 0);
  assert.equal(usernameSelection.stdout, "");
  const readBinding = material.manifest.bindings[0];
  for (const extra of [
    { OCE_REPOSITORY_REF: "missing" },
    { OCE_REPOSITORY_REF: "write", OCE_REPOSITORY_SELECTION: pin(material, readBinding) },
    { OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "read", "read"]) },
    { OCE_REPOSITORY_SELECTION: "invalid-json" },
  ]) {
    const result = await fill(material, extra);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
  }
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
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(material.manifest), {
    mode: 0o600,
  });
  const expired = await fill(material, { OCE_REPOSITORY_REF: "read" });
  assert.notEqual(expired.code, 0);
  assert.equal(expired.stdout, "");
});

test("native pre-push uses the exact pinned binding and actual destination", async (t) => {
  const restricted = opened("restricted");
  restricted.client.pushRefAllowlist = [];
  const permitted = opened("permitted");
  permitted.client.pushRefAllowlist = ["refs/heads/agent/*"];
  const other = opened("other", "example/other");
  other.client.pushRefAllowlist = ["refs/heads/main"];
  const unrestricted = opened("unrestricted", "example/open");
  const material = await createNativeClientMaterial(t, [
    { opened: restricted, repositoryRef: "restricted" },
    { opened: permitted, repositoryRef: "permitted" },
    { opened: other, repositoryRef: "other" },
    { opened: unrestricted, repositoryRef: "unrestricted" },
  ]);
  const work = await temporaryDirectory(t);
  await run("/usr/bin/git", ["init", work]);
  const input = "HEAD " + "1".repeat(40) + " refs/heads/agent/topic " + "0".repeat(40) + "\n";
  const inputFile = join(work, "push-input");
  await writeFile(inputFile, input);
  const invoke = (extra = {}, destination = restricted.client.gitRemote) =>
    run(
      "/usr/bin/git",
      ["hook", "run", "--to-stdin=" + inputFile, "pre-push", "--", "origin", destination],
      {
        cwd: work,
        env: environment(material, extra),
        allowFailure: true,
      },
    );
  const ambiguous = await invoke();
  assert.notEqual(ambiguous.code, 0);
  assert.equal(ambiguous.stderr, "repository-pre-push-guard-failed\n");
  const denied = await invoke({ OCE_REPOSITORY_REF: "restricted" });
  assert.equal(denied.code, 1);
  assert.equal(denied.stderr, "repository-push-ref-not-allowed\n");
  assert.equal((await invoke({ OCE_REPOSITORY_REF: "permitted" })).code, 0);
  // URL usernames constrain the selected endpoint; they cannot choose a grant.
  const namedDestination = restricted.client.gitRemote.replace(
    "https://",
    "https://gateway-session@",
  );
  assert.notEqual((await invoke({}, namedDestination)).code, 0);
  assert.equal((await invoke({ OCE_REPOSITORY_REF: "restricted" }, namedDestination)).code, 1);
  assert.equal((await invoke({ OCE_REPOSITORY_REF: "permitted" }, namedDestination)).code, 0);
  assert.notEqual(
    (
      await invoke(
        { OCE_REPOSITORY_REF: "permitted" },
        namedDestination.replace("gateway-session@", "other@"),
      )
    ).code,
    0,
  );
  // Git decodes URL usernames before asking the credential helper, so these
  // gateway destinations still receive the bearer and must not skip the check.
  for (const destination of [
    namedDestination.replace("gateway-session@", "gateway%2Dsession@"),
    namedDestination.replace("gateway-session@", "gateway-session:secret@"),
  ]) {
    const unparsed = await invoke({ OCE_REPOSITORY_REF: "restricted" }, destination);
    assert.equal(unparsed.code, 1);
    assert.equal(unparsed.stderr, "repository-pre-push-guard-failed\n");
  }
  // A repository without a policy keeps its pushes, even beside restricted ones.
  const unrestrictedDestination = unrestricted.client.gitRemote.replace(
    "https://",
    "https://gateway%2Dsession@",
  );
  assert.equal(
    (await invoke({ OCE_REPOSITORY_REF: "unrestricted" }, unrestrictedDestination)).code,
    0,
  );
  const selected = material.manifest.bindings.find(
    ({ repositoryRef }) => repositoryRef === "permitted",
  );
  assert.equal((await invoke({ OCE_REPOSITORY_SELECTION: pin(material, selected) })).code, 0);
  assert.notEqual(
    (await invoke({ OCE_REPOSITORY_REF: "permitted" }, other.client.gitRemote)).code,
    0,
  );
  assert.notEqual(
    (
      await invoke({
        OCE_REPOSITORY_SELECTION: JSON.stringify([
          "0".repeat(64),
          "permitted",
          permitted.session.sessionId,
        ]),
      })
    ).code,
    0,
  );
  assert.equal(
    (await invoke({ OCE_REPOSITORY_REF: "restricted" }, "/unmanaged/local/repository")).code,
    0,
  );
  // Git writes an object-name source verbatim, spaces included; refnames have none.
  const relative = (ref) =>
    "HEAD@{1 hour ago} " + "1".repeat(40) + " " + ref + " " + "0".repeat(40) + "\n";
  await writeFile(inputFile, relative("refs/heads/agent/topic"));
  assert.equal((await invoke({ OCE_REPOSITORY_REF: "permitted" })).code, 0);
  await writeFile(inputFile, relative("refs/heads/main"));
  const relativeDenied = await invoke({ OCE_REPOSITORY_REF: "permitted" });
  assert.equal(relativeDenied.code, 1);
  assert.equal(relativeDenied.stderr, "repository-push-ref-not-allowed\n");
  // Fields forged inside the source cannot stand in for the actual remote ref.
  await writeFile(
    inputFile,
    relative("refs/heads/main").replace(
      "HEAD@{1 hour ago}",
      "x " + "1".repeat(40) + " refs/heads/agent/topic " + "0".repeat(40),
    ),
  );
  const forged = await invoke({ OCE_REPOSITORY_REF: "permitted" });
  assert.equal(forged.code, 1);
  assert.equal(forged.stderr, "repository-push-ref-not-allowed\n");
  // Invalid hook input is an inspection failure, not an ordinary policy denial.
  await writeFile(inputFile, "malformed input\n");
  const malformed = await invoke({ OCE_REPOSITORY_REF: "permitted" });
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stderr, "repository-pre-push-guard-failed\n");
});

test("push destination normalization retains exact repository and host boundaries", async (t) => {
  const selected = opened("boundaries");
  selected.client.pushRefAllowlist = ["refs/heads/agent/*"];
  const material = await createNativeClientMaterial(t, [
    { opened: selected, repositoryRef: "project" },
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
  ]) {
    assert.equal(selectGitPushDestination(manifest, destination), undefined);
  }
  assert.throws(
    () =>
      selectGitPushDestination(
        manifest,
        "https://other@credentials.example.test/example/project.git/",
      ),
    /repository-not-admitted/,
  );
  // Irregular gateway destinations fail closed; other hosts keep native behavior.
  assert.equal(
    selectGitPushDestination(manifest, "https://github.com/exa%6dple/project.git"),
    undefined,
  );
  for (const destination of [
    "https://credentials.example.test/exa%6dple/project.git",
    "https://credentials.example.test//example/project.git",
  ]) {
    assert.throws(
      () => selectGitPushDestination(manifest, destination),
      /unsupported-push-destination/,
    );
  }
});

test("delegating an ordinary hook back to the managed dispatcher fails without recursion", async (t) => {
  const selected = opened("recursive");
  selected.client.pushRefAllowlist = ["refs/heads/agent/*"];
  const material = await createNativeClientMaterial(t, [
    { opened: selected, repositoryRef: "project" },
  ]);
  const work = await temporaryDirectory(t);
  await run("/usr/bin/git", ["init", work]);
  // A repository may install a symlink to the managed wrapper as its own hook.
  // Delegation must fail promptly, preserving the caller's refs and process lifetime.
  await symlink(join(material.hooks, "pre-push"), join(work, ".git/hooks/pre-push"));
  const inputFile = join(work, "push-input");
  await writeFile(
    inputFile,
    "HEAD " + "1".repeat(40) + " refs/heads/agent/topic " + "0".repeat(40) + "\n",
  );
  const result = await run(
    "/usr/bin/git",
    [
      "hook",
      "run",
      "--to-stdin=" + inputFile,
      "pre-push",
      "--",
      "origin",
      selected.client.gitRemote,
    ],
    {
      cwd: work,
      env: environment(material),
      allowFailure: true,
      timeout: 3000,
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /repository-pre-push-guard-failed/);
});

test("managed hooks preserve initialization and delegate template transaction hooks", async (t) => {
  const selected = opened("initialization");
  selected.client.pushRefAllowlist = [];
  const material = await createNativeClientMaterial(t, [
    { opened: selected, repositoryRef: "project" },
  ]);
  const root = await temporaryDirectory(t);
  const template = join(root, "template");
  await mkdir(join(template, "hooks"), { recursive: true });
  await writeFile(
    join(template, "hooks/reference-transaction"),
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$INIT_HOOK_MARKER"\n',
    { mode: 0o755 },
  );
  for (const [index, args] of [[], ["-b", "main"]].entries()) {
    const ordinary = join(root, `ordinary-${index}`);
    const managed = join(root, `managed-${index}`);
    const expected = join(root, `expected-${index}`);
    const actual = join(root, `actual-${index}`);
    await writeFile(expected, "");
    await writeFile(actual, "");
    // Compare native transactions across Git versions: 2.55 invokes the hook
    // before HEAD exists, and the managed dispatcher must delegate it too.
    await run("/usr/bin/git", ["init", "--template=" + template, ...args, ordinary], {
      env: cleanEnvironment({ INIT_HOOK_MARKER: expected }),
    });
    await run("/usr/bin/git", ["init", "--template=" + template, ...args, managed], {
      env: environment(material, { INIT_HOOK_MARKER: actual }),
    });
    assert.equal(await readFile(actual, "utf8"), await readFile(expected, "utf8"));
    assert.equal(
      await readFile(join(managed, ".git/HEAD"), "utf8"),
      await readFile(join(ordinary, ".git/HEAD"), "utf8"),
    );
  }
});

test("managed hooks preserve Git's default push-to-checkout behavior", async (t) => {
  const selected = opened("checkout");
  selected.client.pushRefAllowlist = ["refs/heads/agent/*"];
  const material = await createNativeClientMaterial(t, [
    { opened: selected, repositoryRef: "project" },
  ]);
  const root = await temporaryDirectory(t);
  const source = join(root, "source");
  const target = join(root, "target");
  const git = (args, options = {}) =>
    run("/usr/bin/git", args, { env: environment(material), ...options });
  await git(["init", "-b", "main", source]);
  await git(["-C", source, "config", "user.name", "Native fixture"]);
  await git(["-C", source, "config", "user.email", "fixture@example.test"]);
  await writeFile(join(source, "tracked"), "first\n");
  await git(["-C", source, "add", "tracked"]);
  await git(["-C", source, "commit", "-m", "Initial contents"]);
  await git(["clone", "--no-hardlinks", source, target]);
  await git(["-C", target, "config", "receive.denyCurrentBranch", "updateInstead"]);
  await writeFile(join(source, "tracked"), "second\n");
  await git(["-C", source, "commit", "-am", "Update contents"]);
  const head = (await git(["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", source, "push", target, "HEAD:refs/heads/main"]);
  assert.equal((await git(["-C", target, "rev-parse", "HEAD"])).stdout.trim(), head);
  assert.equal(await readFile(join(target, "tracked"), "utf8"), "second\n");
  assert.equal((await git(["-C", target, "status", "--porcelain"])).stdout, "");

  await writeFile(join(source, "tracked"), "third\n");
  await git(["-C", source, "commit", "-am", "Next contents"]);
  for (const staged of [false, true]) {
    await writeFile(join(target, "tracked"), "local changes\n");
    if (staged) {
      await git(["-C", target, "add", "tracked"]);
    }
    const denied = await git(["-C", source, "push", target, "HEAD:refs/heads/main"], {
      allowFailure: true,
    });
    assert.notEqual(denied.code, 0);
    assert.equal((await git(["-C", target, "rev-parse", "HEAD"])).stdout.trim(), head);
    assert.equal(await readFile(join(target, "tracked"), "utf8"), "local changes\n");
  }
});

test("literal dot-git names and effective repository endpoints cannot silently switch bindings", async (t) => {
  const a = opened("a");
  const b = opened("b", "example/project.git");
  const c = opened("c", "example/other");
  const material = await createNativeClientMaterial(t, [
    { opened: a, repositoryRef: "a" },
    { opened: b, repositoryRef: "b" },
    { opened: c, repositoryRef: "c" },
  ]);
  assert.notEqual((await fill(material)).code, 0);
  assert.equal((await fill(material, { OCE_REPOSITORY_REF: "a" })).stdout.includes(a.bearer), true);
  assert.equal((await fill(material, { OCE_REPOSITORY_REF: "b" })).stdout.includes(b.bearer), true);
  assert.equal(
    (await fill(material, {}, "EXAMPLE/PROJECT.git.git")).stdout.includes(b.bearer),
    true,
  );
  const conflicting = await fill(material, { OCE_REPOSITORY_REF: "a" }, "example/other.git");
  assert.notEqual(conflicting.code, 0);
  assert.equal(conflicting.stdout, "");
  assert.equal((await fill(material, {}, "example/other")).stdout.includes(c.bearer), true);
});

test("embedded generation fails closed after replacement while local stock Git retains hooks and configuration", async (t) => {
  const original = opened("original");
  const material = await createNativeClientMaterial(t, [
    { opened: original, repositoryRef: "project" },
  ]);
  const work = await temporaryDirectory(t);
  const env = environment(material, {
    OCE_REPOSITORY_SELECTION: JSON.stringify(["0".repeat(64), "project", "stale"]),
    NATIVE_HOOK_MARKER: "normal-environment",
  });
  const git = (args, options = {}) => run("/usr/bin/git", args, { env, cwd: work, ...options });
  await git(["init"]);
  await git(["config", "user.name", "Native fixture"]);
  await git(["config", "user.email", "fixture@example.test"]);
  const marker = join(work, "hook-result");
  await writeFile(
    join(work, ".git/hooks/pre-commit"),
    `#!/bin/sh\nprintf '%s' "$NATIVE_HOOK_MARKER" > '${marker}'\n`,
    { mode: 0o700 },
  );
  await writeFile(join(work, "file.txt"), "native content\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-m", "Native hook"]);
  assert.equal(await readFile(marker, "utf8"), "normal-environment");
  await git(["mv", "file.txt", "moved.txt"]);
  await git(["commit", "-m", "Native move"]);
  await git(["rm", "moved.txt"]);
  await git(["commit", "-m", "Native removal"]);
  await git(["config", "alias.native-status", "status --short"]);
  assert.equal((await git(["native-status"])).stdout.trim(), "?? hook-result");
  const linked = join(work, "linked");
  await git(["worktree", "add", "--detach", linked]);
  assert.equal(
    (await git(["-C", linked, "log", "-1", "--format=%s"])).stdout.trim(),
    "Native removal",
  );
  await git(["remote", "add", "origin", "https://github.com/ExAmPlE/PrOjEcT"]);
  await git(["remote", "set-url", "--push", "origin", "https://github.com/example/other.git"]);
  assert.equal(
    (await git(["remote", "get-url", "origin"])).stdout.trim(),
    "https://credentials.example.test/ExAmPlE/PrOjEcT",
  );
  assert.equal(
    (await git(["remote", "get-url", "--push", "origin"])).stdout.trim(),
    "https://credentials.example.test/example/other.git",
  );
  assert.notEqual(
    (await fill(material, { OCE_REPOSITORY_SELECTION: env.OCE_REPOSITORY_SELECTION })).code,
    0,
  );
  // New material is valid in isolation but cannot be selected by the old emitted helper command.
  const replacement = opened("replacement");
  const next = await createNativeClientMaterial(t, [
    { opened: replacement, repositoryRef: "project" },
  ]);
  const oldConfig = await readFile(join(material.root, "gitconfig"), "utf8");
  const newManifest = {
    ...next.manifest,
    bindings: next.manifest.bindings.map((binding) => ({
      ...binding,
      directory: binding.directory.replace(next.root, material.root),
    })),
  };
  // Install a fully valid next generation; only the old helper generation pin must reject it.
  await cp(join(next.root, "sessions"), join(material.root, "sessions"), { recursive: true });
  newManifest.generation = hash(
    newManifest.bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId]),
  );
  await writeFile(join(material.root, "manifest.json"), JSON.stringify(newManifest), {
    mode: 0o600,
  });
  assert.equal(await readFile(join(material.root, "gitconfig"), "utf8"), oldConfig);
  const current = await readRuntimeRepositoryManifest(material.root);
  assert.equal(current.generation, next.manifest.generation);
  const acceptedNew = await run(
    process.execPath,
    [material.helper, "manifest", material.root, current.generation, "get"],
    { env: cleanEnvironment(), input: protocol() },
  );
  assert.equal(acceptedNew.stdout.includes(replacement.bearer), true);
  const rejected = await fill(material);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.stdout, "");
  assert.equal((await git(["log", "-1", "--format=%s"])).stdout.trim(), "Native removal");
});

test("gh selection retains private configuration and exact pins without suppressing native system Git", async (t) => {
  const first = opened("first");
  const second = opened("second", "example/other");
  const material = await createNativeClientMaterial(t, [
    { opened: first, repositoryRef: "first" },
    { opened: second, repositoryRef: "second" },
  ]);
  const manifest = await readRuntimeRepositoryManifest(material.root);
  const gh = parseGhInvocation(["api", "repos/ExAmPlE/OTHER"]);
  const selected = selectGhRepository(manifest, gh.target.value);
  assert.equal(selected.sessionId, "second");
  assert.throws(
    () => selectGhRepository(manifest, gh.target.value, manifest.bindings[0]),
    /conflicting-repository-selection/,
  );
  assert.throws(
    () => parseGhInvocation(["api", "https://api.github.com/repos/example/project"]),
    /unsupported-client-command/,
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
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  const hosts = await readFile(join(env.GH_CONFIG_DIR, "hosts.yml"), "utf8");
  assert.equal(hosts.includes(second.bearer), true);
  const router = resolve("apps/controller/src/drivers/repo/github/credentials/client/router.ts");
  const rejected = await run(process.execPath, [router, "git", "status"], {
    env: cleanEnvironment(),
    allowFailure: true,
  });
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.stderr, "unsupported-client-command\n");

  // Rejection happens before private material is read or a native child starts.
  // These forms could change hosts, select an implicit branch, launch a browser,
  // mutate beyond the supported surface, or trigger gh's push/fork workflow.
  for (const args of [
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
  ]) {
    const denied = await run(process.execPath, [router, "gh", ...args], {
      env: cleanEnvironment(),
      allowFailure: true,
    });
    assert.equal(denied.code, 1, JSON.stringify(args));
    assert.equal(denied.stdout, "");
    assert.equal(denied.stderr, "unsupported-client-command\n", JSON.stringify(args));
  }

  const viewed = parseGhInvocation(["repo", "view", "github.com/example/other"]);
  assert.equal(selectGhRepository(manifest, viewed.target.value).sessionId, "second");
  assert.throws(
    () => selectGhRepository(manifest, viewed.target.value, manifest.bindings[0]),
    /conflicting-repository-selection/,
  );
});
