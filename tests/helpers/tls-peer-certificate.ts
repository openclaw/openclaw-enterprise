import { connect, type ConnectionOptions } from "node:tls";

type TlsPeerCertificateOptions = {
  host: string;
  port: number;
  servername: string;
  ca?: ConnectionOptions["ca"];
  timeoutMs?: number | undefined;
};

/** Read a verified TLS leaf for the browser's scoped certificate trust. */
export async function tlsPeerCertificate({
  host,
  port,
  servername,
  ca,
  timeoutMs = 10_000,
}: TlsPeerCertificateOptions): Promise<string> {
  const socket = connect({ host, port, servername, ca, rejectUnauthorized: true });
  let deadline: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new Error(`TLS certificate handshake timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    const certificate = socket.getPeerX509Certificate();
    if (certificate === undefined) {
      throw new Error("TLS peer did not present a certificate");
    }
    return certificate.toString();
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}
