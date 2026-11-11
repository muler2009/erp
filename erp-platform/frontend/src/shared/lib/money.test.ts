import { formatMoney, parseMoney, sumMoney } from "./money";

describe("money", () => {
  it("parses exactly", () => {
    expect(parseMoney("12.5")).toBe(125000n);
    expect(parseMoney("-0.0001")).toBe(-1n);
    expect(parseMoney("100")).toBe(1000000n);
  });
  it.each(["", "abc", "1.23456", "1,000", "1e3", ".5", "--1"])("rejects %j", (v) => expect(parseMoney(v)).toBeNull());
  it("has no floating-point drift", () => {
    expect(sumMoney(["0.1", "0.2"])).toBe(parseMoney("0.3"));
    expect(sumMoney(["19999999999999.9999", "0.0001"])).toBe(parseMoney("20000000000000"));
  });
  it("formats", () => {
    expect(formatMoney("1234567.5")).toBe("1,234,567.50");
    expect(formatMoney("0.12345".slice(0, 6))).toBe("0.1234");
    expect(formatMoney("-5")).toBe("-5.00");
    expect(formatMoney(null)).toBe("—");
  });
});

import { multiplyMoney } from "./money";
describe("multiplyMoney", () => {
  it("multiplies exactly", () => {
    expect(multiplyMoney("3", "19.99")).toBe(parseMoney("59.97"));
    expect(multiplyMoney("0.1", "0.2")).toBe(parseMoney("0.02"));
    expect(multiplyMoney("x", "1")).toBe(0n);
  });
});

import { percentOf } from "./money";
describe("percentOf", () => {
  it("computes exactly", () => {
    expect(percentOf(parseMoney("100")!, "15")).toBe(parseMoney("15"));
    expect(percentOf(parseMoney("59.97")!, "15")).toBe(parseMoney("8.9955"));
    expect(percentOf(parseMoney("10")!, null)).toBe(0n);
  });
});
