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
      "args": ["-y", "@trafficox/mcp@0.5.0"],
      "env": { "TRAFFICOX_API_KEY": "your-api-key" }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add trafficox --env TRAFFICOX_API_KEY=your-api-key -- npx -y @trafficox/mcp@0.5.0
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
- `get_filter_values` — valid countries, categories (names), OS, browsers for filters

**Orders** (`format`: popunder | sticker, `side`: buy | sell)
- `list_orders` — filter by `state` and `search`, paged (see [Lists](#lists)); `get_order`
- `get_order_stats` — group by country, category, browser, isp, platform, domain, day, hour or sub_id, with filters and an optional second-level breakdown. Conversions are counted by the time they were received, traffic and spend by the time of the click, so the numbers match your conversion tracker for the same period
- `get_account_stats` — the same statistics summed over all buy or sell orders of a format in one call (the panel's Total Buy / Total Sell Stats), with a per-order breakdown (`group_by=order` or `subdimension=order`)
- `get_sub_id_report` — sell earnings by sub_id_1..3, cursor-paginated

**RTB**
- `list_rtb_feeds` — filter by `state` and `search`, paged; `get_rtb_feed`
- `get_rtb_stats` — account-wide or per feed; with `subdimension=feed` every feed sub row also carries the feed `name`

**Domain filters**
- `list_domain_filters`, `get_domain_filter`

**Conversion tracking**
- `list_conversion_trackers`, `get_conversion_tracker`, `list_conversion_events`

**Actions** — these change your account, and only after you confirm (see [Confirming changes](#confirming-changes))
- `set_buy_order_state` — start or pause a popunder buy order
- `set_rtb_feed_state` — start or pause an RTB feed
- `create_domain_filter`, `add_domains_to_filter`, `remove_domains_from_filter`

Bid prices and other order settings are changed in the dashboard only.

## Confirming changes

Every action works in two steps. Called without `confirm: true` it changes nothing and returns a preview built from the current state of your account:

```json
{
  "data": {
    "preview": {
      "action": "add_domains_to_filter",
      "filter": { "id": "62c7…", "name": "Bad sources", "list_type": "blacklist" },
      "domains_before": 120, "domains_after": 123, "max_domains": 15000, "within_limit": true,
      "new": { "count": 3, "domains": ["a.com", "b.com", "c.com"] },
      "already_present": { "count": 1, "domains": ["d.com"] }
    },
    "apply": "Call again with confirm: true after the user agrees."
  }
}
```

- start / pause: the order or feed name, its current state and the new one, with a note when it is already in that state;
- add / remove domains: the filter name, which domains are new, already present or not present, the size before → after and the 15,000-domain cap;
- create: the filter that would be created.

The assistant shows you the preview and repeats the call with `confirm: true` only after you agree. Your MCP client may also ask you to approve the call itself.

## Lists

`list_orders` and `list_rtb_feeds` take optional `state`, `search` (part of the name, case-insensitive; an exact `id` or `id_numeric` also matches), `page` (default 1) and `per_page` (default 50, max 200):

```json
{ "data": { "items": [ … ], "total": 12, "page": 1, "per_page": 50, "pages": 1,
            "counts_by_state": { "active": 9, "paused": 3 } } }
```

`total` and `pages` count the filtered list; `counts_by_state` counts all records of the account, so "how many active orders do I have" is one call.

## Prompts

Ready-made workflows your client offers as prompts (in Claude: the "+" menu → the server's prompts). Each tells the assistant which tools to call and how to present the result:

| Prompt | Arguments | What you get |
|---|---|---|
| `daily_report` | `date` (`YYYY-MM-DD`, `today`, default `yesterday`), `format` | spend and earnings per order, top and bottom orders, anomalies against the previous day |
| `compare_periods` | `period_a`, `period_b` (`YYYY-MM-DD` or `YYYY-MM-DD..YYYY-MM-DD`), `side`, `format`, `group_by` | period-over-period table with Δ and % change |
| `find_bad_domains` | `order_id`, `format`, `date_start`, `date_end`, `min_spend` | domains with spend but no conversions or an expensive cost per conversion, and a proposal to blacklist them through the preview — nothing is written until you confirm |
| `top_placements` | `format`, `date_start`, `date_end` | best and worst sell orders and countries by earnings and cpm |

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
- Rows of `get_account_stats` keyed by order carry the order `name`; RTB stats split by feed carry the feed `name`. Stats grouped by category are keyed by category name; the `categories` filter takes the same names.
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
