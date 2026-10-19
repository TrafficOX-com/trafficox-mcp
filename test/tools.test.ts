import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { TrafficoxClient } from "../src/client.js";
import { createServer } from "../src/server.js";

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };

let calls: Call[];
let reply: { status: number; body: unknown };
let client: Client;

const fakeFetch = (async (input: URL, init: RequestInit) => {
  calls.push({
    method: init.method!,
    url: new URL(input),
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  });
  return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
    status: reply.status,
  });
}) as typeof fetch;

beforeEach(async () => {
  calls = [];
  reply = { status: 200, body: { ok: true } };
  const server = createServer(new TrafficoxClient("secret-key", "https://api.test/api/", fakeFetch));
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0].text;
  return { isError: res.isError === true, text };
}

const last = () => calls[calls.length - 1];

describe("transport", () => {
  it("sends the Api-Key header to the configured base URL", async () => {
    await call("get_account");
    expect(last().method).toBe("GET");
    expect(last().url.toString()).toBe("https://api.test/api/v1/me");
    expect(last().headers["Api-Key"]).toBe("secret-key");
  });

  it("passes query params and drops unset ones", async () => {
    await call("list_domain_filters", { search: "", list_type: "blacklist", page: 2 });
    expect(last().url.search).toBe("?list_type=blacklist&page=2");
  });

  it("returns the API response body as the tool result", async () => {
    reply = { status: 200, body: { email: "a@b.c", balance: 2 } };
    const res = await call("get_account");
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ email: "a@b.c", balance: 2 });
  });

  it("returns API errors as tool errors", async () => {
    reply = { status: 401, body: { error: "Invalid API key" } };
    const res = await call("get_account");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("401");
    expect(res.text).toContain("Invalid API key");
  });

  it("treats a 200 `{ errors }` body as a validation error", async () => {
    reply = { status: 200, body: { errors: "countries must be an array" } };
    const res = await call("get_order_stats", { format: "popunder", side: "sell", id: "1", group_by: "country" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("countries must be an array");
  });

  it("URL-encodes ids", async () => {
    await call("get_domain_filter", { id: "../v1/me" });
    expect(last().url.pathname).toBe("/api/v1/domain_filters/..%2Fv1%2Fme");
  });
});

describe("orders", () => {
  it("routes list/get by format and side", async () => {
    await call("list_orders", { format: "sticker", side: "sell" });
    expect(last().url.pathname).toBe("/api/v1/sticker/sell_orders");
    await call("get_order", { format: "popunder", side: "buy", id: "105002" });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_orders/105002");
  });

  it("maps group_by to the stats path and sends filters as body", async () => {
    await call("get_order_stats", {
      format: "popunder",
      side: "sell",
      id: "abc",
      group_by: "day",
      date_start: "2026-10-01",
      countries: ["US"],
      size: 100,
    });
    expect(last().method).toBe("POST");
    expect(last().url.pathname).toBe("/api/v1/popunder/sell_orders/abc/stats/daily");
    expect(last().body).toEqual({ date_start: "2026-10-01", countries: ["US"], size: 100 });
  });

  it("strips sell-only pagination from buy stats", async () => {
    await call("get_order_stats", {
      format: "sticker",
      side: "buy",
      id: "abc",
      group_by: "domain",
      from: 0,
      size: 10,
      order_field: "earned",
      platform: "mobile",
    });
    expect(last().url.pathname).toBe("/api/v1/sticker/buy_orders/abc/stats/domain");
    expect(last().body).toEqual({ platform: "mobile" });
  });

  it("rejects sub_id on buy orders without calling the API", async () => {
    const res = await call("get_order_stats", { format: "popunder", side: "buy", id: "a", group_by: "sub_id" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const sub = await call("get_order_stats", {
      format: "popunder",
      side: "buy",
      id: "a",
      group_by: "country",
      subdimension: "sub_id",
    });
    expect(sub.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects domain stats on sticker sell orders", async () => {
    const res = await call("get_order_stats", { format: "sticker", side: "sell", id: "a", group_by: "domain" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("calls the v2 sub-id report", async () => {
    await call("get_sub_id_report", { id: "abc", sub_ids: ["sub_id_1"], after: { sub_id_1: "zoo" } });
    expect(last().url.pathname).toBe("/api/v2/sell_orders/abc/stats/sub_ids");
    expect(last().body).toEqual({ sub_ids: ["sub_id_1"], after: { sub_id_1: "zoo" } });
  });
});

describe("rtb", () => {
  it("uses the unprefixed path for popunder account stats", async () => {
    await call("get_rtb_stats", { format: "popunder", group_by: "domain", source_domains: ["a.com"] });
    expect(last().url.pathname).toBe("/api/v1/rtb_stats/domains");
    expect(last().body).toEqual({ source_domains: ["a.com"] });
  });

  it("uses the format prefix for sticker account stats", async () => {
    await call("get_rtb_stats", { format: "sticker", group_by: "hour" });
    expect(last().url.pathname).toBe("/api/v1/sticker/rtb_stats/hourly");
  });

  it("scopes to one feed when feed_id is given", async () => {
    await call("get_rtb_stats", { format: "popunder", group_by: "country", feed_id: "105046", size: 50 });
    expect(last().url.pathname).toBe("/api/v1/popunder/rtb_feeds/105046/stats/countries");
    expect(last().body).toEqual({ size: 50 });
  });
});

describe("actions", () => {
  it("maps buy order state to play/pause", async () => {
    await call("set_buy_order_state", { id: "x", state: "paused" });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_orders/x/pause");
    await call("set_buy_order_state", { id: "x", state: "active" });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_orders/x/play");
    expect(last().method).toBe("POST");
  });

  it("maps feed state to play/pause per format", async () => {
    await call("set_rtb_feed_state", { format: "sticker", id: "7", state: "paused" });
    expect(last().url.pathname).toBe("/api/v1/sticker/rtb_feeds/7/pause");
  });

  it("wraps create_domain_filter in domain_filter", async () => {
    await call("create_domain_filter", { name: "Bad", list_type: "blacklist", domains: ["a.com"] });
    expect(last().url.pathname).toBe("/api/v1/domain_filters");
    expect(last().body).toEqual({ domain_filter: { name: "Bad", list_type: "blacklist", domains: ["a.com"] } });
  });

  it("adds and removes domains", async () => {
    await call("add_domains_to_filter", { id: "f", domains: ["a.com"] });
    expect(last().url.pathname).toBe("/api/v1/domain_filters/f/add_domains");
    await call("remove_domains_from_filter", { id: "f", domains: ["a.com"] });
    expect(last().url.pathname).toBe("/api/v1/domain_filters/f/remove_domains");
    expect(last().body).toEqual({ domains: ["a.com"] });
  });
});

describe("tool list", () => {
  it("marks only the action tools as non-read-only", async () => {
    const { tools } = await client.listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes.sort()).toEqual([
      "add_domains_to_filter",
      "create_domain_filter",
      "remove_domains_from_filter",
      "set_buy_order_state",
      "set_rtb_feed_state",
    ]);
    expect(tools).toHaveLength(20);
  });
});
