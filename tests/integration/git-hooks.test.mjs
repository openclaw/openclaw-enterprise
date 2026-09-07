import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function createRepositoryFixture(t, { initializeGit = true } = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openclaw-enterprise-git-hooks-"));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await mkdir(join(fixtureRoot, "scripts"));
  await mkdir(join(fixtureRoot, ".githooks"));
  await copyFile(
    join(repositoryRoot, "scripts/install-git-hooks.mjs"),
    join(fixtureRoot, "scripts/install-git-hooks.mjs"),
  );
  await copyFile(
    join(repositoryRoot, ".githooks/pre-push"),
    join(fixtureRoot, ".githooks/pre-push"),
  );

  if (initializeGit) {
    const initialize = spawnSync("git", ["init", "--quiet"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(initialize.status, 0, initialize.stderr);
  }

  return fixtureRoot;
}

function installHooks(fixtureRoot) {
  return spawnSync(process.execPath, ["scripts/install-git-hooks.mjs"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
}

test("automatic installation skips packaged environments without a Git checkout", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t, { initializeGit: false });

  const automaticInstallation = spawnSync(
    process.execPath,
    ["scripts/install-git-hooks.mjs", "--if-git-present"],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
  assert.equal(automaticInstallation.status, 0, automaticInstallation.stderr);
  assert.match(automaticInstallation.stdout, /Skipping Git hook installation/);

  const explicitInstallation = installHooks(fixtureRoot);
  assert.notEqual(explicitInstallation.status, 0);
  assert.match(explicitInstallation.stderr, /outside a Git checkout/);
});

test("hook installation preserves core.hooksPath and is safely repeatable", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const protectedHooksPath = join(fixtureRoot, "protected-organization-hooks");
  const configureProtectedHooks = spawnSync(
    "git",
    ["config", "core.hooksPath", protectedHooksPath],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
  assert.equal(configureProtectedHooks.status, 0, configureProtectedHooks.stderr);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = installHooks(fixtureRoot);
    assert.equal(result.status, 0, result.stderr);
  }

  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  assert.equal(
    await readFile(nativeHookPath, "utf8"),
    await readFile(join(fixtureRoot, ".githooks/pre-push"), "utf8"),
  );
  assert.notEqual((await stat(nativeHookPath)).mode & 0o111, 0);

  const currentHooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(currentHooksPath.status, 0, currentHooksPath.stderr);
  assert.equal(currentHooksPath.stdout.trim(), protectedHooksPath);
});

test("hook installation refuses to replace an existing unmanaged native hook", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  const unmanagedHook = "#!/bin/sh\n# Existing user-managed pre-push hook\nexit 0\n";
  await writeFile(nativeHookPath, unmanagedHook);
  await chmod(nativeHookPath, 0o755);

  const result = installHooks(fixtureRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unmanaged.*pre-push/i);
  assert.equal(await readFile(nativeHookPath, "utf8"), unmanagedHook);
  assert.notEqual((await stat(nativeHookPath)).mode & 0o111, 0);
});

test("the native pre-push hook runs installed Prettier directly and blocks formatting failures", async (t) => {
  const { format } = await import("prettier");
  const fixtureRoot = await createRepositoryFixture(t);
  const install = installHooks(fixtureRoot);
  assert.equal(install.status, 0, install.stderr);

  for (const filename of [".prettierrc.json", ".prettierignore"]) {
    await copyFile(join(repositoryRoot, filename), join(fixtureRoot, filename));
  }
  const formattingOptions = JSON.parse(
    await readFile(join(fixtureRoot, ".prettierrc.json"), "utf8"),
  );

  const binariesPath = join(fixtureRoot, "bin");
  await mkdir(binariesPath);
  await symlink(process.execPath, join(binariesPath, "node"));
  await mkdir(join(fixtureRoot, "node_modules"));
  const prettierDirectory = join(fixtureRoot, "node_modules/prettier");
  await symlink(
    dirname(fileURLToPath(import.meta.resolve("prettier/package.json"))),
    prettierDirectory,
    "dir",
  );
  const packageManagerPath = join(binariesPath, "pnpm");
  await writeFile(
    packageManagerPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$PACKAGE_MANAGER_INVOCATION_LOG"\nexit 97\n',
  );
  await chmod(packageManagerPath, 0o755);

  const packageManagerInvocationLog = join(fixtureRoot, "pnpm-invocation.log");
  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  const environment = {
    ...process.env,
    PATH: `${binariesPath}${delimiter}${process.env.PATH ?? ""}`,
    PACKAGE_MANAGER_INVOCATION_LOG: packageManagerInvocationLog,
  };
  const runHook = () =>
    spawnSync(nativeHookPath, ["origin", "https://example.test/repository"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: environment,
    });

  const cases = [
    ["packages/utils/src/example.ts", "export const answer={value:42};\n"],
    ["package.json", '{ "name":"hook-fixture","private":true }\n'],
    ["apps/console/public/index.html", "<!doctype html><html><body><p>Example</p></body></html>\n"],
    ["apps/console/public/styles.css", "body{color:red}\n"],
    ["docs/guides/example.md", "# Example\n\n-   item\n"],
    [".github/workflows/check.yml", "name: Checks\non: [ push,pull_request ]\n"],
    [
      ".github/actions/example/action.yml",
      "name: Example\ndescription: Example\nruns: {using: composite,steps: []}\n",
    ],
  ];
  for (const [relativePath, unformatted] of cases) {
    const path = join(fixtureRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await format(unformatted, { ...formattingOptions, filepath: path }));
  }

  // Generated API documentation is checked by openapi:check, not Prettier.
  const generatedPath = join(fixtureRoot, "docs/reference/api.md");
  const generatedContent = "# Generated API\n\n-   generated entry\n";
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, generatedContent);
  const baseline = runHook();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);

  for (const [relativePath, unformatted] of cases) {
    await t.test(relativePath, async () => {
      const path = join(fixtureRoot, relativePath);
      const formatted = await readFile(path, "utf8");
      try {
        await writeFile(path, unformatted);
        const rejected = runHook();
        assert.equal(
          rejected.status,
          1,
          `Expected ${relativePath} to block the push.\n${rejected.stdout}${rejected.stderr}`,
        );
        assert.ok(rejected.stderr.includes(relativePath), rejected.stderr);
      } finally {
        await writeFile(path, formatted);
      }
      const accepted = runHook();
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    });
  }
  assert.equal(await readFile(generatedPath, "utf8"), generatedContent);

  await rm(prettierDirectory);
  const missingPrettier = spawnSync(nativeHookPath, [], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(missingPrettier.status, 1);
  assert.match(missingPrettier.stderr, /installed Prettier executable is unavailable/);
  await assert.rejects(stat(packageManagerInvocationLog), { code: "ENOENT" });
});
