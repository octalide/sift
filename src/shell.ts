// one shell word: single quotes verbatim, double quotes with backslash escapes, else up to whitespace
export function shellWord(text: string): string | undefined {
  if (text.length === 0) return undefined;
  const q = text[0];
  if (q === "'") {
    const end = text.indexOf("'", 1);
    return end < 0 ? text.slice(1) : text.slice(1, end);
  }
  if (q === '"') {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\' && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1]!)) {
        out += text[++i];
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  return /^\S+/.exec(text)?.[0];
}
