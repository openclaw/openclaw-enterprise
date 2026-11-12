// Preloaded into a test's Node child process by reservedPortArgs() (available-port.ts).
// A listen() on the port named in this module's URL also sets `reusePort`, so the child can
// bind a port its parent test still holds with reservePort(). Every other listen() is
// unchanged.
import net from "node:net";

const reserved = Number(new URL(import.meta.url).searchParams.get("port"));
const listen = net.Server.prototype.listen;

function isReserved(port: unknown): port is number | string {
  return (
    (typeof port === "number" || (typeof port === "string" && /^[0-9]+$/.test(port))) &&
    Number(port) === reserved
  );
}

net.Server.prototype.listen = function listenWithReservedPort(
  this: net.Server,
  ...args: unknown[]
): net.Server {
  const [first] = args;
  if (first !== null && typeof first === "object" && "port" in first && isReserved(first.port)) {
    args[0] = { ...first, reusePort: true };
  } else if (isReserved(first)) {
    // listen(port[, host][, backlog][, callback])
    const [port, ...rest] = args;
    const options: net.ListenOptions = { port: Number(port), reusePort: true };
    if (typeof rest[0] === "string") {
      options.host = rest[0];
      rest.shift();
    }
    if (typeof rest[0] === "number") {
      options.backlog = rest[0];
      rest.shift();
    }
    args = [options, ...rest];
  }
  const result: unknown = Reflect.apply(listen, this, args);
  if (result !== this) {
    throw new Error("Node listen did not return the listening server");
  }
  return this;
};
