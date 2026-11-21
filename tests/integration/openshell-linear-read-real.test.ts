import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyOpenShellLinearRead } from "../helpers/openshell-linear-read.mjs";

test(
  "shipped OpenShell Agent installs Linear and executes an authenticated read",
  {
    skip: process.env.OCC_TEST_OPENSHELL_LINEAR_REAL !== "1",
    timeout: 3_600_000,
  },
  async (context) => {
    const artifacts = await mkdtemp(join(tmpdir(), "oce-openshell-linear-"));
    context.diagnostic(`Evidence: ${artifacts}`);
    await verifyOpenShellLinearRead(context, artifacts);
  },
);
