/** Escape in bounded pieces so retained large fields do not require one expanded string. */
export function* escapeNotificationTextParts(value: string): Generator<string, void, unknown> {
  // why: 全文の global replace は Markdown が密な大メモの match 情報を大量保持する。
  // ASCII だけを置換するため、UTF-16 の境界を跨ぐ文字も join 後の元の順序を保つ。
  for (let start = 0; start < value.length; start += 8_192) {
    yield value.slice(start, start + 8_192).replace(/[\\`*_~|<>[\]()#]/g, "\\$&");
  }
}

// Escape user text before it enters Discord Markdown; keep the stored snapshot untouched.
export const escapeNotificationText = (value: string): string => [...escapeNotificationTextParts(value)].join("");

const CONTENT_LIMIT = 1_900;

/** Stream exactly the retained renderer's splits, keeping only one small pending window. */
export function* splitNotificationTextParts(parts: Iterable<string>): Generator<string, void, unknown> {
  let pending = "";
  for (const part of parts) {
    for (let start = 0; start < part.length; start += 8_192) {
      pending += part.slice(start, start + 8_192);
      // invariant: 最後の1900単位は改行を含んでも分割しない。続きがあるときだけ境界を選ぶ。
      while (pending.length > CONTENT_LIMIT) {
        let end = CONTENT_LIMIT;
        const newline = pending.slice(0, end).lastIndexOf("\n");
        if (newline >= 0) { end = newline + 1; }
        else {
          const last = pending.charCodeAt(end - 1);
          if (last >= 0xd800 && last <= 0xdbff) { end -= 1; }
          let escapes = 0;
          for (let index = end - 1; index >= 0 && pending[index] === "\\"; index -= 1) { escapes += 1; }
          if (escapes % 2 !== 0) { end -= 1; }
        }
        yield pending.slice(0, end);
        pending = pending.slice(end);
      }
    }
  }
  if (pending.length > 0) { yield pending; }
}

/** Split without losing whitespace, surrogate pairs, or Markdown escape pairs. */
export const splitNotificationText = (text: string): readonly string[] => [...splitNotificationTextParts([text])];
