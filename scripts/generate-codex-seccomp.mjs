#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main } from "./generate-codex-seccomp.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export * from "./generate-codex-seccomp.ts";
