import {
  createDraftPull,
  draftPullFailureMessage,
} from "../../../apps/controller/src/drivers/repo/github/access/client/draft-pr.ts";

const [, , manifestRoot, ...args] = process.argv;
if (manifestRoot === undefined) {
  throw new Error("A fixture manifest root is required");
}

try {
  await createDraftPull(args, manifestRoot);
} catch (error) {
  const { message, exitCode } = draftPullFailureMessage(error);
  process.stderr.write(message + "\n");
  process.exitCode = exitCode;
}
