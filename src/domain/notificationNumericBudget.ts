import { NotificationInputError } from "./notificationInput.ts";

const digit = (code: number): boolean => code >= 48 && code <= 57;

/** Bound decimal expansion work before PostgreSQL materializes jsonb::text. */
export const assertNotificationNumericBudget = (raw: string, maximumBytes: number): void => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) { throw new Error("Invalid notification numeric budget"); }
  let expandedBytes = 0;
  let offset = 0;
  // why: 小数点の移動が入力の全桁数を相殺しても予算超過になるところで指数を飽和する。
  const exponentLimit = Math.min(Number.MAX_SAFE_INTEGER, maximumBytes + raw.length + 1);
  while (offset < raw.length) {
    const character = raw.charCodeAt(offset);
    if (character === 34) {
      offset += 1;
      while (offset < raw.length) {
        const quoted = raw.charCodeAt(offset++);
        if (quoted === 92) { offset += 1; }
        else if (quoted === 34) { break; }
      }
      continue;
    }
    if (character !== 45 && !digit(character)) { offset += 1; continue; }
    const negative = character === 45;
    if (negative) { offset += 1; }
    const integerStart = offset;
    let firstNonZero = -1;
    while (digit(raw.charCodeAt(offset))) {
      if (firstNonZero < 0 && raw.charCodeAt(offset) !== 48) { firstNonZero = offset - integerStart; }
      offset += 1;
    }
    const integerDigits = offset - integerStart;
    let fractionDigits = 0;
    if (raw.charCodeAt(offset) === 46) {
      const fractionStart = ++offset;
      while (digit(raw.charCodeAt(offset))) {
        if (firstNonZero < 0 && raw.charCodeAt(offset) !== 48) { firstNonZero = integerDigits + offset - fractionStart; }
        offset += 1;
      }
      fractionDigits = offset - fractionStart;
    }
    let exponent = 0;
    if (raw.charCodeAt(offset) === 69 || raw.charCodeAt(offset) === 101) {
      offset += 1;
      const negativeExponent = raw.charCodeAt(offset) === 45;
      if (negativeExponent || raw.charCodeAt(offset) === 43) { offset += 1; }
      while (digit(raw.charCodeAt(offset))) {
        exponent = Math.min(exponentLimit, exponent * 10 + raw.charCodeAt(offset) - 48);
        offset += 1;
      }
      if (negativeExponent) { exponent = -exponent; }
    }
    // PostgreSQL drops a zero's sign, expands E notation, and retains fractional
    // scale, including trailing zeros. No numeric value is rounded or rewritten.
    const scale = Math.max(0, fractionDigits - exponent);
    const integers = firstNonZero < 0 ? 1 : Math.max(1, integerDigits + exponent - firstNonZero);
    expandedBytes += integers + (scale > 0 ? scale + 1 : 0) + (negative && firstNonZero >= 0 ? 1 : 0);
    // invariant: 重複keyの破棄前のtokenも作業量へ計上する。canonical本文の上限はDB側で別に確認する。
    if (expandedBytes > maximumBytes) { throw new NotificationInputError("payload_too_large"); }
  }
};
