import { describe, expect, it } from "vitest";
import { fitResponse } from "../src/shape.js";

const row = { hits: 123456, spent: 12.34, cpm: 0.1 };

describe("fitResponse", () => {
  it("wraps small responses in data without a truncated field", () => {
    const data = { US: row };
    expect(JSON.parse(fitResponse(data))).toEqual({ data });
  });

  it("cuts a keyed stats map and reports the cut next to data, not inside it", () => {
    const data = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`d${i}.com`, row]));
    const out = fitResponse(data, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(["data", "truncated"]);
    expect(parsed.truncated.total).toBe(500);
    expect(parsed.truncated.shown).toBeGreaterThan(0);
    expect(Object.keys(parsed.data)).toHaveLength(parsed.truncated.shown);
    expect(Object.values(parsed.data).every((v) => JSON.stringify(v) === JSON.stringify(row))).toBe(true);
  });

  it("cuts arrays", () => {
    const out = JSON.parse(fitResponse(Array.from({ length: 500 }, () => row), 2000));
    expect(out.data.length).toBe(out.truncated.shown);
    expect(out.truncated.total).toBe(500);
  });

  it("cuts `data` arrays and keeps sibling fields like the cursor", () => {
    const data = { after: { sub_id_1: "zoo" }, data: Array.from({ length: 500 }, () => row) };
    const out = JSON.parse(fitResponse(data, 2000));
    expect(out.data.after).toEqual({ sub_id_1: "zoo" });
    expect(out.data.data.length).toBe(out.truncated.shown);
    expect(out.truncated.total).toBe(500);
  });

  it("uses as many rows as fit", () => {
    const data = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`d${i}.com`, row]));
    const out = JSON.parse(fitResponse(data, 2000));
    const oneMore = JSON.stringify({
      data: Object.fromEntries(Object.entries(data).slice(0, out.truncated.shown + 1)),
      truncated: out.truncated,
    });
    expect(oneMore.length).toBeGreaterThan(2000);
  });
});
