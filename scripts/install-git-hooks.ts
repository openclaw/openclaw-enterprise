import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const managedMarker = "# OPENCLAW_ENTERPRISE_MANAGED_PRE_PUSH_HOOK";
const arguments_ = process.argv.slice(2);

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--if-git-present")) {
  throw new Error("Usage: node scripts/install-git-hooks.mjs [--if-git-present]");
}

try {
  await lstat(join(repositoryRoot, ".git"));
} catch (error) {
  if (isMissingFile(error) && arguments_[0] === "--if-git-present") {
    process.stdout.write("Skipping Git hook installation outside a Git checkout.\n");
    process.exit(0);
  }

  if (isMissingFile(error)) {
    throw new Error("Cannot install Git hooks outside a Git checkout.", { cause: error });
  }

  throw error;
}

const gitCommonDirectory = execFileSync("git", ["rev-parse", "--git-common-dir"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

const sourceHookPath = join(repositoryRoot, ".githooks/pre-push");
const hookDirectory = join(resolve(repositoryRoot, gitCommonDirectory), "hooks");
const nativeHookPath = join(hookDirectory, "pre-push");
const sourceHook = await readFile(sourceHookPath, "utf8");

if (!sourceHook.includes(`${managedMarker}\n`)) {
  throw new Error("The tracked pre-push hook is missing its repository-managed marker.");
}

try {
  const existingHookMetadata = await lstat(nativeHookPath);
  if (!existingHookMetadata.isFile()) {
    throw new Error(`Refusing to replace unmanaged pre-push hook: ${nativeHookPath}`);
  }

  const existingHook = await readFile(nativeHookPath, "utf8");
  if (!existingHook.includes(`${managedMarker}\n`)) {
    throw new Error(`Refusing to replace unmanaged pre-push hook: ${nativeHookPath}`);
  }
} catch (error) {
  if (!isMissingFile(error)) {
    throw error;
  }
}

await mkdir(dirname(nativeHookPath), { recursive: true });
const temporaryHookPath = `${nativeHookPath}.openclaw-enterprise-${process.pid}`;

try {
  await writeFile(temporaryHookPath, sourceHook, { encoding: "utf8", flag: "wx", mode: 0o755 });
  await chmod(temporaryHookPath, 0o755);
  await rename(temporaryHookPath, nativeHookPath);
} finally {
  await rm(temporaryHookPath, { force: true });
}

process.stdout.write(`Installed repository-managed pre-push hook: ${nativeHookPath}\n`);
