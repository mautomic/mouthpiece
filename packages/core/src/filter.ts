export interface FilterOptions {
  minChars: number;
  trivial: readonly string[];
}

export function shouldSpeak(cleanText: string, { minChars, trivial }: FilterOptions): boolean {
  const text = cleanText.trim();
  if (text.length < minChars) return false;
  const normalized = text.toLowerCase().replace(/[.!?\s]+$/, "");
  return !trivial.some((t) => t.toLowerCase() === normalized);
}
