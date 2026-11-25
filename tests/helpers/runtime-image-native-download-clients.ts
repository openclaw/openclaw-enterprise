import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const bin = "/opt/devtools/bin";
assert.equal(process.getuid?.(), 1000, "the runtime must use its default Agent user");

function assertAgentCannotReplace(path: string) {
  // Check writable container permissions on both PATH entries and their native targets.
  for (let current = path; current !== "/"; current = dirname(current)) {
    const info = lstatSync(current);
    assert.equal(info.uid, 0, `${current} must be root-owned`);
    assert.equal(info.gid, 0, `${current} must be in the root group`);
    assert.throws(
      () => accessSync(current, constants.W_OK),
      { code: "EACCES" },
      `the Agent must not be able to write ${current}`,
    );
  }
}

// The host supplies the selection from the release source. Hash the installed
// executable independently of the final image inventory producer.
const selection: [string, string][] = JSON.parse(process.argv[2]!);
const identities = Object.fromEntries(
  selection.map(([installed, expected]) => {
    const resolvedBinary = realpathSync(installed);
    assert.equal(resolvedBinary, expected);
    accessSync(installed, constants.X_OK);
    const binarySha256 = execFileSync("sha256sum", [installed], { encoding: "utf8" }).split(" ")[0];
    return [installed, { resolvedBinary, binarySha256 }];
  }),
);
const provenance = JSON.parse(readFileSync("/opt/oce/runtime/provenance.json", "utf8"));
assert.deepEqual(provenance.downloadClients, identities);

const work = mkdtempSync(join(tmpdir(), "oce-native-download-clients-"));
const env = {
  ...process.env,
  HOME: work,
  TMPDIR: work,
  XDG_CACHE_HOME: join(work, "cache"),
  RUSTUP_HOME: join(work, "rustup"),
  CARGO_HOME: join(work, "cargo"),
  CARGO_TARGET_DIR: join(work, "target"),
  GOENV: "off",
  GOTOOLCHAIN: "local",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOWORK: "off",
  GOCACHE: join(work, "go-cache"),
  GOMODCACHE: join(work, "go-mod"),
  CGO_ENABLED: "0",
  BUN_INSTALL_CACHE_DIR: join(work, "bun-cache"),
};

function run(command: string, ...args: string[]) {
  return execFileSync(command, args, {
    cwd: work,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertInstalledCommand(name: string) {
  const launcher = run("sh", "-c", 'command -v "$1"', "sh", name);
  const installed = join(bin, name);
  assert.equal(realpathSync(launcher), installed, `${name} must resolve to the inventoried file`);
  assertAgentCannotReplace(launcher);
  if (launcher !== installed) {
    assertAgentCannotReplace(installed);
  }
}

const probes = {
  rustup() {
    assert.match(run("rustup", "--version"), /^rustup 1\.29\.1(?: |$)/);
    assert.equal(run("rustup", "show", "home"), env.RUSTUP_HOME);
  },
  cargo() {
    assertInstalledCommand("rustc");
    assert.match(run("rustc", "--version"), /^rustc 1\.95\.0(?: |$)/);
    assert.match(run("cargo", "--version"), /^cargo 1\.95\.0(?: |$)/);
    mkdirSync(join(work, "src"));
    writeFileSync(
      join(work, "Cargo.toml"),
      '[package]\nname = "oce-offline-smoke"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    writeFileSync(
      join(work, "src/main.rs"),
      'fn main() { println!("rust:{}", std::path::Path::new("offline").display()); }\n',
    );
    assert.equal(run("cargo", "run", "--offline", "--quiet"), "rust:offline");
  },
  go() {
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    assert.equal(run("go", "version"), `go version go1.27.3 linux/${arch}`);
    writeFileSync(
      join(work, "main.go"),
      'package main\nimport "fmt"\nfunc main() { fmt.Println("go:offline") }\n',
    );
    assert.equal(run("go", "run", "main.go"), "go:offline");
  },
  bun() {
    assert.equal(run("bun", "--version"), "1.4.4");
    assert.equal(run("bun", "--eval", 'console.log("bun:" + "offline")'), "bun:offline");
  },
};

try {
  for (const [name, exercise] of Object.entries(probes)) {
    const installed = join(bin, name);
    if (Object.hasOwn(identities, installed)) {
      assertInstalledCommand(name);
      exercise();
    } else {
      assert.throws(() => lstatSync(installed), { code: "ENOENT" });
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
