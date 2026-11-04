import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { tmpdir } from "node:os";
import { dumpYaml } from "../helpers/qa-utils.mjs";

const execute = promisify(execFile);
const selected =
  process.env.OCC_TEST_QA_MATRIX === "1" || Boolean(process.env.OCC_TEST_RUNTIME_IMAGE);

test(
  "QA Compose recreation consumes mounted state and retains strict client peers",
  {
    skip: selected ? false : "Set OCC_TEST_QA_MATRIX=1 with a local Node runtime image.",
    timeout: 180_000,
  },
  async (t) => {
    const { qaComposePeerNetwork, saveQaComposeInstallation, launcherEnvironment } =
      await import("../helpers/qa-installation.mjs");
    const image =
      process.env.OCC_TEST_QA_RUNTIME_IMAGE ||
      process.env.OCC_TEST_RUNTIME_IMAGE ||
      process.env.NODE_BASE_IMAGE;
    assert.ok(
      image,
      "a selected existing Node image is required; this fixture does not build images",
    );
    const directory = await realpath(await mkdtemp(join(tmpdir(), "qa-compose-reload-")));
    // Only synthetic/public fixture code and phase markers are mounted here.
    await chmod(directory, 0o755);
    const cluster = `qa-reload-${randomUUID().slice(0, 8)}`;
    const path = join(directory, "compose.yaml");
    const initial = {
      phase: "one",
      drivers: {
        compute: {
          configuration: { gatewayRouting: { hostname: "frontdoor", endpointPort: 8080 } },
        },
      },
    };
    await writeFile(join(directory, "installation.yaml"), dumpYaml(initial), { mode: 0o644 });
    await writeFile(join(directory, "peers.json"), "[]", { mode: 0o644 });
    await writeFile(
      join(directory, "client.cjs"),
      `
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const state=fs.readFileSync('/qa/installation.yaml','utf8'),boot=crypto.randomUUID();process.on('SIGTERM',()=>process.exit(0));
http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({state,boot,mark:process.env.QA_MARK??null}))}).listen(8090,'0.0.0.0');
`,
      { mode: 0o644 },
    );
    await writeFile(
      join(directory, "frontdoor.cjs"),
      `
const fs=require('node:fs'),http=require('node:http');process.on('SIGTERM',()=>process.exit(0));
http.createServer((q,r)=>{const peer=q.socket.remoteAddress.replace(/^::ffff:/,'');const allowed=q.url==='/healthz'||JSON.parse(fs.readFileSync('/qa/peers.json','utf8')).includes(peer);r.writeHead(allowed?200:403);r.end(allowed?'allowed':'denied')}).listen(8080,'0.0.0.0');
`,
      { mode: 0o644 },
    );
    const common = {
      image,
      restart: "no",
      read_only: true,
      cap_drop: ["ALL"],
      volumes: [`${directory}:/qa:ro`],
    };
    const client = {
      ...common,
      command: ["node", "/qa/client.cjs"],
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8090').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: "1s",
        timeout: "2s",
        retries: 30,
      },
    };
    const definition = {
      services: {
        controller: client,
        "worker-kubernetes": client,
        frontdoor: {
          ...common,
          command: ["node", "/qa/frontdoor.cjs"],
          healthcheck: {
            ...client.healthcheck,
            test: [
              "CMD",
              "node",
              "-e",
              "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
            ],
          },
        },
        denied: {
          ...common,
          command: [
            "node",
            "-e",
            "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},10000)",
          ],
        },
      },
    };
    const occupied = JSON.parse(
      await execute(
        "docker",
        [
          "network",
          "inspect",
          ...(await execute("docker", ["network", "ls", "-q"], { encoding: "utf8" })).stdout
            .trim()
            .split(/\s+/)
            .filter(Boolean),
        ],
        { encoding: "utf8" },
      ).then((r) => r.stdout),
    );
    const subnets = occupied.flatMap((n) => n.IPAM?.Config ?? []).map((n) => n.Subnet);
    // Use an unoccupied private /24; refuse larger overlapping ranges as well.
    const subnet = Array.from({ length: 254 }, (_, i) => `172.31.${i + 1}.0/24`).find((candidate) =>
      subnets.every((value) => {
        if (!value?.includes(".")) {
          return true;
        }
        const range = (cidr) => {
          const [address, bits] = cidr.split("/");
          const n = address.split(".").reduce((v, x) => (v << 8n) + BigInt(x), 0n);
          const size = 1n << (32n - BigInt(bits));
          return [(n / size) * size, (n / size) * size + size - 1n];
        };
        const [a, b] = range(candidate);
        const [c, d] = range(value);
        return b < c || a > d;
      }),
    );
    assert.ok(subnet, "owned component subnet is unavailable");
    definition.networks = { development: { ipam: { config: [{ subnet }] } } };
    for (const service of Object.values(definition.services)) {
      service.networks = { development: {} };
    }
    const overridePath = join(directory, "fixed-peers.yaml");
    await writeFile(overridePath, dumpYaml(qaComposePeerNetwork(subnet)));
    await writeFile(path, dumpYaml(definition));

    const f = {
      cluster,
      directory,
      stateDirectory: directory,
      configuration: initial,
      composePeerNetwork: qaComposePeerNetwork(subnet),
      env: launcherEnvironment(),
      async run(command, args, options = {}) {
        const result = await execute(command, args, {
          env: f.env,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          ...options,
        });
        return result.stdout;
      },
      compose(...args) {
        return f.run("docker", ["compose", "-p", cluster, "-f", path, "-f", overridePath, ...args]);
      },
      async write(name, value) {
        await writeFile(join(directory, name), value, { mode: 0o600 });
      },
    };
    t.after(async () => {
      await f.compose("down", "--volumes", "--remove-orphans", "--timeout", "5");
      for (const kind of ["container", "network"]) {
        assert.equal(
          (
            await f.run("docker", [
              kind === "container" ? "ps" : "network",
              ...(kind === "container" ? ["-a", "-q"] : ["ls", "-q"]),
              "--filter",
              `label=com.docker.compose.project=${cluster}`,
            ])
          ).trim(),
          "",
          "owned fixture resources must be absent",
        );
      }
      await rm(directory, { recursive: true });
    });
    await f.compose("up", "-d", "--no-build", "--pull", "never", "--wait");
    const ids = async () =>
      Object.fromEntries(
        await Promise.all(
          ["controller", "worker-kubernetes"].map(async (service) => {
            const id = (await f.compose("ps", "-q", service)).trim();
            const [container] = JSON.parse(await f.run("docker", ["inspect", id]));
            return [
              service,
              {
                id: container.Id,
                ips: Object.values(container.NetworkSettings.Networks).map((n) => n.IPAddress),
              },
            ];
          }),
        ),
      );
    const before = await ids();
    await writeFile(
      join(directory, "peers.json"),
      JSON.stringify(Object.values(before).flatMap((x) => x.ips)),
    );
    const from = (service, script) => f.compose("exec", "-T", service, "node", "-e", script);
    const inspectClient = async (service) =>
      JSON.parse(
        await from(
          service,
          "fetch('http://127.0.0.1:8090').then(r=>r.text()).then(t=>process.stdout.write(t))",
        ),
      );
    const peerStatus = async (service) =>
      Number(
        (
          await from(service, "fetch('http://frontdoor:8080').then(r=>console.log(r.status))")
        ).trim(),
      );
    const old = Object.fromEntries(
      await Promise.all(
        Object.keys(before).map(async (service) => [service, await inspectClient(service)]),
      ),
    );
    assert.equal(await peerStatus("controller"), 200);
    assert.equal(await peerStatus("worker-kubernetes"), 200);
    assert.equal(await peerStatus("denied"), 403);
    const updated = { ...initial, phase: "two" };
    await saveQaComposeInstallation(f, updated);
    const recreated = await ids();
    for (const service of Object.keys(before)) {
      assert.notEqual(
        recreated[service].id,
        before[service].id,
        "regular save recreates the process container",
      );
      assert.deepEqual(
        recreated[service].ips,
        before[service].ips,
        "initial exact peer IPs survive recreation",
      );
    }
    for (const service of Object.keys(before)) {
      const observed = await inspectClient(service);
      assert.notEqual(
        observed.boot,
        old[service].boot,
        "a new process must consume the mounted update",
      );
      assert.match(observed.state, /phase: two/);
      assert.equal(await peerStatus(service), 200, "the original exact peer fence stays usable");
    }
    assert.equal(await peerStatus("denied"), 403, "reload must not widen the exact peer fence");
    // Ordinary definition changes are applied by the existing recreation owner.
    const changed = structuredClone(definition);
    changed.services.controller.environment = { QA_MARK: "recreated" };
    await writeFile(path, dumpYaml(changed));
    await saveQaComposeInstallation(f, { ...updated, phase: "three" });
    assert.equal((await inspectClient("controller")).mark, "recreated");
    assert.match((await inspectClient("controller")).state, /phase: three/);
    for (const service of Object.keys(before)) {
      assert.deepEqual((await ids())[service].ips, before[service].ips);
      assert.equal(await peerStatus(service), 200);
    }
    assert.equal(await peerStatus("denied"), 403);
    const lastSaved = await readFile(join(directory, "installation.yaml"), "utf8");
    const lastBoot = (await inspectClient("controller")).boot;
    await f.compose("stop", "frontdoor");
    const started = performance.now();
    await assert.rejects(
      saveQaComposeInstallation(f, { ...updated, phase: "unreachable" }),
      /QA Gateway front door unavailable/,
    );
    assert.ok(performance.now() - started < 25_000);
    assert.equal(await readFile(join(directory, "installation.yaml"), "utf8"), lastSaved);
    assert.equal((await inspectClient("controller")).boot, lastBoot);
  },
);
