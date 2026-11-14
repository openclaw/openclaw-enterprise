import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import { asRecord } from "../../packages/utils/src/objects.ts";
import { createDevUpModelProvider } from "../helpers/dev-up-model-provider.mjs";
import type { CommandOptions, RunCommand } from "../helpers/dev-up-model-provider.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
export const revision = "a".repeat(40);
const digest = "b".repeat(64);
export const ownerLabel = "dev.openclaw.model-provider-owner";

type InspectedConfig = {
  Labels: Record<string, string>;
  User?: string;
  Entrypoint?: null;
  Cmd?: string[];
  WorkingDir?: string;
};

type EngineObject = {
  Id: string;
  Config: InspectedConfig;
  Labels?: Record<string, string>;
  RepoDigests?: string[];
};

export type Creation = { name: string; object: EngineObject; options: CommandOptions };
type Build = { name: string; options: CommandOptions };
export type InspectDiagnostic = (kind: string, name: string) => string;
type ProviderEvent =
  | { event: "listening"; at: number }
  | { event: "request"; turn: boolean; transport: string; at: number }
  | {
      event: "turn-answered";
      status: number;
      transport: string;
      at: number;
      authorization?: string;
    };

type ScenarioOptions = {
  failAfterCreate?: boolean;
  failAfterRemove?: boolean;
  failRemove?: boolean | string;
  existingRegistry?: boolean;
  signal?: AbortSignal;
  beforeCreate?: (creation: Creation) => void | Promise<void>;
  beforeBuild?: (build: Build) => void | Promise<void>;
  builder?: string;
};

type CommandCall = { command: string; args: string[]; options: CommandOptions };

async function readResourceJournal(directory: string) {
  const journal = asRecord(JSON.parse(await readFile(join(directory, "resources.json"), "utf8")));
  assert.ok(Array.isArray(journal?.resources), "recovery journal must contain a resource list");
  const resources: unknown[] = journal.resources;
  return { ...journal, resources };
}

