import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { render } from "./render.ts";

const tool = fileURLToPath(new URL("./", import.meta.url));
const refinement = `
import type { Sketch } from "../render.ts";
export function refineScene(scene: Sketch): Sketch {
  return { ...scene, title: scene.title + " (refined)", width: scene.width + 40 };
}
`;

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "diagram-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Copy the real implementation, but never write into the canonical examples.
  for (const name of readdirSync(tool)) {
    if (
      (name.endsWith(".ts") && !name.endsWith(".test.ts")) ||
      name === "package.json" ||
      name === "fonts"
    ) {
      cpSync(join(tool, name), join(directory, name), { recursive: true });
    }
  }
  symlinkSync(join(tool, "node_modules"), join(directory, "node_modules"), "dir");
  mkdirSync(join(directory, "examples"));
  return directory;
}

function source(title: string): string {
  return `import type { Diagram } from "../diagram.ts";
export default {
  title: ${JSON.stringify(title)},
  groups: [{ id: "sandbox", title: "Sandbox", role: "boundary" }],
  nodes: [{ id: "agent", title: "Agent", group: "sandbox" }],
  edges: [],
} satisfies Diagram;
`;
}

function run(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(directory, "build.ts"), ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("canonical builds preserve refinements and detect stale output without writes on check", async (t) => {
  const directory = fixture(t);
  const examples = join(directory, "examples");
  writeFileSync(join(examples, "b.ts"), source("Second diagram"));
  writeFileSync(join(examples, "a.ts"), source("First diagram") + refinement);
  writeFileSync(join(examples, "raw.json"), "not an executable module");
  mkdirSync(join(examples, "nested"));
  writeFileSync(
    join(examples, "nested", "ignored.ts"),
    'throw new Error("Do not scan recursively");',
  );

  const missing = run(directory, "--check");
  assert.equal(missing.status, 1, missing.stderr);
  assert.ok(missing.stderr.indexOf("a.json") < missing.stderr.indexOf("b.json"));
  assert.equal(existsSync(join(examples, "a.json")), false);
  assert.equal(existsSync(join(examples, "a.png")), false);
  const built = run(directory);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(run(directory, "--check").status, 0);
  const json = readFileSync(join(examples, "a.json"));
  const png = readFileSync(join(examples, "a.png"));
  assert.equal(JSON.parse(json.toString()).title, "First diagram (refined)");
  assert.deepEqual(png, (await render(JSON.parse(json.toString()))).png);

  writeFileSync(join(examples, "a.ts"), source("Revised diagram") + refinement);
  const stale = run(directory, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /a\.json/);
  assert.match(stale.stderr, /a\.png/);
  assert.doesNotMatch(stale.stderr, /b\.(json|png)/);
  assert.deepEqual(readFileSync(join(examples, "a.json")), json);
  assert.deepEqual(readFileSync(join(examples, "a.png")), png);
  assert.equal(run(directory).status, 0);
  assert.equal(
    JSON.parse(readFileSync(join(examples, "a.json"), "utf8")).title,
    "Revised diagram (refined)",
  );
  assert.notDeepEqual(readFileSync(join(examples, "a.png")), png);
  assert.equal(run(directory, "--check").status, 0);

  // A PNG-only change must fail even when the generated JSON is current.
  writeFileSync(join(examples, "a.png"), "stale PNG");
  const stalePng = run(directory, "--check");
  assert.equal(stalePng.status, 1);
  assert.match(stalePng.stderr, /a\.png/);
  assert.doesNotMatch(stalePng.stderr, /a\.json/);
  assert.equal(readFileSync(join(examples, "a.png"), "utf8"), "stale PNG");
});

test("bad refineScene exports and invalid refined scenes fail before writing either artifact", (t) => {
  const directory = fixture(t);
  const prefix = join(directory, "examples", "invalid");
  writeFileSync(`${prefix}.json`, "existing JSON");
  writeFileSync(`${prefix}.png`, "existing PNG");
  for (const [refineScene, error] of [
    ["42", /invalid\.ts: refineScene must be a function/],
    ["undefined", /invalid\.ts: refineScene must be a function/],
    ["(scene) => ({ ...scene, width: -1 })", /width/],
  ] as const) {
    writeFileSync(
      `${prefix}.ts`,
      source("Invalid refinement") + `export const refineScene = ${refineScene};\n`,
    );
    const result = run(directory);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.equal(readFileSync(`${prefix}.json`, "utf8"), "existing JSON");
    assert.equal(readFileSync(`${prefix}.png`, "utf8"), "existing PNG");
  }
});

test("custom local sources build to the requested prefix and bad arguments create nothing", (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, "examples", "custom.ts"), source("Custom diagram"));
  const built = run(directory, "examples/custom.ts", "custom output");
  assert.equal(built.status, 0, built.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(directory, "custom output.json"), "utf8")).title,
    "Custom diagram",
  );
  assert.equal(readFileSync(join(directory, "custom output.png")).readUInt32BE(0), 0x89504e47);
  for (const args of [
    ["--unknown"],
    ["examples/custom.ts"],
    ["custom output.json", "bad"],
    ["--check", "bad"],
    ["examples/custom.ts", "bad", "extra"],
  ]) {
    const invalid = run(directory, ...args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/);
  }
  assert.equal(existsSync(join(directory, "bad.json")), false);
  assert.equal(existsSync(join(directory, "bad.png")), false);
});
