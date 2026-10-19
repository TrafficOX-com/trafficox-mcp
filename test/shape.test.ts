import { describe, expect, it } from "vitest";
import { fitResponse } from "../src/shape.js";

const row = { hits: 123456, spent: 12.34, cpm: 0.1 };

describe("fitResponse", () => {
  it("returns small responses unchanged", () => {
    const data = { US: row };
    expect(fitResponse(data)).toBe(JSON.stringify(data));
  });

  it("trims a keyed stats map to fit and reports totals", () => {
    const data = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`d${i}.com`, row]));
    const out = fitResponse(data, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(out);
    expect(parsed._truncated.total).toBe(500);
    expect(parsed._truncated.shown).toBeGreaterThan(0);
    expect(parsed["d0.com"]).toEqual(row);
    expect(Object.keys(parsed)).toHaveLength(parsed._truncated.shown + 1);
  });

  it("trims arrays", () => {
    const out = JSON.parse(fitResponse(Array.from({ length: 500 }, () => row), 2000));
    expect(out.rows.length).toBe(out._truncated.shown);
    expect(out._truncated.total).toBe(500);
  });

  it("trims `data` arrays and keeps sibling fields like the cursor", () => {
    const data = { after: { sub_id_1: "zoo" }, data: Array.from({ length: 500 }, () => row) };
    const out = JSON.parse(fitResponse(data, 2000));
    expect(out.after).toEqual({ sub_id_1: "zoo" });
    expect(out.data.length).toBe(out._truncated.shown);
  });
});