// A command-boundary engine double: checks fixture orchestration and recovery,
// never substitutes for Docker storage, hosted image, Kubernetes, or native activation proof.
export async function providerScenario(
  t: TestContext,
  {
    failAfterCreate,
    failAfterRemove,
    failRemove,
    existingRegistry = false,
    signal,
    beforeCreate,
    beforeBuild,
    builder,
  }: ScenarioOptions = {},
) {
  const root = await temporaryDirectory(t, "oce-provider-contract-");
  const directory = join(root, "provider");
  await mkdir(directory);
  const readJournal = () => readResourceJournal(directory);
  const objects = new Map<string, EngineObject>();
  const calls: CommandCall[] = [];
  const environment: NodeJS.ProcessEnv = {
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    DOCKER_HOST: "unix:///owned.sock",
    ...(builder === undefined ? {} : { BUILDX_BUILDER: builder }),
  };
  const events: ProviderEvent[] = [{ event: "listening", at: 1 }];
  const faults: { inspectError: InspectDiagnostic | undefined } = { inspectError: undefined };
  let failedCreate = false;
  let failedRemove = false;
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const output = (value: string | EngineObject[]) => ({
      stdout: typeof value === "string" ? value : JSON.stringify(value),
      stderr: "",
    });
    const flag = (name: string) => {
      const index = args.indexOf(name);
      const value = args[index + 1];
      assert.ok(index >= 0 && value !== undefined, `Expected value after ${name}`);
      return value;
    };
    if (command === "openssl") {
      return execute(command, args);
    }
    if (command === "git") {
      return output(revision);
    }
    assert.equal(command, "docker", "no actual cluster command may escape the fixture test");
    if (args[1] === "inspect") {
      const [kind, , name] = args;
      assert.ok(kind && name, "inspect must name the resource");
      if (faults.inspectError) {
        throw Object.assign(new Error("engine unavailable"), {
          stderr: faults.inspectError(kind, name),
        });
      }
      if (existingRegistry && name.endsWith("-registry")) {
        return output([{ Id: "unrelated-registry", Config: { Labels: {} } }]);
      }
      const value = objects.get(name) ?? [...objects.values()].find((object) => object.Id === name);
      if (!value) {
        throw Object.assign(new Error("missing"), {
          stderr:
            args[0] === "network"
              ? `Error response from daemon: network ${name} not found`
              : `Error response from daemon: No such ${args[0]}: ${name}`,
        });
      }
      return output([value]);
    }
    if (args[0] === "run" || (args[0] === "network" && args[1] === "create")) {
      const name = args[0] === "run" ? flag("--name") : args.at(-1);
      assert.ok(name, "creation must name the resource");
      const [key, value] = flag("--label").split("=");
      assert.ok(key && value !== undefined, "creation must label the resource");
      // Creation must already have a durable cleanup obligation, even if its
      // acknowledgement is lost after the engine has materialized the object.
      const journal = await readJournal();
      assert.ok(journal.resources.some((resource) => asRecord(resource)?.name === name));
      const object = {
        Id: `id-${name}`,
        Config: { Labels: { [key]: value } },
        Labels: { [key]: value },
      };
      await beforeCreate?.({ name, object, options });
      objects.set(name, object);
      if (failAfterCreate && !failedCreate) {
        failedCreate = true;
        throw new Error("creation acknowledgement lost");
      }
      return output(`id-${name}`);
    }
    if (args[0] === "buildx") {
      const name = flag("--tag");
      await beforeBuild?.({ name, options });
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const label = args[index + 1];
          assert.ok(label, "build label value missing");
          const [key, value] = label.split("=");
          assert.ok(key && value !== undefined, "invalid build label");
          labels[key] = value;
        }
      }
      const baseArg = args.find((arg) => arg.startsWith("RUNTIME_IMAGE="));
      const base = baseArg && objects.get(baseArg.slice("RUNTIME_IMAGE=".length));
      if (baseArg) {
        assert.ok(base, "trust layer must use the loaded base image");
      }
      const config: InspectedConfig = base
        ? base.Config
        : {
            Labels: { ...labels, "org.opencontainers.image.revision": revision },
            User: "node",
            Entrypoint: null,
            Cmd: ["node"],
            WorkingDir: "/app",
          };
      objects.set(name, {
        Id: `id-${name}`,
        Config: structuredClone(config),
        RepoDigests: [],
      });
      return output("");
    }
    if (args[0] === "push") {
      const name = args[1];
      assert.ok(name, "push must name an image");
      const image = objects.get(name);
      assert.ok(image, "push must use a built image");
      image.RepoDigests = [`${name.slice(0, name.lastIndexOf(":"))}@sha256:${digest}`];
      return output("");
    }
    if (args[0] === "logs") {
      return output(events.map((event) => JSON.stringify(event)).join("\n"));
    }
    if (args[1] === "rm") {
      const name = [...objects.keys()].find(
        (name) => name === args.at(-1) || objects.get(name)?.Id === args.at(-1),
      );
      assert.ok(name);
      if (failRemove && !failedRemove && (failRemove === true || name.endsWith(failRemove))) {
        failedRemove = true;
        throw new Error("owned deletion failed");
      }
      const object = objects.get(name);
      assert.ok(object, "removal must target an existing object");
      if (args[0] === "container") {
        assert.equal(args.at(-1), object.Id, "remove the inspected container ID");
      }
      objects.delete(name);
      if (failAfterRemove && !failedRemove) {
        failedRemove = true;
        throw new Error("deletion acknowledgement lost");
      }
      return output("");
    }
    throw new Error(`Unexpected fixture operation: ${command} ${args.join(" ")}`);
  };
  const fixture = createDevUpModelProvider({
    directory,
    cluster: "owned-cluster",
    environment,
    ...(signal === undefined ? {} : { signal }),
    run,
  });
  return {
    fixture,
    root,
    run,
    directory,
    readJournal,
    calls,
    objects,
    environment,
    events,
    faults,
  };
}
