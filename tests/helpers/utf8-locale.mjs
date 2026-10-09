import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Bash regex ranges such as [a-z0-9] follow the locale: under en_US.UTF-8
// they also match letters like ä and digits like ٣, while C and C.UTF-8 do
// not. Returns that locale when the host has it, or null.
export async function rangeWideningLocale() {
  try {
    const { stdout } = await execute("locale", ["-a"]);
    return /^en_US\.utf-?8$/imu.test(stdout) ? "en_US.UTF-8" : null;
  } catch {
    // `locale` is missing on some minimal hosts.
    return null;
  }
}
