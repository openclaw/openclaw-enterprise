import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { commandCalls, commandPath, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repository, "scripts/upgrade-preflight-state.py");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function writePrivate(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function fixture(t: TestContext, sourceRepository = repository) {
  const stateScript = join(sourceRepository, "scripts/upgrade-preflight-state.py");
  const parent = temporaryDirectorySync(t, "upgrade-preflight-state-");
  const root = join(realpathSync(parent), "evidence");
  mkdirSync(root, { mode: 0o700 });
  const kubeconfig = join(parent, "kubeconfig");
  writePrivate(kubeconfig, { context: "fixture" });
  const info = statSync(root);
  const parameters = {
    evidenceDirectory: { path: root, st_dev: info.dev, st_ino: info.ino },
    arguments: [kubeconfig, "fixture", "control", "team", ...Array.from({ length: 11 }, () => "")],
    kubeconfigSha256: sha256(kubeconfig),
    profiled: false,
    scriptSha256: sha256(join(sourceRepository, "scripts/upgrade-production-images")),
    startupPreflightSha256: sha256(join(sourceRepository, "scripts/upgrade-startup-preflight.ts")),
    selectedImageMigrationSha256: sha256(
      join(sourceRepository, "scripts/lib/selected-image-migration.ts"),
    ),
    selectedImageMigrationProgramSha256: sha256(
      join(sourceRepository, "deploy/helm/openclaw-enterprise/files/migrate-selected-image.cjs"),
    ),
    preflightStateSha256: sha256(stateScript),
    preflightCleanupSha256: sha256(
      join(sourceRepository, "scripts/lib/upgrade-preflight-cleanup.sh"),
    ),
  };
  writePrivate(join(root, "parameters.json"), parameters);
  const invoke = (
    action: string,
    args: readonly string[] = [],
    options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
  ) =>
    spawnSync("python3", [stateScript, action, root, ...args], {
      ...options,
      encoding: "utf8",
    });
  const success = (action: string, args: readonly string[] = []) => {
    const result = invoke(action, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  success("init");
  const inspect = () => invoke("inspect", parameters.arguments.slice(0, 4));
  return { root, parent, invoke, success, inspect, parameters };
}

function acknowledgedJob(state: ReturnType<typeof fixture>) {
  state.success("register", [".", "abcd0123", "false"]);
  state.success("started", [".", "api"]);
  const path = join(state.root, "preflight-api-identity.json");
  writePrivate(path, {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "original-job-uid",
  });
  return path;
}

test("a published ACK survives its exact staging link, but rejects extra hardlinks", (t) => {
  const state = fixture(t);
  const receipt = acknowledgedJob(state);
  // A stopped publisher may have linked the final name without unlinking staging.
  linkSync(receipt, join(state.root, ".preflight-api-identity.json.tmp"));
  const accepted = state.inspect();
  assert.equal(accepted.status, 0, accepted.stderr);
  const { resources } = record(JSON.parse(accepted.stdout));
  assert.ok(Array.isArray(resources));
  assert.equal(resources.length, 1);
  linkSync(receipt, join(state.root, "unrelated-link"));
  const refused = state.inspect();
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, "");
});

test("a missing registered migration plan refuses all cleanup authority", (t) => {
  const state = fixture(t);
  acknowledgedJob(state);
  const attempt = "migration-preflight-resume.ABCD1234";
  mkdirSync(join(state.root, attempt), { mode: 0o700 });
  state.success("register", [attempt, "abcd4567", "false"]);
  rmSync(join(state.root, attempt, "preflight-plan.json"));
  // A valid startup receipt cannot turn a missing later consumer plan into success.
  const result = state.inspect();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("directory locking lasts through the caller's inherited descriptor lifetime", (t) => {
  const state = fixture(t);
  const first = openSync(state.root, "r");
  const second = openSync(state.root, "r");
  t.after(() => closeSync(second));
  const lock = (fd: number) =>
    state.invoke("lock", ["3"], { stdio: ["ignore", "pipe", "pipe", fd] });
  try {
    assert.equal(lock(first).status, 0);
    // The Python helper has exited, but the invoking shell's open description lives.
    assert.notEqual(lock(second).status, 0);
  } finally {
    closeSync(first);
  }
  assert.equal(lock(second).status, 0);
});

test("a parent directory alias preserves physical evidence binding; a leaf alias does not", (t) => {
  const state = fixture(t);
  const alias = join(state.parent, "parent-alias");
  symlinkSync(state.parent, alias, "dir");
  const inspectAt = (root: string) =>
    spawnSync("python3", [script, "inspect", root, ...state.parameters.arguments.slice(0, 4)], {
      encoding: "utf8",
    });
  const parentAlias = inspectAt(join(alias, "evidence"));
  assert.equal(parentAlias.status, 0, parentAlias.stderr);
  const leaf = join(state.parent, "evidence-alias");
  symlinkSync(state.root, leaf, "dir");
  assert.notEqual(inspectAt(leaf).status, 0);
});

test("unplanned known slots in a migration attempt cannot be silently ignored", (t) => {
  const state = fixture(t);
  const attempt = "migration-preflight-resume.ABCD1234";
  mkdirSync(join(state.root, attempt), { mode: 0o700 });
  state.success("register", [attempt, "abcd4567", "false"]);
  const unexpected = join(state.root, attempt, "preflight-secret-identity.json");
  writePrivate(unexpected, { kind: "secret", name: "unplanned", uid: "unknown" });
  const result = state.inspect();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

for (const attempt of [
  ".",
  "migration-preflight-resume.ABCD1234",
  "upgrade-preflight-resume.ABCD1234",
]) {
  test(`create evidence outside the attempt index is refused for ${attempt}`, (t) => {
    const state = fixture(t);
    const path = attempt === "." ? state.root : join(state.root, attempt);
    if (attempt !== ".") {
      mkdirSync(path, { mode: 0o700 });
    }
    state.success("register", [attempt, "abcd0123", "false"]);
    const slot = attempt.startsWith("migration-") ? "migration" : "api";
    state.success("started", [attempt, slot]);
    const startedPath = join(path, `preflight-${slot}-started.json`);
    const started: unknown = JSON.parse(readFileSync(startedPath, "utf8"));
    rmSync(startedPath);
    const journalPath = join(state.root, "preflight-journal.json");
    const journal = record(JSON.parse(readFileSync(journalPath, "utf8")));
    const attempts = record(journal.attempts);
    delete attempts[attempt];
    writePrivate(journalPath, journal);

    // A crash after plan publication and before registration has no create boundary.
    const planOnly = state.inspect();
    assert.equal(planOnly.status, 0, planOnly.stderr);
    assert.deepEqual(record(JSON.parse(planOnly.stdout)).resources, []);

    // A lost index entry must not conceal a visible create boundary or acknowledgement.
    const acknowledgement = {
      kind: "job.batch",
      name: `team-upgrade-preflight-${slot}-abcd0123`,
      uid: "created-job-uid",
    };
    const facts: [path: string, value: unknown][] = [
      [startedPath, started],
      [join(path, `preflight-${slot}-identity.json`), acknowledgement],
      [
        join(path, `preflight-${slot}-pod-identity.json`),
        {
          kind: "pod",
          name: "created-child",
          uid: "created-child-uid",
        },
      ],
      // The fixed ACK staging name is also written only after a create response.
      [join(path, `.preflight-${slot}-identity.json.tmp`), acknowledgement],
    ];
    for (const [factPath, value] of facts) {
      writePrivate(factPath, value);
      const refused = state.inspect();
      assert.notEqual(refused.status, 0, factPath);
      assert.equal(refused.stdout, "");
      rmSync(factPath);
    }
  });
}

test("a registered staged ACK requires its create boundary and never grants cleanup authority", (t) => {
  const state = fixture(t);
  state.success("register", [".", "abcd0123", "false"]);
  writePrivate(join(state.root, ".preflight-api-identity.json.tmp"), {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "created-job",
  });
  const contradictory = state.inspect();
  assert.notEqual(contradictory.status, 0);
  assert.equal(contradictory.stdout, "");

  // Stopping after create and during ACK publication is legitimate, but its UID is not authoritative.
  state.success("started", [".", "api"]);
  const unknown = state.inspect();
  assert.equal(unknown.status, 0, unknown.stderr);
  const result = record(JSON.parse(unknown.stdout));
  assert.deepEqual(result.resources, []);
  assert.deepEqual(result.unknown, [".:api"]);
  assert.equal(result.consumerUnknown, true);
});

for (const attempt of [".", "migration-preflight-resume.ABCD1234"]) {
  test(`staged ACKs for excluded slots are rejected in ${attempt}`, (t) => {
    const state = fixture(t);
    const path = attempt === "." ? state.root : join(state.root, attempt);
    if (attempt !== ".") {
      mkdirSync(path, { mode: 0o700 });
    }
    state.success("register", [attempt, "abcd0123", "false"]);
    const slot = attempt === "." ? "networkpolicy" : "secret";
    writePrivate(join(path, `.preflight-${slot}-identity.json.tmp`), { uid: "unexpected" });
    const result = state.inspect();
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  });
}

test("a staged child ACK requires an acknowledged parent and cannot substitute for a child receipt", (t) => {
  const state = fixture(t);
  state.success("register", [".", "abcd0123", "false"]);
  state.success("started", [".", "api"]);
  writePrivate(join(state.root, ".preflight-api-pod-identity.json.tmp"), {
    kind: "pod",
    name: "created-child",
    uid: "created-child-uid",
  });
  const contradictory = state.inspect();
  assert.notEqual(contradictory.status, 0);
  assert.equal(contradictory.stdout, "");

  // A known Job permits owner-based child discovery, but the staged child itself is not an ACK.
  writePrivate(join(state.root, "preflight-api-identity.json"), {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "created-job",
  });
  const accepted = state.inspect();
  assert.equal(accepted.status, 0, accepted.stderr);
  const { resources, children } = record(JSON.parse(accepted.stdout));
  assert.ok(Array.isArray(resources));
  assert.equal(resources.length, 1);
  assert.deepEqual(children, []);
});

test("a final ACK rejects a conflicting staging file rather than ignoring it", (t) => {
  const state = fixture(t);
  acknowledgedJob(state);
  writePrivate(join(state.root, ".preflight-api-identity.json.tmp"), {
    kind: "job.batch",
    name: "team-upgrade-preflight-api-abcd0123",
    uid: "another-job",
  });
  const result = state.inspect();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("cleanup binds startup preflight dependencies before Kubernetes actions", async (t) => {
  const parent = temporaryDirectorySync(t, "upgrade-cleanup-source-");
  const checkout = join(parent, "checkout");
  const dependencies = [
    "scripts/lib/selected-image-migration.ts",
    "deploy/helm/openclaw-enterprise/files/migrate-selected-image.cjs",
  ];
  const sources = [
    "scripts/upgrade-production-images",
    "scripts/upgrade-startup-preflight.ts",
    "scripts/upgrade-preflight-state.py",
    "scripts/lib/upgrade-preflight-cleanup.sh",
    ...dependencies,
  ];
  for (const source of sources) {
    const destination = join(checkout, source);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repository, source), destination);
  }
  const state = fixture(t, checkout);
  acknowledgedJob(state);
  const bin = join(parent, "bin");
  mkdirSync(bin);
  const log = join(parent, "kubectl.log");
  await writeCommand(
    bin,
    "kubectl",
    `case "$*" in *" get pods "*) printf '{"items":[]}\\n' ;; esac\n`,
    { log },
  );
  const cleanup = () =>
    spawnSync(
      "/bin/bash",
      [
        join(checkout, "scripts/upgrade-production-images"),
        "--cleanup-preflight",
        "--kubeconfig",
        join(state.parent, "kubeconfig"),
        "--context",
        "fixture",
        "--namespace",
        "control",
        "--release",
        "team",
        "--evidence-dir",
        state.root,
        "--previous-process-settled",
        "--evidence-unrestored",
      ],
      { cwd: checkout, env: { ...process.env, PATH: commandPath(bin) }, encoding: "utf8" },
    );

  // The unchanged checkout must reach the real cleanup path and settle the
  // acknowledged Job before changed source can be proved to block that path.
  const accepted = cleanup();
  assert.equal(accepted.status, 0, accepted.stderr);
  const acceptedCalls = await commandCalls(log);
  assert.ok(acceptedCalls.some((call) => /delete --raw=.*jobs\//.test(call)));
  assert.ok(acceptedCalls.some((call) => /get pods -o json/.test(call)));

  for (const source of dependencies) {
    const path = join(checkout, source);
    const original = readFileSync(path);
    try {
      writeFileSync(
        path,
        Buffer.concat([original, Buffer.from("\n// changed after preparation\n")]),
      );
      const refused = cleanup();
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /original helper source/);
      assert.deepEqual(await commandCalls(log), acceptedCalls);
    } finally {
      writeFileSync(path, original);
    }
  }
});

for (const kind of ["fifo", "symlink-to-fifo"]) {
  test(`cleanup rejects ${kind} evidence before opening it or requiring tools`, (t) => {
    const parent = temporaryDirectorySync(t, "upgrade-preflight-fifo-");
    const fifo = join(parent, "fifo");
    const created = spawnSync(
      "python3",
      ["-c", "import os, sys; os.mkfifo(sys.argv[1], 0o600)", fifo],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
    );
    assert.equal(created.status, 0, created.stderr);
    const evidence = kind === "fifo" ? fifo : join(parent, "link");
    if (kind === "symlink-to-fifo") {
      symlinkSync(fifo, evidence);
    }
    // No writer opens the FIFO. Opening it before validation would block indefinitely.
    // An empty tool path proves invalid evidence does not require cluster tooling.
    const result = spawnSync(
      "/bin/bash",
      [
        join(repository, "scripts/upgrade-production-images"),
        "--cleanup-preflight",
        "--kubeconfig",
        join(parent, "unused-kubeconfig"),
        "--context",
        "fixture",
        "--namespace",
        "control",
        "--release",
        "team",
        "--evidence-dir",
        evidence,
        "--previous-process-settled",
        "--evidence-unrestored",
      ],
      {
        cwd: repository,
        env: { ...process.env, PATH: parent },
        encoding: "utf8",
        timeout: 2000,
        killSignal: "SIGKILL",
      },
    );
    assert.equal(result.error, undefined, "invalid evidence must be rejected without blocking");
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /evidence.*directory/i);
  });
}

test("profiled upgrade checks and recovery bind Kubernetes requests to the approved target", (t) => {
  const directory = temporaryDirectorySync(t, "upgrade-profiled-target-");
  // A local kubeconfig decoder checks the actual client input. The fixture records
  // and refuses Kubernetes and Helm requests before they leave the process.
  const result = spawnSync(
    "python3",
    [join(repository, "tests/fixtures/production-upgrade-target-control.py"), directory],
    {
      cwd: repository,
      encoding: "utf8",
      // The fixture owns per-case timeouts and reaps isolated command groups.
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

const proxyCanary = "fixture-proxy-private-canary";

function traceExposesPrivateValues(output: string, values: readonly string[]): boolean {
  return values.some((value) => value.length > 0 && output.includes(value));
}

test("CI tool launcher preserves proxy and certificate settings without exposing their values", (t) => {
  const directory = temporaryDirectorySync(t, "ci-tool-launcher-");
  const source = readFileSync(join(repository, "scripts/ci/setup-tools.sh"), "utf8");
  // Exercise the checked-in function without running unrelated tool setup.
  const launcher = source.match(/^run_system_tool\(\) \{\n[\s\S]*?^\}$/m)?.[0];
  assert.ok(launcher, "CI tool launcher function is missing");

  const proxy = syntheticCredentialUrl({
    username: "fixture-proxy-user",
    password: proxyCanary,
    host: "proxy.example.invalid",
  });
  const allowed = {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    ALL_PROXY: proxy,
    all_proxy: proxy,
    NO_PROXY: "private-fixture-bypass.invalid",
    no_proxy: "",
    CURL_CA_BUNDLE: join(directory, "fixture-curl-ca"),
    SSL_CERT_FILE: join(directory, "fixture-cert"),
    SSL_CERT_DIR: join(directory, "fixture-cert-directory"),
  };
  const expected = join(directory, "expected.json");
  writePrivate(expected, allowed);
  const startup = join(directory, "forbidden-startup");
  writeFileSync(startup, "exit 79\n", { mode: 0o600 });

  // The child compares values via private fixture input. Its output carries no secrets,
  // even when a regression forwards the wrong environment or puts values on argv.
  const probe = [
    "import json, os, sys",
    "with open(sys.argv[1], encoding='utf-8') as expected:",
    "    allowed = json.load(expected)",
    "assert os.environ == {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', **allowed}",
    "argv = open('/proc/self/cmdline', 'rb').read() if sys.platform == 'linux' else b'\\0'.join(map(os.fsencode, sys.argv))",
    "assert not any(value and os.fsencode(value) in argv for value in allowed.values())",
  ].join("\n");
  const bash = [
    "set -euo pipefail",
    launcher,
    'export BASH_ENV="$1"',
    "blocked_fixture() { exit 80; }",
    "export -f blocked_fixture",
    "set -x",
    "run_system_tool /bin/bash -c '[[ \"$(type -t blocked_fixture)\" != function ]]'",
    'run_system_tool /usr/bin/python3 -I -S -c "$2" "$3"',
  ].join("\n");
  const result = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-c", bash, "ci-tool-probe", startup, probe, expected],
    {
      env: { ...allowed, PATH: directory, UNREVIEWED_CALLER_SETTING: "should-not-leave-caller" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  const privateValues = [...Object.values(allowed), proxyCanary];
  assert.ok(
    !traceExposesPrivateValues(result.stdout + result.stderr, privateValues),
    "launcher exposed a private fixture value",
  );
  assert.equal(result.status, 0, "controlled child rejected the launcher boundary");

  // The former shell assignment exposed the proxy in argv before reaching the child.
  // Run only that assignment with a synthetic URL to check that the detector catches it.
  const historical = spawnSync(
    "/bin/bash",
    ["-p", "-x", "-c", '/usr/bin/env -i HTTPS_PROXY="$HTTPS_PROXY" /usr/bin/true'],
    { env: { HTTPS_PROXY: proxy }, encoding: "utf8", timeout: 2000 },
  );
  assert.equal(historical.status, 0, "historical trace control failed");
  assert.ok(
    traceExposesPrivateValues(historical.stdout + historical.stderr, privateValues),
    "trace detector missed the historical shell assignment",
  );
});

test("CI setup action starts without caller shell startup and reuses pinned yq", (t) => {
  if (process.platform !== "linux") {
    t.skip("the required image-packaging lane runs on Linux");
    return;
  }
  const setup = readFileSync(join(repository, "scripts/ci/setup-tools.sh"), "utf8");
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const installer = setup.match(/^install_yq\(\) \{\n[\s\S]*?^\}$/m)?.[0];
  const pin = installer?.match(new RegExp('"' + arch + " ([a-f0-9]{64})" + '"'))?.[1];
  assert.ok(pin, "yq installer has no pin for the packaging architecture");
  const directory = temporaryDirectorySync(t, "ci-action-entry-");
  const bin = join(directory, "fixture-bin");
  mkdirSync(bin, { mode: 0o700 });
  // Discovery, reads, and staging run in one child with no subprocesses.
  // Node kills and reaps it before the fixture can clean up its private copy.
  const stage = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      [
        "import hashlib, os, shutil, stat, sys",
        "pin, destination = sys.argv[1:]",
        "candidate = shutil.which('yq')",
        "if not candidate or not os.path.isabs(candidate):",
        "    sys.exit(3)",
        "try:",
        "    with os.fdopen(os.open(candidate, os.O_RDONLY | os.O_NONBLOCK), 'rb') as source:",
        "        info = os.fstat(source.fileno())",
        "        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 64 * 1024 * 1024:",
        "            sys.exit(3)",
        "        contents = source.read(info.st_size + 1)",
        "except OSError:",
        "    sys.exit(3)",
        "if len(contents) != info.st_size or hashlib.sha256(contents).hexdigest() != pin:",
        "    sys.exit(3)",
        "with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700), 'wb') as staged:",
        "    staged.write(contents)",
        "    os.fchmod(staged.fileno(), 0o700)",
      ].join("\n"),
      pin,
      join(bin, "yq"),
    ],
    {
      env: { PATH: process.env.PATH },
      stdio: "ignore",
      timeout: 5000,
      killSignal: "SIGKILL",
    },
  );
  if (stage.status === 3) {
    if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      assert.fail("Required packaging CI must provide the repository-pinned yq from tool setup");
    }
    t.skip("local prerequisite: add the repository-pinned yq to PATH");
    return;
  }
  assert.equal(stage.status, 0, "pinned yq staging failed or exceeded its deadline");

  const checkout = join(directory, "checkout");
  const ci = join(checkout, "scripts", "ci");
  mkdirSync(ci, { recursive: true });
  for (const name of ["setup-tools.sh", "download-pinned.sh"]) {
    copyFileSync(join(repository, "scripts", "ci", name), join(ci, name));
  }

  // Exercise the exact checked-in action shell and step with its real nested
  // setup/downloader. Use a known verified yq so no remote download is needed.
  const action = readFileSync(
    join(repository, ".github/actions/setup-ci-tools/action.yml"),
    "utf8",
  );
  const step = action.split("\n    - name: Set up CI tools\n")[1]?.split("\n    - name: ")[0];
  const selectedShell = step?.match(/^      shell: (\S.*)$/m)?.[1];
  const selectedCommand = step?.match(/^      run: (\S.*)$/m)?.[1];
  assert.ok(selectedShell && selectedCommand, "CI tool setup action step is missing");
  const [shell, ...args] = selectedShell.split(/\s+/);
  assert.ok(shell?.startsWith("/"), "expected an absolute action shell");
  assert.equal(args.at(-1), "{0}", "expected the action runner to execute the step file");
  const stepFile = join(directory, "ci-step.sh");
  // Trace the actual inner setup too, so a regression in download_file is
  // observable before the downloader starts. Preserve its other launch options.
  const tracedCommand = selectedCommand.replace(/^(\S*\bbash)(?=\s)/, "$1 -x");
  assert.notEqual(tracedCommand, selectedCommand, "expected the setup step to select Bash");
  writeFileSync(stepFile, tracedCommand + "\n", { mode: 0o600 });
  const runner = join(directory, "runner");
  mkdirSync(runner, { mode: 0o700 });
  writeFileSync(join(bin, "docker"), '#!/bin/sh\n[ "$1" = version ]\n', { mode: 0o700 });

  const proxy = syntheticCredentialUrl({
    protocol: "offline-fixture",
    username: "fixture-proxy-user",
    password: proxyCanary,
    host: "proxy.example.invalid",
  });
  const startup = join(directory, "forbidden-startup");
  const startupMarker = join(directory, "startup-executed");
  writeFileSync(startup, 'printf bad >"$CI_FORBIDDEN_STARTUP"\nexit 79\n', { mode: 0o600 });
  // GNU timeout owns the action's process group, including the nested downloader.
  const result = spawnSync(
    "/usr/bin/timeout",
    ["--kill-after=2s", "15s", shell, ...args.slice(0, -1), "-x", stepFile],
    {
      cwd: checkout,
      env: {
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        RUNNER_TEMP: runner,
        CI_TOOL_PROFILE: "postgres",
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        ALL_PROXY: proxy,
        all_proxy: proxy,
        BASH_ENV: startup,
        ENV: startup,
        CI_FORBIDDEN_STARTUP: startupMarker,
        "BASH_FUNC_cd%%": '() { printf bad >"$CI_FORBIDDEN_STARTUP"; return 80; }',
      },
      encoding: "utf8",
    },
  );
  assert.ok(
    !traceExposesPrivateValues(result.stdout + result.stderr, [proxy, proxyCanary]),
    "CI action trace exposed the private fixture value",
  );
  assert.equal(
    statSync(startupMarker, { throwIfNoEntry: false }),
    undefined,
    "untrusted startup ran",
  );
  assert.equal(result.status, 0, "the real CI setup action failed to publish verified local bytes");
  assert.ok(result.stderr.includes("/scripts/ci/download-pinned.sh"), "missing downloader trace");
  const installed = join(runner, "bin", "yq");
  assert.equal(sha256(installed), pin);
  assert.equal(statSync(installed).mode & 0o777, 0o755);
  assert.equal(statSync(dirname(installed)).mode & 0o777, 0o700);
  assert.match(result.stdout, /\byq\b.*\bversion\b/i);
});
