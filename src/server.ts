import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TrafficoxClient } from "./client.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

export function createServer(api: TrafficoxClient): McpServer {
  const server = new McpServer(
    { name: "trafficox", version: VERSION },
    {
      instructions: [
        "TrafficOX is an ad traffic exchange (popunder and sticker formats).",
        "Buy orders are advertiser campaigns; sell orders are publisher placements; RTB feeds are external DSP demand.",
        "Money is in USD. Stats default to today (UTC) when no dates are given; the API allows at most 60 days per request and 90 days back.",
        "Use get_filter_values for exact country/category/OS/browser spellings.",
      ].join(" "),
    },
  );
  registerTools(server, api);
  return server;
}
