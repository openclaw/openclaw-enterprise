// Read the bridge test selection from deploy/runtime/Dockerfile, so an
// upstream sync that only changes which tests or type-check graphs run needs no port.
//
//   node oce-bridge-tests.mjs <Dockerfile> <source dir> <output dir>
//
// Writes <output dir>/files, one test file per line: the *.test.ts(x)
// arguments of the first scripts/test-projects.mts call in the first RUN that
// makes one in the openclaw-bridge-tests stage. Later calls chained in that
// RUN (name-filtered runs) are ported by hand. Writes <output dir>/graphs.json:
// the --ci-graphs-json list in that stage. deploy/konflux/oce_pins.py masks
// the same two lists when it diffs the Dockerfile, so keep the two rules in step.
import fs from "node:fs";
import path from "node:path";

const [dockerfile, source, out] = process.argv.slice(2);
const fail = (message) => {
  console.error(`${dockerfile}: ${message}; port the bridge tests by hand`);
  process.exit(1);
};

// Join continued lines and drop comments, as the builder does.
const instructions = [];
let pending = null;
for (const raw of fs.readFileSync(dockerfile, "utf8").split("\n")) {
  const line = raw.trimEnd();
  if (!line || line.trimStart().startsWith("#")) continue;
  const continued = line.endsWith("\\") && !line.endsWith("\\\\");
  const text = continued ? line.slice(0, -1) : line;
  pending = pending === null ? text : `${pending} ${text}`;
  if (!continued) {
    instructions.push(pending);
    pending = null;
  }
}

const start = instructions.findIndex((i) => /^FROM\s.*\sAS\s+openclaw-bridge-tests$/i.test(i));
if (start < 0) fail("no openclaw-bridge-tests stage");
const end = instructions.findIndex((i, n) => n > start && /^FROM\s/i.test(i));
const stage = instructions.slice(start + 1, end < 0 ? undefined : end);

const run = stage.find((i) => /^RUN\s/i.test(i) && i.includes("scripts/test-projects.mts"));
if (!run) fail("no scripts/test-projects.mts RUN in openclaw-bridge-tests");
const words = run.split(/\s+/);
const first = words.indexOf("scripts/test-projects.mts") + 1;
if (first === 0) fail("scripts/test-projects.mts is not a separate word in its RUN");
// A shell control token or another call ends the first call, as in
// deploy/konflux/oce_pins.py ends_call.
const next = words.findIndex(
  (word, n) =>
    n >= first &&
    (["&&", "||", ";", "|", "scripts/test-projects.mts"].includes(word) || word.endsWith(";")),
);
const files = words
  .slice(first, next < 0 ? undefined : next)
  .filter((word) => /^[\w./-]+\.test\.tsx?$/.test(word));
if (files.length === 0) fail("no test files in the scripts/test-projects.mts RUN");
const missing = files.filter((file) => !fs.existsSync(path.join(source, file)));
if (missing.length > 0) fail(`test files missing from ${source}: ${missing.join(", ")}`);

const graphs = stage.join("\n").match(/--ci-graphs-json '(\[[^']*\])'/);
if (!graphs) fail("no --ci-graphs-json list in openclaw-bridge-tests");
const list = JSON.parse(graphs[1]);
if (!Array.isArray(list) || list.length === 0 || !list.every((g) => /^[\w-]+$/.test(g))) {
  fail(`unexpected --ci-graphs-json list ${graphs[1]}`);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "files"), `${files.join("\n")}\n`);
fs.writeFileSync(path.join(out, "graphs.json"), JSON.stringify(list));
console.log(`${files.length} bridge test files, type-check graphs ${JSON.stringify(list)}`);
