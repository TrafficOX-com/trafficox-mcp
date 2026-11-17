import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrafficoxClient } from "../src/client.js";
import { createServer } from "../src/server.js";

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };

type Reply = { status: number; body: unknown };

let calls: Call[];
let reply: Reply;
// Per-request replies keyed by "METHOD /path"; anything else gets `reply`.
let routes: Record<string, Reply>;
let client: Client;

const fakeFetch = (async (input: URL, init: RequestInit) => {
  calls.push({
    method: init.method!,
    url: new URL(input),
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  });
  const r = routes[`${init.method} ${new URL(input).pathname}`] ?? reply;
  return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
}) as typeof fetch;

beforeEach(async () => {
  calls = [];
  reply = { status: 200, body: { ok: true } };
  routes = {};
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

  it("wraps the API response body in `data`", async () => {
    reply = { status: 200, body: [{ id: "1", name: "Filter" }] };
    const res = await call("list_domain_filters");
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ data: [{ id: "1", name: "Filter" }] });
  });

  it("returns only email, username and balance from /v1/me", async () => {
    reply = {
      status: 200,
      body: { email: "a@b.c", username: "bob", balance: 2487.6403600000003, default_state: "trusted", landing_code: "X" },
    };
    const res = await call("get_account");
    expect(JSON.parse(res.text)).toEqual({ data: { email: "a@b.c", username: "bob", balance: 2487.64 } });
  });

  it("normalizes stats responses (ISO dates, empty rows dropped, rounding)", async () => {
    reply = {
      status: 200,
      body: {
        "October 30, 2026": { hits: 10, spent: 476.271269872, cpm: 47.62712698 },
        "October 31, 2026": { hits: 0, spent: 0, cpm: 0 },
      },
    };
    const res = await call("get_order_stats", { format: "popunder", side: "buy", id: "a", group_by: "day" });
    expect(JSON.parse(res.text)).toEqual({ data: { "2026-10-30": { hits: 10, spent: 476.27, cpm: 47.6271 } } });
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

describe("filter values", () => {
  it("lists categories by name using category_names", async () => {
    reply = {
      status: 200,
      body: {
        countries: ["US"],
        categories: ["687e032dfe8", "687e032afd5", "unknownid"],
        category_names: { "687e032dfe8": "Multiniche", "687e032afd5": "General" },
      },
    };
    const res = JSON.parse((await call("get_filter_values")).text);
    expect(res.data).toEqual({ countries: ["US"], categories: ["Multiniche", "General", "unknownid"] });
  });

  it("keeps IDs with a note when the API has no category_names yet", async () => {
    reply = { status: 200, body: { countries: ["US"], categories: ["687e032dfe8"] } };
    const res = JSON.parse((await call("get_filter_values")).text);
    expect(res.data.categories).toEqual(["687e032dfe8"]);
    expect(res.data.categories_note).toMatch(/names/);
  });

  it("tells the model the categories filter takes names", async () => {
    const { tools } = await client.listTools();
    const stats = tools.find((t) => t.name === "get_order_stats")!;
    const desc = (stats.inputSchema.properties as Record<string, { description?: string }>).categories.description;
    expect(desc).toMatch(/names/i);
    expect(desc).not.toMatch(/^Traffic category IDs/);
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

  it("rejects a day/hour breakdown of a day/hour grouping without calling the API", async () => {
    const order = await call("get_order_stats", {
      format: "popunder",
      side: "sell",
      id: "a",
      group_by: "day",
      subdimension: "hour",
    });
    expect(order.isError).toBe(true);
    const rtb = await call("get_rtb_stats", { format: "sticker", group_by: "hour", subdimension: "day" });
    expect(rtb.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes day/hour subdimension and large sub_size through", async () => {
    await call("get_rtb_stats", { format: "popunder", group_by: "country", subdimension: "day", sub_size: 1000 });
    expect(last().body).toEqual({ subdimension: "day", sub_size: 1000 });
    await call("get_order_stats", { format: "sticker", side: "buy", id: "a", group_by: "country", subdimension: "hour" });
    expect(last().body).toEqual({ subdimension: "hour" });
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

describe("actions with confirm: true", () => {
  it("maps buy order state to play/pause", async () => {
    await call("set_buy_order_state", { id: "x", state: "paused", confirm: true });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_orders/x/pause");
    await call("set_buy_order_state", { id: "x", state: "active", confirm: true });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_orders/x/play");
    expect(last().method).toBe("POST");
  });

  it("maps feed state to play/pause per format", async () => {
    await call("set_rtb_feed_state", { format: "sticker", id: "7", state: "paused", confirm: true });
    expect(last().url.pathname).toBe("/api/v1/sticker/rtb_feeds/7/pause");
  });

  it("wraps create_domain_filter in domain_filter", async () => {
    await call("create_domain_filter", { name: "Bad", list_type: "blacklist", domains: ["a.com"], confirm: true });
    expect(last().url.pathname).toBe("/api/v1/domain_filters");
    expect(last().body).toEqual({ domain_filter: { name: "Bad", list_type: "blacklist", domains: ["a.com"] } });
  });

  it("adds and removes domains", async () => {
    await call("add_domains_to_filter", { id: "f", domains: ["a.com"], confirm: true });
    expect(last().url.pathname).toBe("/api/v1/domain_filters/f/add_domains");
    await call("remove_domains_from_filter", { id: "f", domains: ["a.com"], confirm: true });
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
    expect(tools).toHaveLength(21);
  });

  it("tells the model where domain_id_numeric comes from on both stats tools", async () => {
    const { tools } = await client.listTools();
    for (const name of ["get_order_stats", "get_rtb_stats"]) {
      expect(tools.find((t) => t.name === name)?.description).toContain("{domain_id_numeric} URL macro");
    }
  });
});

describe("domain_id_numeric", () => {
  it("passes the id through on domain rows and source_domain sub rows", async () => {
    reply = {
      status: 200,
      body: {
        "a.com": { hits: 2, domain_id_numeric: 100123 },
        "b.com": { hits: 1, domain_id_numeric: null, sub: { US: { hits: 1 } } },
      },
    };
    const res = await call("get_order_stats", { format: "popunder", side: "buy", id: "x", group_by: "domain" });
    expect(JSON.parse(res.text).data).toEqual(reply.body);
  });
});

describe("account stats", () => {
  it("posts buy totals to /{format}/buy_stats and drops sell-only pagination", async () => {
    await call("get_account_stats", { format: "popunder", side: "buy", group_by: "day", size: 10, event_types: ["ftd"] });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_stats/daily");
    expect(last().body).toEqual({ event_types: ["ftd"] });
  });

  it("maps group_by=order to the per-order breakdown of each side", async () => {
    await call("get_account_stats", { format: "sticker", side: "sell", group_by: "order", from: 0, size: 50 });
    expect(last().url.pathname).toBe("/api/v1/sticker/sell_stats/sell_orders");
    expect(last().body).toEqual({ from: 0, size: 50 });
    await call("get_account_stats", { format: "popunder", side: "buy", group_by: "order" });
    expect(last().url.pathname).toBe("/api/v1/popunder/buy_stats/buy_orders");
  });

  it("sends subdimension=order as the side's own value", async () => {
    await call("get_account_stats", { format: "popunder", side: "buy", group_by: "day", subdimension: "order" });
    expect(last().body).toEqual({ subdimension: "buy_order" });
    await call("get_account_stats", { format: "popunder", side: "sell", group_by: "day", subdimension: "order" });
    expect(last().body).toEqual({ subdimension: "sell_order" });
  });

  it("rejects combinations the API refuses without calling it", async () => {
    for (const args of [
      { format: "popunder", side: "sell", group_by: "day", event_types: ["ftd"] },
      { format: "popunder", side: "buy", group_by: "country", subdimension: "sub_id" },
      { format: "popunder", side: "buy", group_by: "order", subdimension: "order" },
      { format: "popunder", side: "buy", group_by: "day", subdimension: "hour" },
    ]) {
      expect((await call("get_account_stats", args)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("conversion types", () => {
  it("passes event_types to buy order stats", async () => {
    await call("get_order_stats", { format: "popunder", side: "buy", id: "a", group_by: "day", event_types: ["ftd", "untyped"] });
    expect(last().body).toEqual({ event_types: ["ftd", "untyped"] });
  });

  it("rejects event_types on sell order stats without calling the API", async () => {
    const res = await call("get_order_stats", { format: "popunder", side: "sell", id: "a", group_by: "day", event_types: ["ftd"] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("tells the model about conversions_by_type on both buy stats tools", async () => {
    const { tools } = await client.listTools();
    for (const name of ["get_order_stats", "get_account_stats"]) {
      expect(tools.find((t) => t.name === name)?.description).toContain("conversions_by_type");
    }
  });
});

const json = (res: { text: string }) => JSON.parse(res.text);
const writes = () => calls.filter((c) => c.method !== "GET");

describe("write tools preview without confirm", () => {
  const order = { id: "aa11", id_numeric: 105002, name: "Spring promo", state: "active", order_filter: { countries: ["US"] } };
  const filter = { id: "f1", name: "Bad sources", list_type: "blacklist", domains: ["a.com", "b.com"], domains_count: 2 };

  it("never writes without confirm: true, for every non-read-only tool", async () => {
    const { tools } = await client.listTools();
    const args: Record<string, Record<string, unknown>> = {
      set_buy_order_state: { id: "x", state: "paused" },
      set_rtb_feed_state: { format: "popunder", id: "7", state: "active" },
      create_domain_filter: { name: "N", list_type: "blacklist", domains: ["a.com"] },
      add_domains_to_filter: { id: "f", domains: ["a.com"] },
      remove_domains_from_filter: { id: "f", domains: ["a.com"] },
    };
    reply = { status: 200, body: filter };
    for (const t of tools.filter((t) => t.annotations?.readOnlyHint !== true)) {
      for (const confirm of [undefined, false]) {
        const res = await call(t.name, { ...args[t.name], ...(confirm === undefined ? {} : { confirm }) });
        expect(res.isError, t.name).toBe(false);
        expect(json(res).data.apply).toBe("Call again with confirm: true after the user agrees.");
        expect(json(res).data.preview.action).toBe(t.name);
      }
      expect(t.inputSchema.properties).toHaveProperty("confirm");
      expect(t.description).toContain("without confirm=true NOTHING is changed");
    }
    expect(writes()).toEqual([]);
  });

  it("writes exactly once and reads nothing first when confirmed", async () => {
    await call("set_buy_order_state", { id: "x", state: "paused", confirm: true });
    await call("add_domains_to_filter", { id: "f", domains: ["a.com"], confirm: true });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("previews a buy order state change with the order name and both states", async () => {
    reply = { status: 200, body: order };
    const res = await call("set_buy_order_state", { id: "105002", state: "paused" });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /api/v1/popunder/buy_orders/105002"]);
    expect(json(res).data.preview).toEqual({
      action: "set_buy_order_state",
      order: { id: "aa11", id_numeric: 105002, name: "Spring promo" },
      current_state: "active",
      new_state: "paused",
    });
  });

  it("notes when the order is already in the requested state, and what activating does", async () => {
    reply = { status: 200, body: order };
    const same = json(await call("set_buy_order_state", { id: "x", state: "active" })).data.preview;
    expect(same.note).toContain("already active");
    reply = { status: 200, body: { ...order, state: "paused" } };
    const start = json(await call("set_buy_order_state", { id: "x", state: "active" })).data.preview;
    expect(start.note).toContain("spending balance");
    expect(start.note).not.toContain("already");
    reply = { status: 200, body: { ...order, state: "suspended" } };
    expect(json(await call("set_buy_order_state", { id: "x", state: "paused" })).data.preview.note).toContain("may refuse");
  });

  it("previews a feed state change with the feed display name", async () => {
    reply = { status: 200, body: { id: "ff", id_numeric: 7, name: "", display_name: "bidder.x.com #7", state: "paused" } };
    const res = await call("set_rtb_feed_state", { format: "sticker", id: "7", state: "active" });
    expect(last().url.pathname).toBe("/api/v1/sticker/rtb_feeds/7");
    expect(json(res).data.preview).toMatchObject({
      feed: { id: "ff", id_numeric: 7, name: "bidder.x.com #7" },
      current_state: "paused",
      new_state: "active",
    });
  });

  it("previews create_domain_filter from the arguments alone", async () => {
    const res = await call("create_domain_filter", {
      name: "Junk",
      list_type: "blacklist",
      domains: ["https://a.com/x", "a.com", "not a domain"],
      ips: ["10.0.0.0/8"],
    });
    expect(calls).toHaveLength(0);
    expect(json(res).data.preview.will_create).toMatchObject({
      name: "Junk",
      list_type: "blacklist",
      domains: { count: 1, domains: ["a.com"] },
      invalid: { count: 1, domains: ["not a domain"] },
      ips: ["10.0.0.0/8"],
    });
  });

  it("previews add_domains: new, already present, invalid, size before and after", async () => {
    reply = { status: 200, body: filter };
    const res = await call("add_domains_to_filter", {
      id: "f1",
      domains: ["a.com", "https://c.com/path", "c.com", "d.com", "bad domain"],
    });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /api/v1/domain_filters/f1"]);
    const p = json(res).data.preview;
    expect(p.filter).toEqual({ id: "f1", name: "Bad sources", list_type: "blacklist" });
    expect(p.new).toEqual({ count: 2, domains: ["c.com", "d.com"] });
    expect(p.already_present).toEqual({ count: 1, domains: ["a.com"] });
    expect(p.invalid).toMatchObject({ count: 1, domains: ["bad domain"] });
    expect(p).toMatchObject({ domains_before: 2, domains_after: 4, max_domains: 15000, within_limit: true });
  });

  it("warns that add_domains is refused once stored + submitted reaches 15,000", async () => {
    const stored = Array.from({ length: 14_998 }, (_, i) => `d${i}.com`);
    reply = { status: 200, body: { ...filter, domains: stored, domains_count: stored.length } };
    const fits = json(await call("add_domains_to_filter", { id: "f1", domains: ["x.com"] })).data.preview;
    expect(fits).toMatchObject({ within_limit: true, domains_before: 14_998, domains_after: 14_999 });
    const over = json(await call("add_domains_to_filter", { id: "f1", domains: ["x.com", "y.com"] })).data.preview;
    expect(over).toMatchObject({ within_limit: false, domains_after: 14_998 });
    expect(over.limit_note).toContain("15000");
  });

  it("previews remove_domains: present, not present, size before and after", async () => {
    reply = { status: 200, body: filter };
    const p = json(await call("remove_domains_from_filter", { id: "f1", domains: ["a.com", "a.com", "z.com"] })).data.preview;
    expect(p.removed).toEqual({ count: 1, domains: ["a.com"] });
    expect(p.not_present).toMatchObject({ count: 1, domains: ["z.com"] });
    expect(p).toMatchObject({ domains_before: 2, domains_after: 1 });
  });

  it("caps the domain lists shown in a preview at 100 with a count of the rest", async () => {
    reply = { status: 200, body: { ...filter, domains: [] } };
    const domains = Array.from({ length: 150 }, (_, i) => `n${i}.com`);
    const p = json(await call("add_domains_to_filter", { id: "f1", domains })).data.preview;
    expect(p.new.count).toBe(150);
    expect(p.new.domains).toHaveLength(100);
    expect(p.new.not_shown).toBe(50);
  });

  it("says so when the account hides domain names", async () => {
    reply = { status: 200, body: { id: "f1", name: "Hidden", list_type: "blacklist", domain_ids: [1, 2], domains_count: 2 } };
    const p = json(await call("add_domains_to_filter", { id: "f1", domains: ["a.com"] })).data.preview;
    expect(p).toMatchObject({ domains_before: 2, submitted: 1 });
    expect(p.note).toContain("hides source domain names");
  });

  it("returns the lookup error and writes nothing when the record cannot be read", async () => {
    reply = { status: 404, body: { error: "Not found" } };
    const res = await call("set_buy_order_state", { id: "nope", state: "paused" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("404");
    expect(writes()).toEqual([]);
  });
});

describe("list filtering and paging", () => {
  const feeds = [
    { id: "a1", id_numeric: 101, name: "Alpha DSP", display_name: "Alpha DSP", state: "active" },
    { id: "b2", id_numeric: 102, name: "", display_name: "bidder.beta.io #102", state: "paused" },
    { id: "c3", id_numeric: 103, name: "Gamma", display_name: "Gamma", state: "active" },
    { id: "d4", id_numeric: 1010, name: "alphabet", display_name: "alphabet", state: "paused" },
  ];

  it("returns items with total, pages and counts over the whole account", async () => {
    reply = { status: 200, body: feeds };
    const res = json(await call("list_rtb_feeds", { format: "popunder" }));
    expect(last().url.pathname).toBe("/api/v1/popunder/rtb_feeds");
    expect(res.data).toEqual({ items: feeds, total: 4, page: 1, per_page: 50, pages: 1, counts_by_state: { active: 2, paused: 2 } });
  });

  it("filters by state; counts stay unfiltered", async () => {
    reply = { status: 200, body: feeds };
    const res = json(await call("list_rtb_feeds", { format: "popunder", state: "paused" })).data;
    expect(res.items.map((f: { id: string }) => f.id)).toEqual(["b2", "d4"]);
    expect(res.total).toBe(2);
    expect(res.counts_by_state).toEqual({ active: 2, paused: 2 });
  });

  it("searches names case-insensitively, display names, and exact ids", async () => {
    reply = { status: 200, body: feeds };
    const ids = async (search: string) =>
      json(await call("list_rtb_feeds", { format: "popunder", search })).data.items.map((f: { id: string }) => f.id);
    expect(await ids("ALPHA")).toEqual(["a1", "d4"]);
    expect(await ids("beta.io")).toEqual(["b2"]);
    expect(await ids("101")).toEqual(["a1"]);
    expect(await ids("C3")).toEqual(["c3"]);
    expect(await ids("zzz")).toEqual([]);
  });

  it("combines state and search", async () => {
    reply = { status: 200, body: feeds };
    const res = json(await call("list_rtb_feeds", { format: "popunder", state: "active", search: "alpha" })).data;
    expect(res.items.map((f: { id: string }) => f.id)).toEqual(["a1"]);
  });

  it("pages orders with page/per_page", async () => {
    const orders = Array.from({ length: 7 }, (_, i) => ({ id: `o${i + 1}`, id_numeric: i + 1, name: `Order ${i + 1}`, state: "active" }));
    reply = { status: 200, body: orders };
    const page2 = json(await call("list_orders", { format: "sticker", side: "buy", page: 2, per_page: 3 })).data;
    expect(last().url.pathname).toBe("/api/v1/sticker/buy_orders");
    expect(last().url.search).toBe("");
    expect(page2).toMatchObject({ total: 7, page: 2, per_page: 3, pages: 3 });
    expect(page2.items.map((o: { id: string }) => o.id)).toEqual(["o4", "o5", "o6"]);
    const page3 = json(await call("list_orders", { format: "sticker", side: "buy", page: 3, per_page: 3 })).data;
    expect(page3.items.map((o: { id: string }) => o.id)).toEqual(["o7"]);
    const beyond = json(await call("list_orders", { format: "sticker", side: "buy", page: 4, per_page: 3 })).data;
    expect(beyond.items).toEqual([]);
  });

  it("defaults to 50 per page and caps per_page at 200", async () => {
    reply = { status: 200, body: Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, name: `O${i}`, state: "paused" })) };
    const res = json(await call("list_orders", { format: "popunder", side: "sell" })).data;
    expect(res.items).toHaveLength(50);
    expect(res.pages).toBe(2);
    expect((await call("list_orders", { format: "popunder", side: "sell", per_page: 201 })).isError).toBe(true);
    expect((await call("list_orders", { format: "popunder", side: "sell", per_page: 200 })).isError).toBe(false);
  });

  it("rejects an unknown state", async () => {
    expect((await call("list_rtb_feeds", { format: "popunder", state: "pending" })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("feed names in RTB stats", () => {
  const stats = {
    US: { hits: 10, spent: 1, sub: { a1: { hits: 6, spent: 0.6 }, "102": { hits: 3, spent: 0.3 }, gone: { hits: 1, spent: 0.1 } } },
    DE: { hits: 2, spent: 0.2, sub: { a1: { hits: 2, spent: 0.2 } } },
  };
  const feedList = [
    { id: "a1", id_numeric: 101, name: "Alpha", display_name: "Alpha", state: "active" },
    { id: "b2", id_numeric: 102, name: "", display_name: "bidder.beta.io #102", state: "paused" },
  ];

  it("adds the feed name to feed sub rows with one extra GET", async () => {
    routes = {
      "POST /api/v1/rtb_stats/countries": { status: 200, body: stats },
      "GET /api/v1/popunder/rtb_feeds": { status: 200, body: feedList },
    };
    const res = json(await call("get_rtb_stats", { format: "popunder", group_by: "country", subdimension: "feed" }));
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/rtb_stats/countries",
      "GET /api/v1/popunder/rtb_feeds",
    ]);
    expect(res.data.US.sub).toEqual({
      a1: { hits: 6, spent: 0.6, name: "Alpha" },
      "102": { hits: 3, spent: 0.3, name: "bidder.beta.io #102" },
      gone: { hits: 1, spent: 0.1, name: null },
    });
    expect(res.data.DE.sub.a1.name).toBe("Alpha");
  });

  it("returns the stats without names when the feed list fails", async () => {
    routes = {
      "POST /api/v1/rtb_stats/countries": { status: 200, body: stats },
      "GET /api/v1/popunder/rtb_feeds": { status: 500, body: "boom" },
    };
    const res = await call("get_rtb_stats", { format: "popunder", group_by: "country", subdimension: "feed" });
    expect(res.isError).toBe(false);
    expect(json(res).data).toEqual(stats);
  });

  it("does not look feeds up for other breakdowns", async () => {
    reply = { status: 200, body: { US: { hits: 1, spent: 1, sub: { mobile: { hits: 1, spent: 1 } } } } };
    const res = json(await call("get_rtb_stats", { format: "popunder", group_by: "country", subdimension: "platform" }));
    expect(calls).toHaveLength(1);
    expect(res.data.US.sub.mobile).not.toHaveProperty("name");
  });
});

describe("prompts", () => {
  afterEach(() => vi.useRealTimers());

  async function prompt(name: string, args: Record<string, string> = {}) {
    const res = await client.getPrompt({ name, arguments: args });
    return (res.messages[0].content as { text: string }).text;
  }

  it("lists the four workflows with their arguments", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["compare_periods", "daily_report", "find_bad_domains", "top_placements"]);
    const args = (name: string) => prompts.find((p) => p.name === name)?.arguments?.map((a) => `${a.name}${a.required ? "*" : ""}`);
    expect(args("daily_report")).toEqual(["date", "format"]);
    expect(args("compare_periods")).toEqual(["period_a*", "period_b*", "side*", "format*", "group_by"]);
    expect(args("find_bad_domains")).toEqual(["order_id*", "format*", "date_start", "date_end", "min_spend"]);
    expect(args("top_placements")).toEqual(["format*", "date_start", "date_end"]);
  });

  it("daily_report defaults to yesterday UTC vs the day before, both formats", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T01:30:00Z"));
    const text = await prompt("daily_report");
    expect(text).toContain("for 2026-11-16 (UTC), compared with 2026-11-15");
    expect(text).toContain("Formats: popunder, sticker");
    expect(text).toContain("get_account_stats side=buy group_by=order");
    expect(text).toContain("get_account_stats side=sell group_by=order");
    expect(text).toContain("get_balance_stats with date_start=2026-11-15, date_end=2026-11-16");
  });

  it("daily_report takes a date, `today` and one format", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    expect(await prompt("daily_report", { date: "today", format: "sticker" })).toContain(
      "for 2026-03-01 (UTC), compared with 2026-02-28. Formats: sticker.",
    );
    expect(await prompt("daily_report", { date: "2026-01-01" })).toContain("compared with 2025-12-31");
  });

  it("compare_periods splits ranges and defaults to group_by=order", async () => {
    const text = await prompt("compare_periods", {
      period_a: "2026-10-01..2026-10-07",
      period_b: "2026-10-08",
      side: "sell",
      format: "popunder",
    });
    expect(text).toContain("period A (2026-10-01 – 2026-10-07) with period B (2026-10-08 – 2026-10-08)");
    expect(text).toContain("group_by=order date_start=2026-10-01 date_end=2026-10-07");
    expect(text).toContain("date_start=2026-10-08 date_end=2026-10-08");
    expect(text).toContain("% change");
    expect(text).toContain("earned / sold × 1000");
    expect(await prompt("compare_periods", { period_a: "2026-10-01", period_b: "2026-10-02", side: "buy", format: "sticker", group_by: "country" })).toContain(
      "group_by=country",
    );
  });

  it("find_bad_domains proposes a blacklist through the preview flow only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
    const text = await prompt("find_bad_domains", { order_id: "105002", format: "popunder", min_spend: "5" });
    expect(text).toContain("buy order 105002, 2026-11-11 – 2026-11-17");
    expect(text).toContain("get_order_stats format=popunder side=buy id=105002 group_by=domain");
    expect(text).toContain("spent ≥ $5");
    // Both proposal paths start with a preview call.
    expect(text).toMatch(/call add_domains_to_filter [^\n]*WITHOUT confirm/);
    expect(text).toMatch(/call create_domain_filter [^\n]*WITHOUT confirm/);
    expect(text).toContain("Only after the user explicitly says yes");
    expect(text).toContain("confirm: true");
  });

  it("top_placements uses the given range and sell totals", async () => {
    const text = await prompt("top_placements", { format: "sticker", date_start: "2026-11-01", date_end: "2026-11-10" });
    expect(text).toContain("sticker sell orders, 2026-11-01 – 2026-11-10");
    expect(text).toContain("get_account_stats format=sticker side=sell group_by=order");
    expect(text).toContain("group_by=country");
  });

  it("rejects malformed arguments", async () => {
    await expect(
      client.getPrompt({ name: "compare_periods", arguments: { period_a: "last week", period_b: "2026-10-01", side: "buy", format: "popunder" } }),
    ).rejects.toThrow();
    await expect(client.getPrompt({ name: "find_bad_domains", arguments: { order_id: "1", format: "popunder", min_spend: "lots" } })).rejects.toThrow();
  });

  it("are mentioned in the server instructions together with the confirm flow", () => {
    const instructions = client.getInstructions() ?? "";
    for (const name of ["daily_report", "compare_periods", "find_bad_domains", "top_placements", "change nothing without confirm: true", "counts_by_state"]) {
      expect(instructions).toContain(name);
    }
  });
});
