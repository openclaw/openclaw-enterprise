import { chmod } from "node:fs/promises";
import type { TestContext } from "node:test";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

export async function openShellTestDirectory(t: TestContext, prefix = "ci-openshell-test") {
  const root = await temporaryDirectory(t, `${prefix}-`);
  await chmod(root, 0o700);
  return root;
}
