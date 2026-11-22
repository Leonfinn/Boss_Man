/** A spreadsheet reads a cell starting with = + - or @ as a formula, so such a name gets a leading quote. */
export const cell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A header line then one line per row, CRLF-separated, cells quoted where they hold a comma, quote or newline. */
export function buildCsv(head: string[], rows: Array<Array<string | number>>): string {
  const lines = rows.map((r) => r.map(cell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

/** Saves text as a file through the browser. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
