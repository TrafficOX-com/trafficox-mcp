import { describe, expect, it } from "vitest";
import { isoDate, normalize } from "../src/normalize.js";

describe("isoDate", () => {
  it("converts daily and hourly API keys", () => {
    expect(isoDate("October 30, 2026")).toBe("2026-10-30");
    expect(isoDate("October 05, 2026")).toBe("2026-10-05");
    expect(isoDate("April 1, 2024")).toBe("2024-04-01");
    expect(isoDate("October 30, 2026 13:00")).toBe("2026-10-30T13:00:00Z");
  });

  it("leaves everything else alone", () => {
    expect(isoDate("US")).toBeNull();
    expect(isoDate("Smarch 30, 2026")).toBeNull();
    expect(isoDate("example.com")).toBeNull();
  });
});

describe("normalize", () => {
  it("rewrites date keys at every level, including sub breakdowns", () => {
    const out = normalize({ US: { hits: 5, sub: { "October 30, 2026": { hits: 5 } } } });
    expect(out).toEqual({ US: { hits: 5, sub: { "2026-10-30": { hits: 5 } } } });
  });

  it("drops empty rows from date-keyed maps so an empty period is {}", () => {
    expect(
      normalize({
        "October 30, 2026": { hits: 0, spent: 0, cpm: 0, sub: {} },
        "October 31, 2026": { hits: 0, spent: 0, cpm: null },
      }),
    ).toEqual({});
  });

  it("treats null metrics as no data", () => {
    expect(normalize({ "October 30, 2026": { hits: 0, conversion_rate: null } })).toEqual({});
  });

  it("keeps rows that have any data", () => {
    const out = normalize({ "October 30, 2026": { hits: 0, conversions: 1 } });
    expect(out).toEqual({ "2026-10-30": { hits: 0, conversions: 1 } });
  });

  it("drops empty sub rows of a day/hour breakdown", () => {
    const out = normalize({ US: { hits: 3, sub: { "October 30, 2026": { hits: 3 }, "October 31, 2026": { hits: 0 } } } });
    expect(out).toEqual({ US: { hits: 3, sub: { "2026-10-30": { hits: 3 } } } });
  });

  it("does not drop zero rows from non-date maps", () => {
    expect(normalize({ US: { hits: 0 } })).toEqual({ US: { hits: 0 } });
  });

  it("normalizes balance_stats day lists and summary", () => {
    const out = normalize({
      data: [
        { date: "October 30, 2026", earned: 202.0200000001, spent: 0 },
        { date: "October 31, 2026", earned: 0, spent: 0 },
      ],
      summary: { earned: 202.02, spent: 0, current_balance: 2487.6403600000003 },
    });
    expect(out).toEqual({
      data: [{ date: "2026-10-30", earned: 202.02, spent: 0 }],
      summary: { earned: 202.02, spent: 0, current_balance: 2487.64 },
    });
  });

  it("rounds money to cents and unit prices to 4 decimals", () => {
    expect(
      normalize({
        spent: 476.271269872,
        earned: 1.005,
        profit: -0.123456,
        conversion_revenue: 2.499999,
        balance: 2487.6403600000003,
        payout_usd: 0.02512345,
        cpm: 1.29812345,
        cpc: 0.004123456,
        cost_per_conversion: 0.551234,
        cost_per_click: 0.00012345,
        winrate: 12.123456,
      }),
    ).toEqual({
      spent: 476.27,
      earned: 1.01,
      profit: -0.12,
      conversion_revenue: 2.5,
      balance: 2487.64,
      payout_usd: 0.0251,
      cpm: 1.2981,
      cpc: 0.0041,
      cost_per_conversion: 0.5512,
      cost_per_click: 0.0001,
      winrate: 12.123456,
    });
  });

  it("keeps a null payout (no payout) but rounds a present one", () => {
    expect(normalize({ events: [{ payout_usd: null }, { payout_usd: 0.025 }] })).toEqual({
      events: [{ payout_usd: null }, { payout_usd: 0.025 }],
    });
  });

  it("turns null unit prices into 0", () => {
    expect(normalize({ US: { sold: 0, earned: 1, cpm: null, cpc: null } })).toEqual({
      US: { sold: 0, earned: 1, cpm: 0, cpc: 0 },
    });
  });

  it("leaves ids, names and plain arrays untouched", () => {
    const orders = [{ id: "6571", id_numeric: 105002, name: "Test", bid_price: 1.5, state: "active" }];
    expect(normalize(orders)).toEqual(orders);
    expect(normalize(["a.com", "b.com"])).toEqual(["a.com", "b.com"]);
  });
});
