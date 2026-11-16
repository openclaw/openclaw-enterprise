import { spawnSync } from "node:child_process";

const program = process.argv[2];
if (program === undefined) {
  throw new Error("Missing fixture program");
}
const run = (command: string) => {
  // Box's sh alias forwards this input to the real Shell Calls broker.
  const result = spawnSync("sh", ["-lc", command], {
    encoding: "utf8",
    timeout: 6_000,
    maxBuffer: 16_384,
  });
  if (result.error !== undefined) {
    throw new Error("Shell Calls invocation failed");
  }
  return {
    exitCode: result.status,
    stdout: result.stdout,
    policyDenied: result.stderr.includes("[default-deny]"),
  };
};

const receipt = {
  marker: run(program),
  extraArgument: run(`${program} unexpected`),
  builtin: run("printf OUTSIDE_POLICY"),
  nestedShell: run("sh -c 'printf OUTSIDE_POLICY'"),
};
process.stdout.write("OCE_BOX_SHELL_TEST_JSON " + JSON.stringify(receipt) + "\n");
