// Relays bytes both ways between two connected stream sockets, as a test TCP forwarder or
// HTTP CONNECT tunnel does. When one side closes after a clean end, the other side is ended
// and destroyed only after its queued writes finish: the credential gateway closes each
// connection after one response, and destroying the client at that close cut the tail of a
// TLS record still queued for the slower reader (finding 2186). A side that closes without a
// clean end (an error, a reset or a destroy) destroys the other side at once.
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
        return;
      }
      // Discard input nobody will read, so the close stays an orderly FIN after the
      // flushed bytes rather than a reset.
      to.resume();
      to.end();
      if (to.writableFinished) {
        to.destroy();
      } else {
        to.once("finish", () => to.destroy());
      }
    });
    from.pipe(to);
  }
}
