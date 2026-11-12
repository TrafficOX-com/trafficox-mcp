# TrafficOX MCP server

Connect Claude, Cursor and other [MCP](https://modelcontextprotocol.io) clients to your TrafficOX account. Ask about your campaigns in plain language — "which domains burned budget on order 105002 this week?", "compare sticker RTB feeds by country for yesterday" — and the assistant reads the numbers from the TrafficOX API.

The server runs locally and talks to `https://api.trafficox.com/api` with your own API key, so the assistant sees only what your key can see.

## Requirements

- Node.js 20+
- A TrafficOX API key (dashboard → API). API access must be enabled for your account.

## Setup

### Claude Desktop

Settings → Developer → Edit Config, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trafficox": {
      "command": "npx",
      "args": ["-y", "@trafficox/mcp@0.4.0"],
      "env": { "TRAFFICOX_API_KEY": "your-api-key" }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add trafficox --env TRAFFICOX_API_KEY=your-api-key -- npx -y @trafficox/mcp@0.4.0
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) — the same block as for Claude Desktop.

The version is pinned on purpose: your client runs exactly the release you reviewed, not whatever is published later. To upgrade, change the version in the config ([versions on npm](https://www.npmjs.com/package/@trafficox/mcp?activeTab=versions)).

### Environment

| Variable | Required | Default |
|---|---|---|
| `TRAFFICOX_API_KEY` | yes | — |
| `TRAFFICOX_API_URL` | no | `https://api.trafficox.com/api` |

## Tools

**Account**
- `get_account` — email, username, balance
- `get_balance_stats` — daily earned/spent
- `get_filter_values` — valid countries, categories, OS, browsers for filters

**Orders** (`format`: popunder | sticker, `side`: buy | sell)
- `list_orders`, `get_order`
- `get_order_stats` — group by country, category, browser, isp, platform, domain, day, hour or sub_id, with filters and an optional second-level breakdown. Conversions are counted by the time they were received, traffic and spend by the time of the click, so the numbers match your conversion tracker for the same period
- `get_account_stats` — the same statistics summed over all buy or sell orders of a format in one call (the panel's Total Buy / Total Sell Stats), with a per-order breakdown (`group_by=order` or `subdimension=order`)
- `get_sub_id_report` — sell earnings by sub_id_1..3, cursor-paginated

**RTB**
- `list_rtb_feeds`, `get_rtb_feed`
- `get_rtb_stats` — account-wide or per feed

**Domain filters**
- `list_domain_filters`, `get_domain_filter`

**Conversion tracking**
- `list_conversion_trackers`, `get_conversion_tracker`, `list_conversion_events`

**Actions** — these change your account; MCP clients ask you to confirm before running them
- `set_buy_order_state` — start or pause a popunder buy order
- `set_rtb_feed_state` — start or pause an RTB feed
- `create_domain_filter`, `add_domains_to_filter`, `remove_domains_from_filter`

Bid prices and other order settings are changed in the dashboard only.

## Response format

Every tool returns JSON with the API data under `data`:

```json
{ "data": { "2026-10-30": { "hits": 378241, "spent": 476.27, "cpm": 1.2592 } } }
```

- Dates are ISO and UTC: `2026-10-30`, hours `2026-10-30T13:00:00Z`.
- Rows exist only where there is data; an empty period returns `{}` (or `[]`).
- Ratios with a zero denominator (`cpm`, `cpc`, cost per conversion/click) are `0`.
- Money totals are rounded to cents; `cpm`, `cpc`, cost-per and payout values to 4 decimals.
- Buy rows carry `conversions_by_type` (conversions and revenue per event type: `signup`, `ftd`, …); `event_types` limits the conversion metrics to the given types.
- Rows keyed by source domain carry `domain_id_numeric`, the value the `{domain_id_numeric}` URL macro sends (`null` for an unregistered source), so stats can be matched with your tracker.
- If a response is too large for the assistant's context, rows are cut and a separate field says so:
  `{ "data": { … }, "truncated": { "shown": 556, "total": 1000, "hint": "…" } }`.

## Limits

Stats requests cover at most 60 days, no more than 90 days back; dates are UTC and default to today. `date_end` is inclusive: `2026-10-30` means the whole day. A breakdown (`subdimension`) returns up to 1000 sub-rows per row (`day`/`hour` return every day/hour); a breakdown too large for one request is rejected with a hint to shorten the range.

## Development

```bash
pnpm install
pnpm test
pnpm build
TRAFFICOX_API_KEY=... node dist/index.js   # stdio server
```

Full REST reference: https://app.trafficox.com/docs/
