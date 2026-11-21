import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect, createServer, isIP, type Socket } from "node:net";
import { promisify } from "node:util";

const command = promisify(execFile);

export interface ProxyObservation {
  readonly authority: string;
  readonly authenticated: boolean;
  connected: boolean;
}

export async function createControlledChannelProxy(
  context: { after(cleanup: () => Promise<void>): void },
  {
    forward = true,
    cluster: selectedCluster,
  }: { readonly forward?: boolean; readonly cluster?: string } = {},
) {
  const selectedContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
  const cluster =
    selectedCluster ?? (selectedContext?.startsWith("k3d-") ? selectedContext.slice(4) : undefined);
  if (!cluster || !/^[a-z0-9-]+$/u.test(cluster)) {
    throw new Error("Select an owned disposable k3d context for the controlled proxy.");
  }
  const engine = process.env.OCC_DOCKER_BIN ?? "docker";
  const inspected = await command(engine, ["network", "inspect", `k3d-${cluster}`]);
  const address = JSON.parse(inspected.stdout)[0]?.IPAM?.Config?.[0]?.Gateway;
  if (typeof address !== "string" || isIP(address) !== 4) {
    throw new Error("The disposable cluster bridge must expose an IPv4 gateway.");
  }
  const authorization = `Basic ${Buffer.from(`probe:${randomBytes(24).toString("hex")}`).toString("base64")}`;
  const expected = Buffer.from(authorization);
  const observations: ProxyObservation[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16 * 1024) {
        socket.destroy();
        return;
      }
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      socket.off("data", receive);
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const first = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
      const header =
        lines
          .find((line) => /^proxy-authorization:/iu.test(line))
          ?.split(":")
          .slice(1)
          .join(":")
          .trim() ?? "";
      const supplied = Buffer.from(header);
      const authenticated =
        supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const authority = first?.[1] ?? "";
      const observation: ProxyObservation = { authority, authenticated, connected: false };
      observations.push(observation);
      const remainder = buffered.subarray(end + 4);
      buffered = Buffer.alloc(0);
      if (!authenticated) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const target = /^([a-z0-9.-]+):443$/iu.exec(authority);
      const host = target?.[1]?.toLowerCase();
      const allowed =
        host &&
        ["slack.com", "slack-edge.com", "slack-msgs.com"].some(
          (suffix) => host === suffix || host.endsWith(`.${suffix}`),
        );
      if (!forward || !allowed || !host) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(443, host);
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("error", () => {
        if (!socket.destroyed) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        }
      });
      upstream.once("connect", () => {
        observation.connected = true;
        socket.setTimeout(0);
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (remainder.length) {
          upstream.write(remainder);
        }
        socket.pipe(upstream).pipe(socket);
      });
    };
    socket.on("data", receive);
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  context.after(stop);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const listening = server.address();
  if (!listening || typeof listening === "string") {
    throw new Error("The controlled proxy did not bind an IPv4 port.");
  }
  return {
    url: `http://${address}:${listening.port}`,
    address,
    port: listening.port,
    authorization,
    observations,
    stop,
  };
}
