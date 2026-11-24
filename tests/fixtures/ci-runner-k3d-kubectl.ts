import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type WatchRecord = { type: string; object: object };

type Watch = {
  kind: "watch";
  pods: WatchRecord[];
  events: WatchRecord[];
};

type Stop = {
  kind: "stop";
  pod: object;
  events: object[];
  logLines: string[];
};

type Startup = {
  kind: "startup";
  root: string;
  calls: string;
  deleted: string;
  earlyLogExit: boolean;
  pod: object;
  event: object;
};

export type K3dKubectlScenario = Watch | Stop | Startup;

export function runK3dKubectl(scenario: K3dKubectlScenario) {
  const args = process.argv.slice(2);
  switch (scenario.kind) {
    case "watch":
      watchAgentNamespace(args, scenario);
      break;
    case "stop":
      followGatewayStop(args, scenario);
      break;
    case "startup":
      watchControllerStartup(args, scenario);
      break;
  }
}

function watchAgentNamespace(args: string[], { pods, events }: Watch) {
  const query = args.at(-1);
  assert.ok(query);
  const records = query.startsWith("/api/v1/pods?") ? pods : events;
  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  process.stdout.write('{"type":"MODIFIED","object":');
  // A live watch runs until stopped; a stranded one exits on its own after a minute.
  setTimeout(() => {}, 60_000);
}

function followGatewayStop(args: string[], { pod, events, logLines }: Stop) {
  if (args.includes("logs")) {
    process.stdout.write(`${logLines.join("\n")}\n`);
    process.stdout.write(`2026-10-08T07:43:53.6Z child value ${process.env.OCC_TEST_CHILD_ONLY}\n`);
    // Split one structured record across actual pipe writes; neither fragment may persist.
    process.stdout.write('2026-10-08T07:43:53.7Z OCSF-JSON {"detail":"private-structured-split');
    setTimeout(() => process.stdout.write('-tail"}\n'), 100);
    process.stderr.write(
      "follow note\nGET https://api Authorization: Bearer do-not-publish-verbose",
    );
    setTimeout(() => process.stdout.write("2026-10-08T07:44:22.0Z [gateway] exit 0"), 300);
  } else if (args.includes("get") && args.includes("pods")) {
    process.stdout.write(JSON.stringify({ items: [pod] }));
  } else if (args.includes("get") && args.includes("events")) {
    process.stdout.write(JSON.stringify({ items: events }));
  } else {
    setTimeout(() => {}, 60_000);
  }
}

function watchControllerStartup(
  args: string[],
  { root, calls, deleted, earlyLogExit, pod, event }: Startup,
) {
  appendFileSync(calls, `${JSON.stringify(args)}\n`);
  if (args.includes("logs") || args.includes("wait")) {
    const deployment = args.find((arg) => arg.startsWith("deployment/"));
    assert.ok(deployment);
    const ready = join(root, `${deployment.replace("/", "-")}.ready`);
    if (args.includes("logs")) {
      const follow = args.includes("--follow=true");
      if (earlyLogExit && follow) {
        writeFileSync(ready, "ready");
        process.stderr.write("container is waiting to start: ContainerCreating");
        process.exit(1);
      }
      process.stdout.write(
        "startup: configured role still has bindings\nAuthorization: Bearer private-header\n",
      );
      writeFileSync(ready, "ready");
      if (follow) {
        setTimeout(() => {}, 60_000);
      }
    } else {
      const deadline = Date.now() + 5_000;
      const check = () => {
        if (!existsSync(ready) && Date.now() < deadline) {
          setTimeout(check, 10);
          return;
        }
        if (deployment === "deployment/healthy") {
          process.exit(0);
        }
        process.stderr.write(
          "error: timed out waiting for the condition on deployments/openclaw-enterprise-api\n",
        );
        process.exit(1);
      };
      check();
    }
  } else if (args.includes("--raw")) {
    setTimeout(() => {}, 60_000);
  } else {
    if (existsSync(deleted) || (earlyLogExit && args.includes("events"))) {
      process.exit(1);
    }
    const items = args.includes("pods") ? [pod] : [event];
    process.stdout.write(JSON.stringify({ items }));
  }
}
