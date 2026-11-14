import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { restoreLaneImages } from "../../scripts/ci/lane-images.ts";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { fixture, repositoryRoot, runCleanup, writeState } from "./ci-cleanup-fixture.ts";

async function readJournalResources(path: string): Promise<unknown> {
  const journal: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(journal && typeof journal === "object" && "resources" in journal);
  return journal.resources;
}

export function registerImageCustodyCases(): void {
  // QA jobs share the runners' Docker image store, which commits a job's images when they
  // differ from its starting snapshot (finding 1345). This drives the shipped preparation
  // and cleanup CLIs against a recording engine: preparation records the start, the "job"
  // builds, and cleanup must return only the QA launcher's names to that start.
  test("QA lane cleanup returns launcher images to the recorded start and reports the rest", async (t) => {
    const root = await fixture(t);
    const inventoryPath = join(root, "inventory.json");
    const commandLog = join(root, "commands.log");
    // Rows are [repository, tag, digest, id]. Tag and rm edit the inventory like an engine.
    // Removing the migrate tag fails as it does while a retained container still uses it,
    // and tagging an image the engine no longer has fails.
    const docker = await writeCommand(
      join(root, "bin"),
      "docker",
      `const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const inventoryPath = ${JSON.stringify(inventoryPath)};
const args = process.argv.slice(2);
const rows = JSON.parse(readFileSync(inventoryPath, "utf8"));
const split = (reference) => [reference.slice(0, reference.lastIndexOf(":")), reference.slice(reference.lastIndexOf(":") + 1)];
if (args[0] === "image" && args[1] === "ls") {
  // Only the exact listing yields full IDs, digest rows and the expected columns.
  if (args.join(" ") !== "image ls --digests --no-trunc --format {{.Repository}}\\t{{.Tag}}\\t{{.Digest}}\\t{{.ID}}") {
    process.stderr.write("unexpected listing: " + args.join(" ") + "\\n");
    process.exit(2);
  }
  process.stdout.write(rows.map((row) => row.join("\\t") + "\\n").join(""));
  process.exit(0);
}
appendFileSync(${JSON.stringify(commandLog)}, args.join(" ") + "\\n");
if (args[0] === "tag" && !rows.some((row) => row[3] === args[1])) {
  process.stderr.write("Error response from daemon: No such image: " + args[1] + "\\n");
  process.exit(1);
} else if (args[0] === "tag") {
  const [repository, tag] = split(args[2]);
  const kept = rows.filter((row) => row[0] !== repository || row[1] !== tag);
  writeFileSync(inventoryPath, JSON.stringify([...kept, [repository, tag, "<none>", args[1]]]));
} else if (args[0] === "image" && args[1] === "rm") {
  if (args[2].endsWith("-migrate:latest")) {
    process.stderr.write("conflict: unable to remove repository reference (must force) - container 0123 is using its referenced image\\n");
    process.exit(1);
  }
  const [repository, tag] = split(args[2]);
  writeFileSync(inventoryPath, JSON.stringify(rows.filter((row) => row[0] !== repository || row[1] !== tag)));
}
`,
      { interpreter: process.execPath },
    );
    const id = (character: string) => `sha256:${character.repeat(64)}`;
    const nodeDigest = `sha256:${"d".repeat(64)}`;
    const start = [
      ["localhost/openclaw-ci-main/runtime", "cfc5df9ad2b2", "<none>", id("a")],
      ["openclaw-enterprise-runtime", "kubernetes-quickstart", "<none>", id("1")],
      ["openclaw-enterprise-repository-credentials", "kubernetes-quickstart", "<none>", id("6")],
      ["occ-dev-qa-c-11111111-controller", "latest", "<none>", id("0")],
      ["node", "<none>", nodeDigest, id("e")],
      ["<none>", "<none>", "<none>", id("f")],
    ];
    await writeFile(inventoryPath, JSON.stringify(start));
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: "",
      OCC_DOCKER_BIN: docker,
    };
    const prepare = (statePath: string, extra: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        process.execPath,
        [
          join(repositoryRoot, "scripts/ci/prepare.mjs"),
          "--lane",
          "qa-matrix",
          "--state",
          statePath,
        ],
        { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...env, ...extra } },
      );

    // On a workstation the launcher's tags are the developer's: nothing is recorded.
    const localState = join(root, "local.json");
    const local = prepare(localState, { GITHUB_ACTIONS: "" });
    assert.equal(local.status, 0, local.stderr);
    assert.deepEqual(await readJournalResources(localState), []);

    const statePath = join(root, "state.json");
    const prepared = prepare(statePath);
    assert.equal(prepared.status, 0, prepared.stderr);

    // The job rebuilds the fixed runtime tag, adds a controller tag and a Kubernetes QA
    // installation's Compose images, and pulls an unrelated image. The repository
    // service tag and its image are gone, so it cannot be restored.
    await writeFile(
      inventoryPath,
      JSON.stringify([
        ["localhost/openclaw-ci-main/runtime", "cfc5df9ad2b2", "<none>", id("a")],
        ["openclaw-enterprise-runtime", "kubernetes-quickstart", "<none>", id("2")],
        ["openclaw-enterprise-controller", "kubernetes-quickstart", "<none>", id("3")],
        ["occ-dev-qa-c-11111111-controller", "latest", "<none>", id("0")],
        ["occ-dev-qa-k-22222222-controller", "latest", "<none>", id("4")],
        ["occ-dev-qa-k-22222222-migrate", "latest", "<none>", id("4")],
        ["node", "<none>", nodeDigest, id("e")],
        ["postgres", "18.6", "<none>", id("5")],
        ["<none>", "<none>", "<none>", id("1")],
      ]),
    );
    const result = runCleanup(statePath, { OCC_DOCKER_BIN: docker });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await commandCalls(commandLog), [
      `tag ${id("1")} openclaw-enterprise-runtime:kubernetes-quickstart`,
      `tag ${id("6")} openclaw-enterprise-repository-credentials:kubernetes-quickstart`,
      "image rm openclaw-enterprise-controller:kubernetes-quickstart",
      "image rm occ-dev-qa-k-22222222-controller:latest",
      "image rm occ-dev-qa-k-22222222-migrate:latest",
    ]);
    assert.match(
      result.stdout,
      /::warning::Lane image cleanup: remove occ-dev-qa-k-22222222-migrate:latest: .*conflict/,
    );
    assert.match(
      result.stdout,
      /::warning::Lane image cleanup: restore openclaw-enterprise-repository-credentials:kubernetes-quickstart: .*No such image/,
    );
    const reportLine = result.stdout
      .split("\n")
      .find((line) => line.includes('"stage":"lane-images"'));
    assert.ok(reportLine, "cleanup did not emit a lane image report");
    const report: unknown = JSON.parse(reportLine);
    assert.deepEqual(report, {
      stage: "lane-images",
      lane: "qa-matrix",
      restored: ["openclaw-enterprise-runtime:kubernetes-quickstart"],
      removed: [
        "openclaw-enterprise-controller:kubernetes-quickstart",
        "occ-dev-qa-k-22222222-controller:latest",
      ],
      added: ["occ-dev-qa-k-22222222-migrate:latest", "postgres:18.6"],
      changed: [],
      missing: ["openclaw-enterprise-repository-credentials:kubernetes-quickstart"],
    });
    await assert.rejects(stat(statePath), { code: "ENOENT" });
  });

  test("QA image cleanup reports an unavailable final inventory without inventing changes", async () => {
    const baselineId = `sha256:${"a".repeat(64)}`;
    const rebuiltId = `sha256:${"b".repeat(64)}`;
    const newId = `sha256:${"c".repeat(64)}`;
    const baselineRef = "openclaw-enterprise-runtime:kubernetes-quickstart";
    const newRef = "occ-dev-qa-k-example-controller:latest";
    const calls: string[][] = [];
    const logs: string[] = [];
    let listings = 0;
    const execFile = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "ls") {
        listings += 1;
        if (listings === 2) {
          throw new Error("final image inventory unavailable");
        }
        return {
          stdout: [
            `openclaw-enterprise-runtime\tkubernetes-quickstart\t<none>\t${rebuiltId}`,
            `occ-dev-qa-k-example-controller\tlatest\t<none>\t${newId}`,
            "",
          ].join("\n"),
        };
      }
      return { stdout: "" };
    };

    const result = await restoreLaneImages(
      { name: "qa-matrix", images: { [baselineRef]: baselineId } },
      { execFile, docker: "docker", log: (line) => logs.push(line) },
    );

    assert.equal(listings, 2);
    assert.deepEqual(calls.slice(1, 3), [
      ["tag", baselineId, baselineRef],
      ["image", "rm", newRef],
    ]);
    assert.deepEqual(result, {
      restored: [baselineRef],
      removed: [newRef],
      added: null,
      changed: null,
      missing: null,
      warnings: ["final inventory: final image inventory unavailable"],
    });
    const [warning, reportLine] = logs;
    assert.ok(warning, "cleanup did not emit a final inventory warning");
    assert.match(warning, /::warning::Lane image cleanup: final inventory:/);
    assert.ok(reportLine, "cleanup did not emit a lane image report");
    const report: unknown = JSON.parse(reportLine);
    assert.deepEqual(report, {
      stage: "lane-images",
      lane: "qa-matrix",
      restored: [baselineRef],
      removed: [newRef],
      added: null,
      changed: null,
      missing: null,
    });
  });

  // Test ownership decisions against Docker's inspect contract. The credentialed
  // first-Agent shards separately prove creation and removal of real resources.
  test("first-Agent registry cleanup refuses foreign ownership and replaced containers", async (t) => {
    for (const scenario of [
      "owned",
      "absent-container",
      "foreign-image",
      "foreign-container",
      "replaced-container",
      "foreign-owner",
    ] as const) {
      const root = await fixture(t);
      const prefix = "openclaw-ci-local-first-images-test";
      const name = "openclaw-ci-first-images-test";
      const containerId = "b".repeat(64);
      const controllerImage = `127.0.0.1:5000/${name}/controller@sha256:${"d".repeat(64)}`;
      const log = join(root, "calls.jsonl");
      const container = {
        Id: scenario === "replaced-container" ? "c".repeat(64) : containerId,
        Config: {
          Labels: {
            "openclaw.dev/ci-owner": scenario === "foreign-container" ? "another-owner" : prefix,
          },
        },
      };
      const docker = await writeCommand(
        join(root, "bin"),
        "docker",
        `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(scenario)} === 'absent-container' && args[0] === 'container' && args[1] === 'inspect') { console.error('No such container'); process.exit(1); }
if (args[1] === 'inspect') { console.log(JSON.stringify([${JSON.stringify(container)}])); }
else if (args[1] !== 'rm') { process.exit(99); }
`,
        { interpreter: process.execPath },
      );
      const statePath = join(root, "state.json");
      const resource = {
        id: "first-images",
        kind: "first-agent-image-registry",
        owner: scenario === "foreign-owner" ? "another-owner" : prefix,
        name,
        port: 5000,
        containerId,
        controllerImage:
          scenario === "foreign-image"
            ? controllerImage.replace(name, "another-repository")
            : controllerImage,
      };
      await writeState(statePath, {
        version: 1,
        repositoryRoot,
        prefix,
        resources: [resource],
      });

      const result = runCleanup(statePath, { OCC_DOCKER_BIN: docker });
      const removals = (await commandCalls(log)).filter((call) => call.includes('"rm"'));
      if (scenario === "owned" || scenario === "absent-container") {
        assert.equal(result.status, 0, result.stderr);
        await assert.rejects(readFile(statePath), { code: "ENOENT" });
        const expectedRemovals = [JSON.stringify(["image", "rm", controllerImage])];
        if (scenario === "owned") {
          expectedRemovals.push(
            JSON.stringify(["container", "rm", "--force", "--volumes", containerId]),
          );
        }
        assert.deepEqual(removals, expectedRemovals, scenario);
      } else {
        assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
        const refusal = {
          "foreign-image": /Refusing to remove an unowned first-Agent controller image/,
          "foreign-container": /First-Agent registry changed ownership/,
          "replaced-container": /First-Agent registry changed ownership/,
          "foreign-owner": /Refusing to clean resource owned by another prefix/,
        }[scenario];
        assert.match(result.stderr, refusal, scenario);
        assert.deepEqual(await readJournalResources(statePath), [resource], scenario);
        assert.deepEqual(removals, [], scenario);
      }
    }
  });
}
