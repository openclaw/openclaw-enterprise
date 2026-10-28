// Relays bytes both ways between two connected stream sockets, as a test TCP forwarder or
// HTTP CONNECT tunnel does. A side that ends cleanly ends the other side through pipe(), so
// bytes still queued for a slower reader are written first: the credential gateway closes
// each connection after one response, and destroying the client on that close cut the tail
// of a TLS record (finding 2186). A side that closes without a clean end (an error, a reset
// or a destroy) destroys the other side.
//
// Keep this function self-contained: runtime-image-startup.test.mjs ships its source into a
// container forwarder.
export function relaySockets(a, b) {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    // `close` follows every socket error, so the close handler below propagates failures.
    from.on("error", () => {});
    from.on("close", () => {
      if (!from.readableEnded) {
        to.destroy();
      }
    });
    from.pipe(to);
  }
}
