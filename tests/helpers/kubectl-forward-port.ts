export function kubectlForwardPortParser(): (chunk: Buffer) => number | undefined {
  let pendingLine: string | null = "";
  return (chunk) => {
    const lines = chunk.toString().split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      if (pendingLine !== null) {
        const port = Number(
          /^Forwarding from 127\.0\.0\.1:(\d{1,5}) -> \d{1,5}\r?$/.exec(pendingLine + line)?.[1],
        );
        if (port > 0 && port <= 65_535) {
          return port;
        }
      }
      pendingLine = "";
    }
    if (pendingLine !== null) {
      pendingLine += tail;
      // Discard an overlong line through its next newline without retaining it.
      if (pendingLine.length > 64) {
        pendingLine = null;
      }
    }
    return undefined;
  };
}
