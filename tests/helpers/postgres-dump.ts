export function canonicalizeDumpRows(dump: string): string {
  // COPY text escapes embedded newlines; only a standalone \. ends its rows.
  // Sort complete encoded rows without trimming, decoding or removing duplicates.
  return dump.replace(
    /^(COPY [^\n]+ FROM stdin;\n)([\s\S]*?)(^\\\.\n)/gm,
    (_section: string, header: string, rows: string, terminator: string) => {
      const ordered = rows === "" ? "" : `${rows.slice(0, -1).split("\n").sort().join("\n")}\n`;
      return `${header}${ordered}${terminator}`;
    },
  );
}
