import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, TrafficoxClient } from "./client.js";
import { fitResponse } from "./shape.js";

const format = z.enum(["popunder", "sticker"]).describe("Ad format");
const side = z
  .enum(["buy", "sell"])
  .describe("buy = advertiser campaigns (you pay for traffic); sell = publisher placements (you earn)");
const id = (what: string) => z.string().min(1).describe(`${what} ID (hex \`id\` or numeric \`id_numeric\`)`);
const strings = (what: string) => z.array(z.string()).optional().describe(what);

const dateNote =
  "RFC3339 (`2026-01-15T00:00:00Z`) or `2026-01-15`, UTC. Defaults to today. Max range 60 days, max lookback 90 days.";

// Body fields shared by every stats endpoint. Values for countries/categories/os/browsers come from get_filter_values.
const statsFilters = {
  date_start: z.string().optional().describe(`Range start. ${dateNote}`),
  date_end: z.string().optional().describe(`Range end. ${dateNote}`),
  countries: strings("ISO country codes, e.g. [\"US\", \"DE\"]"),
  categories: strings("Traffic categories"),
  desktop_os: strings("Desktop OS names"),
  mobile_os: strings("Mobile OS names"),
  desktop_browsers: strings("Desktop browser names"),
  mobile_browsers: strings("Mobile browser names"),
  source_domains: strings("Source (referrer) domains"),
  isp: strings("ISP names"),
  platform: z.enum(["desktop", "mobile"]).optional(),
};

const subSize = z.number().int().min(1).max(100).optional().describe("Sub-rows per row (default 20, max 100)");

// group_by value → path segment, per endpoint family.
const ORDER_GROUPS = {
  country: "countries",
  category: "categories",
  browser: "browsers",
  isp: "isp",
  platform: "platform",
  domain: "domain",
  day: "daily",
  hour: "hourly",
  sub_id: "sub_ids",
} as const;

const RTB_GROUPS = {
  country: "countries",
  category: "categories",
  browser: "browsers",
  isp: "isp",
  platform: "platform",
  domain: "domains",
  day: "daily",
  hour: "hourly",
} as const;

const READ = { readOnlyHint: true, openWorldHint: true } as const;

type Body = Record<string, unknown>;

