import { nativeReady } from "./handshake.mjs";
process.exitCode = (await nativeReady(process.argv[2])) ? 0 : 1;
