import { readFileSync } from "node:fs";
import { nativeReady } from "./handshake.mjs";
const token = readFileSync(process.argv[2], "utf8");
const port = Number(process.argv[3]);
process.exitCode = token && (await nativeReady(port, token)) ? 0 : 1;
