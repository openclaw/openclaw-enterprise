import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// CI lanes set NODE_COMPILE_CACHE so each Node process reuses compiled and type-stripped
// modules. A child started with an allowlisted environment drops it and recompiles every
// module it loads (importing the controller costs about 0.5 CPU-s more without it). Spread
// this into such an environment: it carries only the cache directory, and nothing when the
// caller runs without a cache.
export const compileCacheEnvironment = Object.freeze(
  process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {},
);

// For a file that starts many Node children with an allowlisted environment: the lane's
// cache in CI, otherwise a directory the calling file owns until its tests end, so every
// child after the first reuses compiled code there too. Call it once, at module level.
export async function fileCompileCache(prefix) {
  if (process.env.NODE_COMPILE_CACHE) {
    return process.env.NODE_COMPILE_CACHE;
  }
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-cache-`));
  after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
