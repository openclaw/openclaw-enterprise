import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./graph.ts", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("CLI scans a separate source-only root without claiming curated evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "coupling-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // There is no package installation or build output in this source root.
  const source = "export function target() {}\nexport const caller = () => target();\n";
  writeFileSync(join(root, "entry.ts"), source);
  const result = run("--root", root, "--file", "entry.ts", "--file", "./entry.ts");
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  assert.equal(graph.schemaVersion, 1);
  assert.deepEqual(graph.source, {
    state: "working-tree",
    commit: null,
    paths: "POSIX repo-relative",
  });
  assert.deepEqual(graph.files, ["entry.ts"]);
  assert.deepEqual(graph.edges, [
    {
      from: "entry.ts#caller",
      kind: "calls",
      to: "entry.ts#target",
      site: { file: "entry.ts", line: 2 },
    },
  ]);
  assert.deepEqual(graph.unresolved, []);
  assert.equal(graph.evidence.status, "not-checked");
  assert.deepEqual(graph.evidence.claims, []);
  assert.equal(readFileSync(join(root, "entry.ts"), "utf8"), source);
});

test("CLI rejects incompatible checks and invalid source paths with actionable errors", (t) => {
  const root = mkdtempSync(join(tmpdir(), "coupling-cli-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [args, message] of [
    [["--file", "entry.ts", "--check"], /--file cannot be combined with --check/],
    [["--root"], /--root requires a value/],
    [["--root", root, "--file", "../entry.ts"], /repo-relative source path/],
    [["--root", root, "--file", "missing.ts"], /Source file is missing/],
    [["--root", root, "--check"], /Source file is missing/],
  ] as const) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});
