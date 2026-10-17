import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

const packet = (line) =>
  Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line);

// Real Git creates the object IDs and pack. The command bodies are protocol inputs;
// no fetch or push is dispatched and no remote repository outcome is claimed.
export async function gitCommandBodies(t, pushRef) {
  const cwd = await temporaryDirectory(t, "online-git-commands-");
  await run("git", ["init", "--initial-branch=main", "--object-format=sha1"], { cwd });
  await writeFile(join(cwd, "README.md"), "Owned synthetic Git authorization fixture\n");
  await run("git", ["add", "README.md"], { cwd });
  await run(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"],
    { cwd },
  );
  const oid = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], {
    cwd,
    env: cleanEnvironment(),
    input: `${oid}\n`,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const update = `${"0".repeat(40)} ${oid}`;
  const first = packet(`${update} ${pushRef}\0report-status\n`);
  return {
    fetch: Buffer.concat([packet(`want ${oid}\n`), Buffer.from("0000"), packet("done\n")]),
    push: Buffer.concat([first, Buffer.from("0000"), pack]),
    mixed: Buffer.concat([first, packet(`${update} refs/heads/main\n`), Buffer.from("0000"), pack]),
  };
}