function compact(obj: Body): Body {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: fitResponse(data) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await call());
  } catch (e) {
    if (e instanceof ApiError) return fail(e.message);
    return fail(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const enc = encodeURIComponent;

export function registerTools(server: McpServer, api: TrafficoxClient) {
  // ── Account & reference ─────────────────────────────

  server.registerTool(
    "get_account",
    {
      title: "Account",
      description: "Current TrafficOX account: email, name, balance (USD).",
      annotations: READ,
    },
    () => run(() => api.get("/v1/me")),
  );

  server.registerTool(
    "get_balance_stats",
    {
      title: "Balance by day",
      description: "Daily earned/spent (USD) for the account plus totals and current balance.",
      inputSchema: { date_start: statsFilters.date_start, date_end: statsFilters.date_end },
      annotations: READ,
    },
    (a) => run(() => api.get("/v1/balance_stats", a)),
  );

  server.registerTool(
    "get_filter_values",
    {
      title: "Filter values",
      description:
        "Valid values for stats filters: countries, categories, desktop/mobile OS, desktop/mobile browsers, platform. Call this before filtering if unsure of exact spelling.",
      annotations: READ,
    },
    () => run(() => api.get("/v1/filters")),
  );

  // ── Orders ──────────────────────────────────────────

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "All buy orders (campaigns) or sell orders (placements) of the account for one ad format.",
      inputSchema: { format, side },
      annotations: READ,
    },
    (a) => run(() => api.get(`/v1/${a.format}/${a.side}_orders`)),
  );

  server.registerTool(
    "get_order",
    {
      title: "Order details",
      description:
        "Full order details. Buy orders include targeting (order_filter), traffic filter and the attached domain filter.",
      inputSchema: { format, side, id: id("Order") },
      annotations: READ,
    },
    (a) => run(() => api.get(`/v1/${a.format}/${a.side}_orders/${enc(a.id)}`)),
  );

  server.registerTool(
    "get_order_stats",
    {
      title: "Order statistics",
      description: [
        "Statistics of one buy or sell order grouped by a dimension.",
        "Buy rows: hits, unique, desktop, mobile, spent, cpm, conversions, cost_per_conversion, conversion_rate, conversion_revenue, winrate, profit.",
        "conversions and conversion_revenue are dated by when the conversion was received (UTC), like tracker stats and list_conversion_events, while traffic and spend are dated by the click — so a day or hour can show conversions from earlier clicks, conversion_rate above 100, or conversions with 0 hits.",
        "Sell rows: total, unique, sold, sent_back, earned, cpm.",
        "group_by=sub_id is sell-only; group_by=domain is not available for sticker sell orders.",
        "subdimension adds a nested `sub` breakdown to every row (must differ from group_by).",
        "from/size/order_field/order_direction paginate sell orders only; buy orders return up to 1000 rows.",
      ].join(" "),
      inputSchema: {
        format,
        side,
        id: id("Order"),
        group_by: z.enum(Object.keys(ORDER_GROUPS) as [keyof typeof ORDER_GROUPS]),
        ...statsFilters,
        subdimension: z
          .enum(["country", "platform", "isp", "source_domain", "sub_id"])
          .optional()
          .describe("Second-level breakdown; sub_id is sell-only"),
        sub_size: subSize,
        from: z.number().int().min(0).optional().describe("Sell only: row offset"),
        size: z.number().int().min(1).max(1000).optional().describe("Sell only: rows per page (default 50)"),
        order_field: z.string().optional().describe("Sell only: earned, sold, hits, cpm or _key"),
        order_direction: z.enum(["asc", "desc"]).optional().describe("Sell only"),
      },
      annotations: READ,
    },
    (a) => {
      const { format: fmt, side: sd, id: orderId, group_by, ...rest } = a;
      if (sd === "buy" && (group_by === "sub_id" || rest.subdimension === "sub_id")) {
        return fail("sub_id grouping is available for sell orders only.");
      }
      if (sd === "sell" && fmt === "sticker" && group_by === "domain") {
        return fail("Sticker sell orders have no domain breakdown.");
      }
      if (sd === "buy") {
        delete rest.from;
        delete rest.size;
        delete rest.order_field;
        delete rest.order_direction;
      }
      return run(() =>
        api.post(`/v1/${fmt}/${sd}_orders/${enc(orderId)}/stats/${ORDER_GROUPS[group_by]}`, compact(rest)),
      );
    },
  );

  server.registerTool(
    "get_sub_id_report",
    {
      title: "Sub-ID report",
      description:
        "Sell-order earnings grouped by up to three sub-ID levels (sub_id_1..3), cursor-paginated: pass the returned `after` to get the next page. Works for any format; needs the hex order id.",
      inputSchema: {
        id: z.string().min(1).describe("Sell order hex `id` (numeric id is not accepted here)"),
        sub_ids: z
          .array(z.enum(["sub_id_1", "sub_id_2", "sub_id_3"]))
          .min(1)
          .max(3)
          .optional()
          .describe("Sub-ID levels to group by"),
        size: z.number().int().min(1).max(10000).optional().describe("Rows per page (default and max 10000)"),
        after: z.record(z.string(), z.string()).optional().describe("Cursor from the previous page"),
        ...statsFilters,
      },
      annotations: READ,
    },
    (a) => {
      const { id: orderId, ...rest } = a;
      return run(() => api.post(`/v2/sell_orders/${enc(orderId)}/stats/sub_ids`, compact(rest)));
    },
  );

  // ── RTB ─────────────────────────────────────────────

  server.registerTool(
    "list_rtb_feeds",
    {
      title: "List RTB feeds",
      description: "RTB demand feeds (DSP endpoints) of the account for one format, with state.",
      inputSchema: { format },
      annotations: READ,
    },
    (a) => run(() => api.get(`/v1/${a.format}/rtb_feeds`)),
  );

  server.registerTool(
    "get_rtb_feed",
    {
      title: "RTB feed details",
      description: "One RTB demand feed with its settings.",
      inputSchema: { format, id: id("Feed") },
      annotations: READ,
    },
    (a) => run(() => api.get(`/v1/${a.format}/rtb_feeds/${enc(a.id)}`)),
  );

  server.registerTool(
    "get_rtb_stats",
    {
      title: "RTB statistics",
      description: [
        "RTB statistics grouped by a dimension — for the whole account, or for one feed when feed_id is given.",
        "Terms groupings return 10 rows unless `size` is set.",
        "subdimension adds a nested `sub` breakdown to every row (must differ from group_by); `feed` splits rows per RTB feed.",
      ].join(" "),
      inputSchema: {
        format,
        group_by: z.enum(Object.keys(RTB_GROUPS) as [keyof typeof RTB_GROUPS]),
        feed_id: z.string().optional().describe("Limit to one feed (hex or numeric id)"),
        ...statsFilters,
        from: z.number().int().min(0).optional().describe("Row offset"),
        size: z.number().int().min(1).max(1000).optional().describe("Rows per page (default 10)"),
        subdimension: z.enum(["country", "platform", "isp", "source_domain", "feed"]).optional(),
        sub_size: subSize,
      },
      annotations: READ,
    },
    (a) => {
      const { format: fmt, group_by, feed_id, ...rest } = a;
      const segment = RTB_GROUPS[group_by];
      let path: string;
      if (feed_id) path = `/v1/${fmt}/rtb_feeds/${enc(feed_id)}/stats/${segment}`;
      // popunder account-level RTB stats live at the unprefixed /v1/rtb_stats
      else path = fmt === "popunder" ? `/v1/rtb_stats/${segment}` : `/v1/${fmt}/rtb_stats/${segment}`;
      return run(() => api.post(path, compact(rest)));
    },
  );

  // ── Domain filters ──────────────────────────────────

  server.registerTool(
    "list_domain_filters",
    {
      title: "List domain filters",
      description: "Domain blacklists/whitelists of the account, 20 per page.",
      inputSchema: {
        search: z.string().optional().describe("Substring of the filter name"),
        list_type: z.enum(["blacklist", "whitelist"]).optional(),
        page: z.number().int().min(1).optional(),
        length: z.number().int().min(1).max(20).optional().describe("Per page (max 20)"),
      },
      annotations: READ,
    },
    (a) => run(() => api.get("/v1/domain_filters", a)),
  );

  server.registerTool(
    "get_domain_filter",
    {
      title: "Domain filter",
      description: "One domain filter with its full domain list.",
      inputSchema: { id: z.string().min(1) },
      annotations: READ,
    },
    (a) => run(() => api.get(`/v1/domain_filters/${enc(a.id)}`)),
  );

  // ── Conversion tracking ─────────────────────────────

  server.registerTool(
    "list_conversion_trackers",
    {
      title: "List conversion trackers",
      description: "S2S conversion trackers of the account.",
      inputSchema: { status: z.enum(["active", "paused"]).optional() },
      annotations: READ,
    },
    (a) => run(() => api.get("/v1/conversion_trackers", a)),
  );

  server.registerTool(
    "get_conversion_tracker",
    {
      title: "Conversion tracker",
      description: "One conversion tracker with its postback settings.",
      inputSchema: { id: z.string().min(1) },
      annotations: READ,
    },
    (a) => run(() => api.get(`/v1/conversion_trackers/${enc(a.id)}`)),
  );

  server.registerTool(
    "list_conversion_events",
    {
      title: "Conversion events",
      description: "Conversion postbacks received by a tracker, newest first, paginated.",
      inputSchema: {
        id: z.string().min(1).describe("Conversion tracker ID"),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional().describe("Default 50, max 100"),
        visitor_id: z.string().optional(),
        event_type: z.enum(["install", "sale", "signup", "lead", "addr"]).optional(),
        status: z.enum(["accepted", "duplicate", "invalid_visitor", "out_of_window", "rejected"]).optional(),
      },
      annotations: READ,
    },
    (a) => {
      const { id: trackerId, ...query } = a;
      return run(() => api.get(`/v1/conversion_trackers/${enc(trackerId)}/events`, query));
    },
  );

  // ── Actions ─────────────────────────────────────────
  // Only reversible toggles and domain-list edits. Bid price and order
  // settings stay in the dashboard.

  server.registerTool(
    "set_buy_order_state",
    {
      title: "Start / pause buy order",
      description:
        "Start (active) or pause (paused) a popunder buy order. Starting it resumes buying traffic and spending balance.",
      inputSchema: { id: id("Popunder buy order"), state: z.enum(["active", "paused"]) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (a) => run(() => api.post(`/v1/popunder/buy_orders/${enc(a.id)}/${a.state === "active" ? "play" : "pause"}`)),
  );

  server.registerTool(
    "set_rtb_feed_state",
    {
      title: "Start / pause RTB feed",
      description:
        "Start (active) or pause (paused) an RTB demand feed; bidding changes within ~10 seconds. Account managers are notified.",
      inputSchema: { format, id: id("Feed"), state: z.enum(["active", "paused"]) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (a) =>
      run(() => api.post(`/v1/${a.format}/rtb_feeds/${enc(a.id)}/${a.state === "active" ? "play" : "pause"}`)),
  );

  server.registerTool(
    "create_domain_filter",
    {
      title: "Create domain filter",
      description:
        "Create a domain blacklist or whitelist. Invalid domains are skipped and listed in `rejected_domains`. Attach it to an order in the dashboard.",
      inputSchema: {
        name: z.string().min(1),
        list_type: z.enum(["blacklist", "whitelist"]),
        domains: z.array(z.string()).min(1).describe("Domain names, e.g. [\"example.com\"]"),
        ips: z.array(z.string()).optional().describe("IP addresses or CIDR blocks"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) => run(() => api.post("/v1/domain_filters", { domain_filter: compact(a) })),
  );

  server.registerTool(
    "add_domains_to_filter",
    {
      title: "Add domains to filter",
      description:
        "Append domains to a domain filter (max 15,000 per filter). Invalid domains are skipped and listed in `rejected_domains`. Takes effect on every order using this filter.",
      inputSchema: { id: z.string().min(1).describe("Domain filter ID"), domains: z.array(z.string()).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => run(() => api.post(`/v1/domain_filters/${enc(a.id)}/add_domains`, { domains: a.domains })),
  );

  server.registerTool(
    "remove_domains_from_filter",
    {
      title: "Remove domains from filter",
      description: "Remove domains from a domain filter. Takes effect on every order using this filter.",
      inputSchema: { id: z.string().min(1).describe("Domain filter ID"), domains: z.array(z.string()).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (a) => run(() => api.post(`/v1/domain_filters/${enc(a.id)}/remove_domains`, { domains: a.domains })),
  );
}
