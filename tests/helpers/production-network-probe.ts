import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { NetworkProbeTarget } from "../fixtures/kubernetes/production-network-probe.mts";
import { inlineProbeCommand } from "./kubernetes-real.ts";

const deniedErrors = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

type ProbeResults = Record<string, string>;
type Scenario = {
  source: string;
  allow?: readonly string[];
  deny?: readonly string[];
  controlSource?: string;
};

type ProbeOptions = {
  kubectl: (...args: string[]) => Promise<string>;
  waitFor: (
    description: string,
    operation: () => Promise<boolean>,
    timeoutMs: number,
  ) => Promise<boolean>;
  diagnostic: (message: string) => void;
  sources: Readonly<Record<string, { namespace: string }>>;
  targets: Readonly<Record<string, NetworkProbeTarget>>;
};

function readResults(stdout: string, names: readonly string[]): ProbeResults {
  const decoded: unknown = JSON.parse(stdout);
  const results = asRecord(decoded);
  assert.ok(results, "Expected named network probe results");
  return Object.fromEntries(
    names.map((name): [string, string] => {
      const result = results[name];
      assert.ok(
        Object.hasOwn(results, name) && typeof result === "string" && result.length > 0,
        `Expected a network probe result for ${name}`,
      );
      return [name, result];
    }),
  );
}

function isDenied(result: string | undefined): boolean {
  return result !== undefined && deniedErrors.has(result);
}

export async function createProductionNetworkProbe({
  kubectl,
  waitFor,
  diagnostic,
  sources,
  targets,
}: ProbeOptions) {
  const probeSource = await readFile(
    new URL("../fixtures/kubernetes/production-network-probe.mts", import.meta.url),
    "utf8",
  );

  async function probe(
    source: string,
    names: readonly string[],
    tcpOnly: readonly string[] = [],
  ): Promise<ProbeResults> {
    const from = sources[source];
    assert.ok(from && Object.hasOwn(sources, source), `Unknown network probe source ${source}`);
    const selected = Object.fromEntries(
      names.map((name): [string, NetworkProbeTarget] => {
        const target = targets[name];
        assert.ok(target && Object.hasOwn(targets, name), `Unknown network probe target ${name}`);
        // A later TLS failure must not hide a policy that allowed the TCP connection.
        return [
          name,
          tcpOnly.includes(name) && target.ca !== undefined
            ? { host: target.host, port: target.port }
            : target,
        ];
      }),
    );
    return readResults(
      await kubectl(
        "exec",
        "--namespace",
        from.namespace,
        source.toLowerCase(),
        "--",
        ...inlineProbeCommand(probeSource, JSON.stringify(selected)),
      ),
      names,
    );
  }

  async function controls(
    names: readonly string[],
    controlSource?: string,
    envoyEnabled = false,
  ): Promise<void> {
    for (const source of controlSource ? [controlSource] : ["operator", "api"]) {
      const selected = controlSource
        ? names
        : names.filter(
            (name) => (envoyEnabled && name === "envoy" ? "api" : "operator") === source,
          );
      if (!selected.length) {
        continue;
      }
      let last: ProbeResults | undefined;
      await waitFor(
        `${source}: reachable positive controls ${selected}`,
        async () => {
          const results = await probe(source, selected);
          last = results;
          return selected.every((name) => results[name] === "connected");
        },
        30_000,
      ).catch((error: unknown) => {
        diagnostic(`${source}: last positive-control results ${JSON.stringify(last)}`);
        throw error;
      });
    }
  }

  async function verify(
    { source, allow = [], deny = [], controlSource }: Scenario,
    envoyEnabled: boolean,
  ): Promise<void> {
    const names = [...allow, ...deny];
    await controls(names, controlSource, envoyEnabled);
    let consecutive = 0;
    let last: ProbeResults | undefined;
    await waitFor(
      `${source}: allow ${allow}; deny ${deny}`,
      async () => {
        const results = await probe(source, names, deny);
        last = results;
        for (const name of names) {
          const result = results[name];
          assert.ok(
            result === "connected" || isDenied(result),
            `${source} -> ${name}: unexpected probe result ${result}`,
          );
        }
        const matches =
          allow.every((name) => results[name] === "connected") &&
          deny.every((name) => isDenied(results[name]));
        consecutive = matches ? consecutive + 1 : 0;
        return consecutive >= (deny.length ? 2 : 1);
      },
      30_000,
    ).catch((error: unknown) => {
      diagnostic(`${source}: last connection results ${JSON.stringify(last)}`);
      throw error;
    });
    await controls(names, controlSource, envoyEnabled);
    diagnostic(`${source}: allow [${allow.join(", ")}]; deny [${deny.join(", ")}]`);
  }

  return { controls, verify };
}
