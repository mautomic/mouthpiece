const MAX_INLINE_CODE_CHARS = 40;
const PLACEHOLDER = /\uE000(\d+)\uE000/g;
// Every pattern below must stay linear: the daemon cleans untrusted text on its event loop.
// Bracket text cannot contain brackets, and a URL allows one level of balanced parens, so a
// failed match never rescans past the next bracket or paren.
const LINK_URL = String.raw`\(([^()]*(?:\([^()]*\)[^()]*)*)\)`;
const IMAGE = new RegExp(String.raw`!\[([^[\]]*)\]${LINK_URL}`, "g");
const LINK = new RegExp(String.raw`\[([^[\]]+)\]${LINK_URL}`, "g");

export function cleanForSpeech(markdown: string): string {
  const text = replaceFences(markdown.replace(/\r\n?/g, "\n"));
  return text
    .split("\n")
    .map(cleanLine)
    .filter((line) => line !== "")
    .map(ensureTerminalPunctuation)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One pass over the lines; an unclosed fence swallows the rest of the text. */
function replaceFences(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.startsWith("```") ? "```" : line.startsWith("~~~") ? "~~~" : null;
    if (!fence || i === lines.length - 1) {
      out.push(line);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !isFenceClose(lines[end] ?? "", fence)) end++;
    const body = lines.slice(i + 1, end);
    if (end === lines.length && body.at(-1) === "") body.pop();
    const count = Math.max(1, body.length);
    out.push(`(code block, ${count} ${count === 1 ? "line" : "lines"})`);
    i = end;
  }
  return out.join("\n");
}

function isFenceClose(line: string, fence: string): boolean {
  return line.startsWith(fence) && /^[ \t]*$/.test(line.slice(fence.length));
}

function cleanLine(raw: string): string {
  let line = raw.trim();
  if (line === "" || /^([-*_])(\s*\1){2,}$/.test(line)) return "";
  if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-") && line.includes("|")) return "";
  if (line.startsWith("|") || (line.match(/\|/g) ?? []).length >= 2) {
    line = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", ");
  }
  line = line
    .replace(/^>\s?/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  return cleanInline(line).trim();
}

function cleanInline(line: string): string {
  const codes: string[] = [];
  const protectedLine = line.replace(/`([^`]+)`/g, (_, code: string) => {
    const shortened = shortenPaths(code);
    codes.push(shortened.length > MAX_INLINE_CODE_CHARS ? "(code)" : shortened);
    return `\uE000${codes.length - 1}\uE000`;
  });
  const cleaned = shortenPaths(
    protectedLine
      .replace(IMAGE, "$1")
      .replace(LINK, "$1")
      .replace(/\bhttps?:\/\/(?:www\.)?([^\s/)?#]+)[^\s)]*/g, "link to $1"),
  )
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    // Inside emphasis, only an intraword delimiter (2*3, snake_case) may appear, so a
    // failed match stops at the next possible opener instead of rescanning the line.
    .replace(/(?<![\w*])\*(?!\s)((?:[^*]|(?<=\w)\*(?=\w))+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?!\s)((?:[^_]|(?<=\w)_(?=\w))+?)(?<!\s)_(?![\w_])/g, "$1")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "");
  return cleaned.replace(PLACEHOLDER, (_, i: string) => codes[Number(i)] ?? "");
}

function shortenPaths(text: string): string {
  return text.replace(/(?<![\w.:/])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g, (path) => {
    const segments = path.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? path;
  });
}

function ensureTerminalPunctuation(line: string): string {
  return /[.!?:;…]["')\]]*$/.test(line) ? line : `${line}.`;
}
