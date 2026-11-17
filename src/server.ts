import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TrafficoxClient } from "./client.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.5.0";

export function createServer(api: TrafficoxClient): McpServer {
  const server = new McpServer(
    { name: "trafficox", version: VERSION },
    {
      instructions: [
        "TrafficOX is an ad traffic exchange (popunder and sticker formats).",
        "Buy orders are advertiser campaigns; sell orders are publisher placements; RTB feeds are external DSP demand.",
        "Money is in USD. Stats default to today (UTC) when no dates are given; the API allows at most 60 days per request and 90 days back.",
        "Use get_filter_values for exact country/category/OS/browser spellings.",
        "Every tool returns JSON `{ data }`; when rows had to be cut to fit, a separate `truncated: { shown, total, hint }` field is added next to `data`.",
        "Dates are ISO (`2026-10-30`, hours `2026-10-30T13:00:00Z`, UTC). Rows exist only where there is data: an empty period is `{}` (or `[]`), never zero rows.",
        "Ratios with a zero denominator (cpm, cpc, cost per conversion) are 0. Money totals are rounded to cents; cpm, cpc, cost-per and payout values to 4 decimals.",
        "list_orders and list_rtb_feeds filter by state and name and page the result; counts_by_state answers \"how many active …\" in one call.",
        "Write tools (set_buy_order_state, set_rtb_feed_state, create_domain_filter, add_domains_to_filter, remove_domains_from_filter) change nothing without confirm: true — they return a preview. Show it to the user and repeat the call with confirm: true only after the user explicitly agrees.",
        "Prompts with ready-made workflows: daily_report, compare_periods, find_bad_domains (proposes a blacklist via the preview flow), top_placements.",
      ].join(" "),
    },
  );
  registerTools(server, api);
  registerPrompts(server);
  return server;
}
