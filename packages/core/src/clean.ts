const MAX_INLINE_CODE_CHARS = 40;
const FENCE = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
const UNCLOSED_FENCE = /^(```|~~~)[^\n]*\n([\s\S]*)$/m;
const PLACEHOLDER = /\uE000(\d+)\uE000/g;

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

function replaceFences(text: string): string {
  const describe = (_: string, __: string, body: string) => {
    const lines = body.replace(/\n$/, "").split("\n").length;
    return `(code block, ${lines} ${lines === 1 ? "line" : "lines"})`;
  };
  return text.replace(FENCE, describe).replace(UNCLOSED_FENCE, describe);
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
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\bhttps?:\/\/(?:www\.)?([^\s/)?#]+)[^\s)]*/g, "link to $1"),
  )
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");
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
