import { describe, expect, it } from "vitest";
import { assertNotificationNumericBudget } from "../../src/domain/notificationNumericBudget.ts";

describe("notification numeric expansion budget", () => {
  it.each([
    ["0", "0"], ["-0", "0"], ["-0.000", "0.000"], ["0e+100000", "0"],
    ["-0.000e2", "0.0"], ["-0e-7", "0.0000000"], ["123", "123"], ["-123", "-123"],
    ["1.230e-5", "0.00001230"], ["-1.230E-5", "-0.00001230"],
    ["1.200e3", "1200"], ["1.200E+2", "120.0"], ["1.23456e2", "123.456"],
    ["0.0000000000001234500e+13", "1.234500"], ["0.01e1", "0.1"],
    ["9007199254740993.0100", "9007199254740993.0100"],
    ["9223372036854775807", "9223372036854775807"],
    ["1e-20", "0.00000000000000000001"], ["1200e-5", "0.01200"]
  ])("counts PostgreSQL decimal output of %s without rounding", (raw, decimal) => {
    expect(() => assertNotificationNumericBudget(raw, decimal.length)).not.toThrow();
    expect(() => assertNotificationNumericBudget(raw, decimal.length - 1))
      .toThrow(decimal.length === 1 ? "Invalid notification numeric budget" : "payload_too_large");
  });

  it.each([["1e131071", 131_072], ["-1e131071", 131_073], ["1e-16383", 16_385], ["9.999e-16380", 16_385]])(
    "accepts PostgreSQL boundary %s without expanding it", (raw, bytes) => {
      expect(() => assertNotificationNumericBudget(raw, bytes)).not.toThrow();
      expect(() => assertNotificationNumericBudget(raw, bytes - 1)).toThrow("payload_too_large");
    }
  );

  it("sums multiple values across nested containers instead of limiting each number separately", () => {
    const raw = '{"data":[1e4,{"value":-2.300e-3},"4e999999",0e1000]}';
    expect(() => assertNotificationNumericBudget(raw, 15)).not.toThrow();
    expect(() => assertNotificationNumericBudget(raw, 14)).toThrow("payload_too_large");
    expect(() => assertNotificationNumericBudget("[1e100000,1e100000,1e100000]", 256 * 1024)).toThrow("payload_too_large");
  });

  it("ignores numeric-looking keys and strings, including escaped quotes and backslashes", () => {
    const raw = JSON.stringify({ "1e100000": '"n":-1e100000, \\ \\"quoted" 日本😀', nested: ["9e99999999999999999999999999999"] });
    expect(() => assertNotificationNumericBudget(raw, 1)).not.toThrow();
    expect(() => assertNotificationNumericBudget(`{"text":${JSON.stringify('ends in slash\\')},"n":1e100000}`, 100_000))
      .toThrow("payload_too_large");
  });

  it("bounds positive and negative exponents without allocating big integers or overflowing arithmetic", () => {
    const exponent = "9".repeat(20_000);
    expect(() => assertNotificationNumericBudget(`1e${exponent}`, 256 * 1024)).toThrow("payload_too_large");
    expect(() => assertNotificationNumericBudget(`1e-${exponent}`, 256 * 1024)).toThrow("payload_too_large");
    expect(() => assertNotificationNumericBudget(`0e${exponent}`, 1)).not.toThrow();
    expect(() => assertNotificationNumericBudget("0." + "0".repeat(2_000) + "1e2001", 1)).not.toThrow();
  });

  it("counts discarded duplicate-key tokens as input work without changing their values or identity", () => {
    const raw = '{"a":1e100000,"a":1e100000,"a":1e100000,"a":0}';
    expect(() => assertNotificationNumericBudget(raw, 256 * 1024)).toThrow("payload_too_large");
    expect(() => assertNotificationNumericBudget(raw, 300_004)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])("rejects an invalid configured budget %s", budget => {
    expect(() => assertNotificationNumericBudget("1", budget)).toThrow("Invalid notification numeric budget");
  });
});
