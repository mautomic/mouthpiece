/**
 * Sets `key = value` in `[table]` of a TOML document and leaves every other line as written
 * (comments, order, blank lines, line endings). A missing key is added at the end of its table, and
 * a missing table at the end of the document. Layouts it doesn't look for (dotted keys, inline
 * tables, a multi-line value) can produce a document that doesn't parse or doesn't set the value,
 * so callers must parse the result and check it before saving it.
 */
export function setTomlValue(
  source: string,
  table: string,
  key: string,
  value: string | number,
): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source === "" ? [] : source.split(/\r?\n/);
  const assignment = `${key} = ${literal(value)}`;
  const start = lines.findIndex((line) => headerName(line) === table);
  if (start === -1) {
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(`[${table}]`, assignment, "");
    return lines.join(eol);
  }
  let end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
  for (let i = start + 1; i < end; i++) {
    const match = keyPattern.exec(lines[i] ?? "");
    if (!match) continue;
    const comment = trailingComment(lines[i] ?? "");
    lines[i] = `${match[1]}${assignment}${comment}`;
    return lines.join(eol);
  }
  let last = end - 1;
  while (last > start && lines[last]?.trim() === "") last--;
  lines.splice(last + 1, 0, assignment);
  return lines.join(eol);
}

/** `provider.kokoro` for `[provider.kokoro]` or `[ provider . kokoro ]  # x`; undefined otherwise. */
function headerName(line: string): string | undefined {
  const match = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
  return match?.[1]
    ?.split(".")
    .map((part) => part.trim())
    .join(".");
}

/** The whitespace and `# comment` after a value, found outside of quoted strings; "" when none. */
function trailingComment(line: string): string {
  let quote: string | undefined;
  for (let i = line.indexOf("=") + 1; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(line.slice(0, i).trimEnd().length);
    }
  }
  return "";
}

function literal(value: string | number): string {
  if (typeof value === "number") return String(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
