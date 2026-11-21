import { readFileSync } from "node:fs";
import { nativeProbe } from "./client.ts";

const bearer = readFileSync(0, "utf8");
try {
  await nativeProbe("protected", bearer);
} catch (error) {
  console.error(String(error).replaceAll(bearer, "[redacted]"));
  process.exitCode = 1;
}
