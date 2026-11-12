import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TrafficoxClient } from "./client.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.4.0";

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
      ].join(" "),
    },
  );
  registerTools(server, api);
  return server;
}
