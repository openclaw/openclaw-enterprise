// Preloaded into a test's Node child process by reservedPortArgs() (available-port.mjs).
// A listen() on the port named in this module's URL also sets `reusePort`, so the child can
// bind a port its parent test still holds with reservePort(). Every other listen() is
// unchanged.
import net from "node:net";

const reserved = Number(new URL(import.meta.url).searchParams.get("port"));
const listen = net.Server.prototype.listen;

function isReserved(port) {
  return (
    (typeof port === "number" || (typeof port === "string" && /^[0-9]+$/.test(port))) &&
    Number(port) === reserved
  );
}

net.Server.prototype.listen = function listenWithReservedPort(...args) {
  const [first] = args;
  if (first !== null && typeof first === "object" && isReserved(first.port)) {
    args[0] = { ...first, reusePort: true };
  } else if (isReserved(first)) {
    // listen(port[, host][, backlog][, callback])
    const [port, ...rest] = args;
    const options = { port: Number(port), reusePort: true };
    if (typeof rest[0] === "string") {
      options.host = rest.shift();
    }
    if (typeof rest[0] === "number") {
      options.backlog = rest.shift();
    }
    args = [options, ...rest];
  }
  return listen.apply(this, args);
};
