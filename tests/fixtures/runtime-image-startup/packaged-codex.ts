import type { codexRpc, list, parseJson, record, text } from "./wire.ts";

export async function probePackagedCodex(
  {
    historicalCodex,
    stagingCodexVersion,
    deadlineMs,
    expectedPatches,
  }: {
    historicalCodex: boolean;
    stagingCodexVersion: string;
    deadlineMs: number;
    expectedPatches?: Readonly<Record<string, string>>;
  },
  codexExecutableSource: string,
  createRpc: typeof codexRpc,
  asList: typeof list,
  parse: typeof parseJson,
  read: typeof record,
  asText: typeof text,
) {
  const assert: typeof import("node:assert/strict") =
    process.getBuiltinModule("node:assert/strict");
  const { createHash } = process.getBuiltinModule("node:crypto");
  const { createRequire } = process.getBuiltinModule("node:module");
  const { dirname, relative, resolve } = process.getBuiltinModule("node:path");
  const { realpathSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { execFileSync } = process.getBuiltinModule("node:child_process");
  const plugin = createRequire("/app/dist/extensions/codex/package.json");
  const installed = plugin.resolve("@openai/codex/package.json");
  assert.equal(read(parse(readFileSync(installed, "utf8"))).version, stagingCodexVersion);
  const bundledCommand = plugin.resolve("@openai/codex/bin/codex.js");
  assert.equal(realpathSync("/app/node_modules/.bin/codex"), realpathSync(bundledCommand));
  assert.equal(
    execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    "codex-cli " + stagingCodexVersion,
  );
  assert.equal(
    execFileSync(process.execPath, [bundledCommand, "--version"], { encoding: "utf8" }).trim(),
    "codex-cli " + stagingCodexVersion,
  );
  const provenance = read(parse(readFileSync("/opt/oce/runtime/provenance.json", "utf8")));
  if (!historicalCodex) {
    // The manifest is from the tested checkout; the binary and its ABI are read
    // inside the built image, independently of its recorded provenance.
    const expectedNode = read(parse(asText(process.argv[3])));
    assert.equal(process.versions.node, expectedNode.version);
    assert.equal(process.versions.modules, expectedNode.modules);
    assert.equal(process.versions.napi, expectedNode.napi);
    assert.deepEqual(provenance.node, {
      source: "https://github.com/nodejs/node",
      ...expectedNode,
      version: process.versions.node,
      architecture: process.arch,
      platform: process.platform,
      modules: process.versions.modules,
      napi: process.versions.napi,
      icu: process.versions.icu,
      executable: "/usr/local/bin/node",
      sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
    });
  }
  assert.equal(provenance.source, "https://github.com/openclaw/openclaw");
  const expectedSource = read(parse(asText(process.argv[2])));
  assert.equal(typeof expectedSource.commit, "string");
  assert.equal(typeof expectedSource.sourceArchiveSha256, "string");
  assert.equal(provenance.commit, expectedSource.commit);
  assert.equal(provenance.sourceArchiveSha256, expectedSource.sourceArchiveSha256);
  assert.equal(
    provenance.openclawBridgePatchSha256,
    "f8d1e51706f59964839d231818909ffb2ee5f6b951385a353a1a4fd07c45e2cc",
  );
  assert.equal(Object.hasOwn(provenance, "openclawConnectPatchSha256"), false);
  if (historicalCodex) {
    assert.equal(
      provenance.codexDependencyPinPatchSha256,
      "d7eea3944eaaf4469ede0261d4f706148cd672f29f1efedd59e325c46c90d119",
    );
  } else {
    assert.equal(Object.hasOwn(provenance, "codexDependencyPinPatchSha256"), false);
  }
  if (historicalCodex) {
    assert.equal(
      provenance.openclawRequiredWorkerAuthorityRegressionPatchSha256,
      "4d7b31957dab6e8427eeb9a8cce0a8013f0f96b999e2692fdd6903595c3c4804",
    );
  } else {
    assert.equal(
      Object.hasOwn(provenance, "openclawRequiredWorkerAuthorityRegressionPatchSha256"),
      false,
    );
  }
  if (historicalCodex) {
    assert.deepEqual(provenance.patches, {
      "openclaw-codex-read-only-paths.patch": provenance.openclawBridgePatchSha256,
      "openclaw-codex-full-access-profile.patch":
        "7c95a5a3727bd4c73bb9ccf3022eb4b33d182cd7f6b761dc93ecfe08ef08e27a",
      "openclaw-google-worker-placeholder.patch":
        "55be2c531b9335da06799f934200bb34a4fbc98608d4433ca6e955bbe966af31",
      "openclaw-required-worker-authority-regression.patch":
        provenance.openclawRequiredWorkerAuthorityRegressionPatchSha256,
      "openclaw-control-ui-browser-reconnect.patch":
        "f281242922bcd1e3349aef18e24d77e95ddf3e3d1dacbea30b26c759e0f5f947",
      "openclaw-terminated-gateway-namespace.patch":
        "570fb99e849442793eeb0e59417b4b4b2b282e7d236392a022258753b353263b",
      "stock-codex-0.163.0-alpha.2-dependency-pin.patch":
        "d7eea3944eaaf4469ede0261d4f706148cd672f29f1efedd59e325c46c90d119",
    });
  } else {
    assert.ok(expectedPatches && Object.keys(expectedPatches).length > 0);
    assert.deepEqual(provenance.patches, expectedPatches);
  }
  assert.equal(read(provenance.codex).version, stagingCodexVersion);
  assert.equal(Object.hasOwn(provenance, "codexPatchSha256"), false);
  assert.equal(Object.hasOwn(provenance, "codexVersion"), false);
  const contents = readFileSync("/opt/oce/runtime/contents.json");
  const inventory = asList(parse(contents.toString("utf8")));
  assert.equal(
    createHash("sha256").update(contents).digest("hex"),
    provenance.runtimeContentsSha256,
  );
  function readPnpmIntegrity(lockfile: string, packageName: string, version: string) {
    const key = "  '" + packageName + "@" + version + "':";
    const start = lockfile.indexOf(key);
    assert.notEqual(start, -1, "missing lockfile entry for " + packageName + "@" + version);
    const rest = lockfile.slice(start + key.length);
    const nextPackage = rest.search(/\n {2}'[^']+@[^']+':/);
    const block = nextPackage === -1 ? rest : rest.slice(0, nextPackage);
    const match = block.match(/\n\s+resolution: \{integrity: ([^}]+)\}/);
    assert.ok(match, "missing lockfile integrity for " + packageName + "@" + version);
    return asText(match[1]);
  }
  const platformByArchitecture = {
    x64: {
      packageName: "@openai/codex-linux-x64",
      packageDirectory: "codex-linux-x64",
      binaryPath: "vendor/x86_64-unknown-linux-musl/bin/codex",
      targetArch: "amd64",
    },
    arm64: {
      packageName: "@openai/codex-linux-arm64",
      packageDirectory: "codex-linux-arm64",
      binaryPath: "vendor/aarch64-unknown-linux-musl/bin/codex",
      targetArch: "arm64",
    },
  };
  assert.ok(
    process.arch === "x64" || process.arch === "arm64",
    "Unsupported runtime test architecture: " + process.arch,
  );
  const platform = platformByArchitecture[process.arch];
  assert.equal(
    Object.hasOwn(provenance, "codexBrokerPolicy"),
    false,
    "stock runtime must not carry patched Codex provenance",
  );
  const codexPackageRoot = dirname(plugin.resolve("@openai/codex/package.json"));
  const codexPackage = read(parse(readFileSync(resolve(codexPackageRoot, "package.json"), "utf8")));
  const platformPackageRoot = resolve(codexPackageRoot, "..", platform.packageDirectory);
  const platformPackage = read(
    parse(readFileSync(resolve(platformPackageRoot, "package.json"), "utf8")),
  );
  const platformBinary = resolve(platformPackageRoot, platform.binaryPath);
  // Login and the model check spawn codexExecutable() so a timeout's SIGKILL ends native
  // Codex, not just the npm launcher (finding 2274). Run the generated helper on this
  // image's PATH: a shim in place of the launcher symlink would make it fall back.
  const { runInThisContext } = process.getBuiltinModule("node:vm");
  const locate: unknown = runInThisContext(
    "(function(require) { " + codexExecutableSource + "; return codexExecutable(); })",
  );
  assert.ok(typeof locate === "function");
  const locateCodex = locate as (requireModule: NodeJS.Require) => unknown;
  const harnessCodex = asText(locateCodex(createRequire(process.cwd() + "/[eval]")));
  assert.ok(
    harnessCodex.startsWith("/"),
    "codexExecutable() fell back to " + harnessCodex + " on PATH " + process.env.PATH,
  );
  assert.equal(realpathSync(harnessCodex), realpathSync(platformBinary));
  const platformBinarySha256 = createHash("sha256")
    .update(readFileSync(platformBinary))
    .digest("hex");
  const platformInventoryPath = relative(
    "/app/node_modules/openclaw",
    realpathSync(platformBinary),
  );
  assert.ok(
    !platformInventoryPath.startsWith(".."),
    "Codex platform binary must live under the inventoried OpenClaw package root.",
  );
  const lockfile = readFileSync("/app/node_modules/openclaw/pnpm-lock.yaml", "utf8");
  assert.deepEqual(provenance.codex, {
    source: "npm:@openai/codex",
    version: codexPackage.version,
    packageIntegrity: readPnpmIntegrity(lockfile, "@openai/codex", asText(codexPackage.version)),
    package: platform.packageName,
    packageVersion: platformPackage.version,
    platformPackageIntegrity: readPnpmIntegrity(
      lockfile,
      "@openai/codex",
      asText(platformPackage.version),
    ),
    architecture: platform.targetArch,
    installedBinary: relative("/app/node_modules/openclaw", platformBinary),
    resolvedBinary: platformInventoryPath,
    binarySha256: platformBinarySha256,
  });
  const platformInventoryEntry = inventory
    .map(read)
    .find((entry) => entry.path === platformInventoryPath);
  assert.ok(
    platformInventoryEntry,
    "The final runtime inventory must include the stock Codex platform binary.",
  );
  assert.equal(
    (Number(platformInventoryEntry.mode) & 0o111) !== 0,
    true,
    "Codex platform binary must stay executable.",
  );
  assert.equal(platformInventoryEntry.sha256, platformBinarySha256);
  // Codex runs its bundled bubblewrap. A bwrap on PATH would make Codex probe
  // --unshare-user --unshare-net at start, which the reviewed seccomp profile
  // denies, and log a false user-namespace error.
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const bubblewrap = spawnSync("sh", ["-c", "command -v bwrap"], { stdio: "pipe" });
  assert.equal(bubblewrap.error, undefined);
  assert.equal(bubblewrap.signal, null);
  assert.ok(bubblewrap.status === 1 || bubblewrap.status === 127, "bwrap must be absent from PATH");

  // Install two real local bundles without credentials or model calls. Feature
  // enablement stays on, so only OCE's plugin policy can exclude their skills.
  const { mkdirSync, mkdtempSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { createInterface } = process.getBuiltinModule("node:readline");
  const { spawn } = process.getBuiltinModule("node:child_process");
  const root = mkdtempSync(resolve(tmpdir(), "oce-plugin-defaults-"));
  const codexHome = resolve(root, "codex-home");
  const workspace = resolve(root, "workspace");
  const marketplacePath = resolve(workspace, ".agents/plugins/marketplace.json");
  mkdirSync(codexHome);
  mkdirSync(dirname(marketplacePath), { recursive: true });
  mkdirSync(resolve(workspace, ".git"));
  writeFileSync(
    resolve(codexHome, "config.toml"),
    "[features]\nplugins = true\nremote_plugin = false\n",
  );
  const names = ["example", "unselected"];
  for (const name of names) {
    const source = resolve(workspace, name);
    mkdirSync(resolve(source, ".codex-plugin"), { recursive: true });
    mkdirSync(resolve(source, "skills/inspect"), { recursive: true });
    writeFileSync(
      resolve(source, ".codex-plugin/plugin.json"),
      JSON.stringify({ name, version: "1.0.0", skills: "./skills" }),
    );
    writeFileSync(
      resolve(source, "skills/inspect/SKILL.md"),
      "---\nname: inspect\ndescription: Inspect the example fixture\n---\n\nInspect this fixture.\n",
    );
  }
  writeFileSync(
    marketplacePath,
    JSON.stringify({
      name: "marketplace",
      plugins: names.map((name) => ({ name, source: { source: "local", path: "./" + name } })),
    }),
  );
  const native = spawn(platformBinary, ["app-server", "--listen", "stdio://"], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: native.stdout });
  const { request: rpc, fail } = createRpc(native, lines, parse, read);
  let stderr = "";
  native.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  native.once("error", fail);
  const closed = new Promise<void>((resolve) =>
    native.once("close", (code) => {
      fail(new Error("Native plugin proof exited " + code + ": " + stderr));
      resolve();
    }),
  );
  const deadline = setTimeout(() => {
    fail(new Error("Native plugin proof timed out: " + stderr));
    native.kill("SIGKILL");
  }, deadlineMs);
  try {
    await rpc("initialize", {
      clientInfo: { name: "oce-plugin-defaults-proof", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    // Production startup uses this experimental API. An empty query proves protocol
    // support without authentication, remote catalog access, or a model request.
    if (!historicalCodex) {
      const emptySearch = read(await rpc("plugin/search", { searchTerm: "" }));
      assert.deepEqual(emptySearch.data, []);
      assert.equal(emptySearch.nextCursor ?? null, null);
    }
    for (const pluginName of names) {
      await rpc("plugin/install", { marketplacePath, pluginName });
    }
    const defaultPolicy = read(parse(asText(process.argv[1])));
    for (const stage of ["installed", "default-off", "selected"]) {
      // Local installation is registered in config. Retain those registrations
      // without activation grants, proving omitted enablement inherits OCE's default.
      if (stage !== "installed") {
        await rpc("config/batchWrite", {
          edits: [
            {
              keyPath: "plugins",
              mergeStrategy: "replace",
              value: {
                ...defaultPolicy,
                "example@marketplace": stage === "selected" ? { enabled: true } : {},
                "unselected@marketplace": {},
              },
            },
          ],
          reloadUserConfig: true,
        });
      }
      const enabledNames = stage === "installed" ? names : stage === "selected" ? ["example"] : [];
      const catalog = read(
        await rpc("plugin/list", { cwds: [workspace], marketplaceKinds: ["local"] }),
      );
      const marketplace = asList(catalog.marketplaces)
        .map(read)
        .find((entry) => entry.path === marketplacePath);
      assert.ok(marketplace, "Expected local marketplace");
      const entries = asList(marketplace.plugins).map(read);
      assert.deepEqual(
        entries
          .map(({ name, installed, enabled }) => ({ name: asText(name), installed, enabled }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        names.map((name) => ({ name, installed: true, enabled: enabledNames.includes(name) })),
      );
      const skills = read(await rpc("skills/list", { cwds: [workspace], forceReload: true }));
      const fixtureSkills = asList(skills.data)
        .flatMap((entry) => asList(read(entry).skills))
        .map(read)
        .filter((skill) => names.some((name) => asText(skill.name).startsWith(name + ":")))
        .map(({ name, pluginId }) => ({ name: asText(name), pluginId }));
      assert.deepEqual(
        fixtureSkills.sort((a, b) => a.name.localeCompare(b.name)),
        enabledNames.map((name) => ({ name: name + ":inspect", pluginId: name + "@marketplace" })),
      );
    }
    process.stdout.write("shared-reviewed-codex-ready\n");
  } finally {
    clearTimeout(deadline);
    lines.close();
    native.kill("SIGTERM");
    await closed;
  }
}
