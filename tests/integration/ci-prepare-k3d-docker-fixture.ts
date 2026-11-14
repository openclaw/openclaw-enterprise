import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fixtureImageCommands, writeFixtureCommand } from "../helpers/ci-prepare-fixture.ts";
import { bashString, startCommandServer } from "../helpers/fixture-command-server.ts";

export type ImageCommands = Awaited<ReturnType<typeof fixtureImageCommands>>;

// Override selected external commands while the normal CLI and fixture handle the rest.
export async function interceptFixtureDocker(
  t: TestContext,
  commands: ImageCommands,
  scriptFor: (args: readonly string[]) => string | undefined | Promise<string | undefined>,
) {
  const engine = join(dirname(commands.statePath), "bin", "docker.mjs");
  const original = `${engine}.original`;
  await rename(engine, original);
  const server = await startCommandServer({
    forwardedEnv: [],
    handle: async ({ args, io }) => {
      const script = await scriptFor(args);
      io.script(script ?? `exec ${bashString(original)} ${args.map(bashString).join(" ")}`);
    },
  });
  t.after(() => server.close());
  await writeFixtureCommand(engine, "docker", server);
}
