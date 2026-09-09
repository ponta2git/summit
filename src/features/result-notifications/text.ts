// Escape user text before it enters Discord Markdown; keep the stored snapshot untouched.
export const escapeNotificationText = (value: string): string =>
  value.replace(/[\\`*_~|<>[\]()#]/g, "\\$&");

const CONTENT_LIMIT = 1_900;

/** Split without losing whitespace, surrogate pairs, or Markdown escape pairs. */
export const splitNotificationText = (text: string): readonly string[] => {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CONTENT_LIMIT, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= start) {
        end = newline + 1;
      } else {
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) { end -= 1; }
        let escapes = 0;
        for (let index = end - 1; index >= start && text[index] === "\\"; index -= 1) {
          escapes += 1;
        }
        if (escapes % 2 !== 0) { end -= 1; }
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
};
