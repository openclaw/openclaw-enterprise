import { connect } from "node:tls";

/** Read a verified TLS leaf for the browser's scoped certificate trust. */
export async function tlsPeerCertificate({ host, port, servername, ca }) {
  const socket = connect({ host, port, servername, ca });
  let deadline;
  try {
    await new Promise((resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new Error("TLS certificate handshake timed out after 10000 ms"));
      }, 10_000);
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    return socket.getPeerX509Certificate().toString();
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}
