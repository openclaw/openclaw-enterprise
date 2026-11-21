// Build the worker CLI from the reviewed Google manifest. The ClawHub skill is
// a provenance input. Only the separately reviewed OCE skill is exposed by this release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GoogleRelease = {
  skill: string;
  skillSha256: string;
  executable: string;
  version: string;
  clawhub: { sourceUrl: string; skillSha256: string };
  artifacts: Record<string, { url: string; archiveSha256: string; binarySha256: string }>;
};

const [releaseDirectory, platform, binDirectory, downloadPinned] = process.argv.slice(2);
if (!releaseDirectory || !platform || !binDirectory || !downloadPinned) {
  throw new Error("Expected release directory, platform, bin directory and pinned downloader.");
}
const manifest: GoogleRelease = JSON.parse(
  readFileSync(join(releaseDirectory, "release.json"), "utf8"),
);
const artifact = manifest.artifacts[platform];
if (!artifact) {
  throw new Error(`No managed Google CLI artifact for ${platform}.`);
}

function verify(path: string, expected: string): void {
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== expected) {
    throw new Error(`Managed Google artifact digest mismatch for ${path}.`);
  }
}

const staging = mkdtempSync(join(tmpdir(), "oce-google-"));
try {
  verify(join(releaseDirectory, "skills", manifest.skill, "SKILL.md"), manifest.skillSha256);
  const upstreamSkill = join(staging, "SKILL.md");
  const archive = join(staging, "gog.tar.gz");
  execFileSync(
    "bash",
    [downloadPinned, manifest.clawhub.sourceUrl, upstreamSkill, manifest.clawhub.skillSha256],
    { stdio: "inherit" },
  );
  execFileSync("bash", [downloadPinned, artifact.url, archive, artifact.archiveSha256], {
    stdio: "inherit",
  });
  execFileSync("tar", ["-xzf", archive, "-C", staging, "./" + manifest.executable]);
  const binary = join(staging, manifest.executable);
  verify(binary, artifact.binarySha256);
  chmodSync(binary, 0o755);
  const reported = execFileSync(binary, ["--version"], { encoding: "utf8" }).split(/\s/, 1)[0];
  if (reported !== `v${manifest.version}`) {
    throw new Error(`Managed Google CLI version mismatch for ${platform}.`);
  }
  copyFileSync(binary, join(binDirectory, manifest.executable));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
