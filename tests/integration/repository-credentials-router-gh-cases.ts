import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it as test } from "node:test";
import { parseGhInvocation } from "../../apps/controller/src/drivers/repo/github/access/client/commands.ts";
import { createClientEnvironment } from "../../apps/controller/src/drivers/repo/github/access/client/environment.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
} from "../../apps/controller/src/drivers/repo/github/access/client/manifest.ts";
import {
  selectGhRepository,
  selectImplicitGhRepository,
} from "../../apps/controller/src/drivers/repo/github/access/client/targets.ts";
import { temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import {
  clean,
  exec,
  gitWith,
  nativeMaterial,
  opened,
  pin,
  settle,
} from "./repository-credentials-router-fixture.ts";

export function registerGhCases() {
  test("gh selection retains private configuration and exact pins without suppressing native system Git", async (t) => {
    const first = opened("first");
    const second = opened("second", { repository: "example/other" });
    const material = await nativeMaterial(t, ["first", first], ["second", second]);
    const manifest = await readRuntimeRepositoryManifest(material.root);
    const gh = parseGhInvocation(["api", "repos/ExAmPlE/OTHER"]);
    assert.ok(gh.target);
    const selected = selectGhRepository(manifest, gh.target.value);
    assert.equal(selected.sessionId, "second");
    const target = gh.target.value;
    const [firstBinding] = manifest.bindings;
    const secondBinding = material.manifest.bindings[1];
    assert.ok(firstBinding);
    assert.ok(secondBinding);
    assert.throws(
      () => selectGhRepository(manifest, target, firstBinding),
      /conflicting-repository-selection/,
    );
    for (const args of [
      ["repo", "view", "github.com/project"],
      ["api", "repos/github.com/project"],
    ]) {
      const invocation = parseGhInvocation(args);
      const target = invocation.target?.value;
      assert.equal(target, "github.com/project");
      assert.throws(() => selectGhRepository(manifest, target), {
        message: "unsupported-repository-target",
      });
    }
    for (const endpoint of [
      "https://api.github.com/repos/example/project",
      // The gateway refuses any escape in a path, so the client refuses it first.
      "repos/example/project/%2e%2e/other",
      "repos/example/project/contents/a%2Fb",
    ]) {
      assert.throws(() => parseGhInvocation(["api", endpoint]), /unsupported-client-command/);
    }
    assert.equal(
      parseGhInvocation(["api", "repos/example/project/issues?labels=a%20b"]).target?.value,
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
          OCE_REPOSITORY_SELECTION: pin(material, secondBinding),
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
    assert.ok(env.GH_CONFIG_DIR);
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
    assert.ok(viewed.target);
    const viewedTarget = viewed.target.value;
    assert.equal(selectGhRepository(manifest, viewedTarget).sessionId, "second");
    assert.throws(
      () => selectGhRepository(manifest, viewedTarget, firstBinding),
      /conflicting-repository-selection/,
    );

    const router = resolve("apps/controller/src/drivers/repo/github/access/client/router.ts");
    const route = (args: string[]) =>
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
}
