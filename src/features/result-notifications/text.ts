// Escape user text before it enters Discord Markdown; keep the stored snapshot untouched.
export const escapeNotificationText = (value: string): string => {
  const chunks: string[] = [];
  // why: 全文の global replace は Markdown が密な大メモの match 情報を大量保持する。
  // ASCII だけを置換するため、UTF-16 の境界を跨ぐ文字も join 後の元の順序を保つ。
  for (let start = 0; start < value.length; start += 8_192) {
    chunks.push(value.slice(start, start + 8_192).replace(/[\\`*_~|<>[\]()#]/g, "\\$&"));
  }
  return chunks.join("");
};

const CONTENT_LIMIT = 1_900;

/** Split without losing whitespace, surrogate pairs, or Markdown escape pairs. */
export const splitNotificationText = (text: string): readonly string[] => {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CONTENT_LIMIT, text.length);
    if (end < text.length) {
      // why: 長い一行でも、送信済みの prefix を繰り返し走査しない。
      const newline = text.slice(start, end).lastIndexOf("\n");
      if (newline >= 0) {
        end = start + newline + 1;
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
