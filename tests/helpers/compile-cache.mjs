// CI lanes set NODE_COMPILE_CACHE so each Node process reuses compiled and type-stripped
// modules. A child started with an allowlisted environment drops it and recompiles every
// module it loads (importing the controller costs about 0.5 CPU-s more without it). Spread
// this into such an environment: it carries only the cache directory, and nothing when the
// caller runs without a cache.
export const compileCacheEnvironment = Object.freeze(
  process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {},
);
