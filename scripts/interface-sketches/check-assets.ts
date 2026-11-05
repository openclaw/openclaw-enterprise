import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function main(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error("Usage: node check-assets.ts EXAMPLES_DIRECTORY PUBLISHED_DIRECTORY");
  }
  const [examples, published] = args.map((directory) => resolve(directory));
  const filenames = async (directory: string) => {
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(
        `Preview directory must be a real directory (replace this entry): ${directory}`,
      );
    }
    const names = new Set((await readdir(directory)).filter((name) => name.endsWith(".png")));
    for (const name of [...names].sort()) {
      const path = resolve(directory, name);
      if (!(await lstat(path)).isFile()) {
        throw new Error(`Preview must be a regular file (replace this entry): ${path}`);
      }
    }
    return names;
  };
  const expected = await filenames(examples);
  const actual = await filenames(published);
  const problems: string[] = [];
  for (const name of [...actual].sort()) {
    if (!expected.has(name)) {
      problems.push(
        `Orphan published preview (remove this obsolete file manually): ${resolve(published, name)}`,
      );
    }
  }
  for (const name of [...expected].sort()) {
    const destination = resolve(published, name);
    if (!actual.has(name)) {
      problems.push(`Missing published preview (run pnpm build): ${destination}`);
    } else if (!(await readFile(resolve(examples, name))).equals(await readFile(destination))) {
      problems.push(`Stale published preview (run pnpm build): ${destination}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Asset check failed");
  process.exitCode = 1;
});
