import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Ready-made workflows. Each prompt only tells the model which tools to call
// and how to present the result; the numbers always come from the tools.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/;

const formatArg = z.enum(["popunder", "sticker"]);
const day = (what: string) => z.string().regex(DAY).optional().describe(`${what} (YYYY-MM-DD, UTC)`);

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(dayStr: string, n: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

function resolveDay(value: string | undefined, now: Date): string {
  const today = utcDay(now);
  if (!value || value === "yesterday") return addDays(today, -1);
  return value === "today" ? today : value;
}

function lastWeek(start: string | undefined, end: string | undefined, now: Date) {
  const e = end ?? utcDay(now);
  return { start: start ?? addDays(e, -6), end: e };
}

function text(body: string[]): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text: body.join("\n") } }] };
}

const NO_GUESSING = "Use only numbers returned by the tools; never estimate. Dates are UTC; if a range includes today, say today is partial.";
const CONVERSION_TIMING =
  "Conversions are dated by when they were received, spend and traffic by the click, so recent clicks may still convert.";

export function registerPrompts(server: McpServer) {
  const now = () => new Date();
  server.registerPrompt(
    "daily_report",
    {
      title: "Daily report",
      description: "Spend and earnings per order for one day, top and bottom orders, and anomalies against the previous day.",
      argsSchema: {
        date: z
          .string()
          .regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/)
          .optional()
          .describe("Day to report: YYYY-MM-DD, `today` or `yesterday` (default)"),
        format: formatArg.optional().describe("popunder or sticker; both when omitted"),
      },
    },
    (a) => {
      const date = resolveDay(a.date, now());
      const prev = addDays(date, -1);
      const formats = a.format ? [a.format] : ["popunder", "sticker"];
      return text([
        `Write the TrafficOX daily report for ${date} (UTC), compared with ${prev}. Formats: ${formats.join(", ")}.`,
        "",
        "Call these tools:",
        `1. get_balance_stats with date_start=${prev}, date_end=${date} — account earned and spent per day.`,
        `2. For each format: get_account_stats side=buy group_by=order with date_start=date_end=${date}, then the same for ${prev}. Rows are keyed by order id and carry id_numeric and name.`,
        `3. For each format: get_account_stats side=sell group_by=order for ${date} and for ${prev}.`,
        "Skip a format/side whose two days are both empty ({}): the account does not trade there.",
        "",
        "Present, concisely, with markdown tables:",
        `- Totals: spent, earned and profit (earned − spent) for ${date} vs ${prev}, with the difference and % change.`,
        "- Buy side: top 5 orders by spent; bottom 5 by efficiency among orders that spent at least $1 (spend with 0 conversions, or the highest cost_per_conversion). Columns: order (name and id_numeric), spent, hits, cpm, conversions, cost_per_conversion, change in spent vs the previous day.",
        "- Sell side: top 5 and bottom 5 sell orders by earned, with total, sold, cpm and the change in earned.",
        "- Anomalies vs the previous day, one line each with the numbers: spent or earned changed by more than 50% (and at least $5), an order that started or stopped spending/earning, cpm moved by more than 30%, conversions fell to 0 while spend continued.",
        "End with at most 3 next steps (e.g. a domain breakdown with get_order_stats group_by=domain for a suspicious order). Do not change anything in the account.",
        NO_GUESSING,
        CONVERSION_TIMING,
      ]);
    },
  );

  server.registerPrompt(
    "compare_periods",
    {
      title: "Compare periods",
      description: "Period-over-period comparison of buy or sell statistics with absolute and % change.",
      argsSchema: {
        period_a: z.string().regex(PERIOD).describe("Base period: YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD"),
        period_b: z.string().regex(PERIOD).describe("Period compared with the base, same syntax"),
        side: z.enum(["buy", "sell"]).describe("buy = campaigns, sell = placements"),
        format: formatArg.describe("popunder or sticker"),
        group_by: z
          .enum(["order", "country", "category", "browser", "isp", "platform", "domain"])
          .optional()
          .describe("Breakdown to compare (default order)"),
      },
    },
    (a) => {
      const [aStart, aEnd = aStart] = a.period_a.split("..");
      const [bStart, bEnd = bStart] = a.period_b.split("..");
      const groupBy = a.group_by ?? "order";
      const money = a.side === "buy" ? "spent" : "earned";
      const metrics =
        a.side === "buy"
          ? "spent, hits, cpm, conversions, cost_per_conversion, conversion_revenue, profit"
          : "earned, total, sold, cpm";
      return text([
        `Compare ${a.format} ${a.side} statistics of period A (${aStart} – ${aEnd}) with period B (${bStart} – ${bEnd}), UTC, by ${groupBy}.`,
        "",
        "Call these tools:",
        `1. get_account_stats format=${a.format} side=${a.side} group_by=${groupBy} date_start=${aStart} date_end=${aEnd}.`,
        `2. The same with date_start=${bStart} date_end=${bEnd}.`,
        `3. For the totals: get_account_stats format=${a.format} side=${a.side} group_by=day for each period, and sum the days (day rows are complete; the ${groupBy} rows may be only the largest ones).`,
        "",
        "Present:",
        `- Totals of ${metrics} for A and B with columns A, B, Δ (B − A) and % change ((B − A) / A × 100, one decimal). When A is 0 write "new", when B is 0 write "gone". Recompute ratios from the summed totals (cpm = ${money} / ${a.side === "buy" ? "hits" : "sold"} × 1000, cost per conversion = spent / conversions); never average row ratios.`,
        `- A per-${groupBy} table matched by key (for orders show the name and id_numeric), sorted by the absolute Δ of ${money}, top 15 rows, then how many rows were left out. Mark rows present in only one period.`,
        "- If the periods differ in length, also compare per-day averages. If a response carries `truncated`, say that the comparison covers only the rows shown.",
        "- 2–4 bullet takeaways naming the biggest drivers of the change.",
        NO_GUESSING,
        ...(a.side === "buy" ? [CONVERSION_TIMING] : []),
      ]);
    },
  );

  server.registerPrompt(
    "find_bad_domains",
    {
      title: "Find bad domains",
      description:
        "Source domains of a buy order with spend but no conversions or a high cost per conversion, then a proposal to blacklist them (applied only after you confirm).",
      argsSchema: {
        order_id: z.string().min(1).describe("Buy order id or id_numeric"),
        format: formatArg.describe("popunder or sticker"),
        date_start: day("Range start, default 6 days before date_end"),
        date_end: day("Range end, default today"),
        min_spend: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .optional()
          .describe("Ignore domains that spent less than this many USD (default 1)"),
      },
    },
    (a) => {
      const { start, end } = lastWeek(a.date_start, a.date_end, now());
      const minSpend = a.min_spend ?? "1";
      return text([
        `Find source domains that waste budget on ${a.format} buy order ${a.order_id}, ${start} – ${end} (UTC).`,
        "",
        "Call these tools:",
        `1. get_order format=${a.format} side=buy id=${a.order_id} — order name, state and the attached domain_filter (id, name, list_type, domains_count).`,
        `2. get_order_stats format=${a.format} side=buy id=${a.order_id} group_by=domain date_start=${start} date_end=${end}. Rows: source domain → spent, hits, conversions, cost_per_conversion, domain_id_numeric.`,
        "3. Order average cost per conversion = total spent / total conversions over all rows. If the order has no conversions at all, say so (no tracking or no sales) and rank by spend only.",
        "",
        `Bad domains: spent ≥ $${minSpend} and either 0 conversions, or cost_per_conversion above 2× the order average.`,
        "Present a table sorted by spent: domain, domain_id_numeric, spent, hits, conversions, cost_per_conversion, reason; then the bad domains' total spend and its share of the order's spend.",
        `Caveats to mention: ${CONVERSION_TIMING} Domains with few hits are noise. If domain names are masked for this account, say that blocking by name is not possible and stop.`,
        "",
        "Then PROPOSE blocking them. Never apply anything without the user's explicit agreement:",
        "- If the order's domain_filter is a blacklist: call add_domains_to_filter with id=<that filter's id> and the bad domains, WITHOUT confirm. It returns a preview (filter name, new vs already present, size before → after, the 15,000 cap). Show it and remind the user that the filter applies to every order using it.",
        "- If the order has no domain filter, or a whitelist: call create_domain_filter (list_type=blacklist, a name like \"Blacklist – <order name>\", the bad domains) WITHOUT confirm and show the preview; the new filter has to be attached to the order in the dashboard. For a whitelist, also offer remove_domains_from_filter (preview first) as the alternative.",
        "Ask whether to apply. Only after the user explicitly says yes, call the same tool again with the same arguments plus confirm: true, and report the result, including any rejected_domains.",
        NO_GUESSING,
      ]);
    },
  );

  server.registerPrompt(
    "top_placements",
    {
      title: "Top placements",
      description: "Publisher view: best and worst sell orders and countries by earnings and cpm.",
      argsSchema: {
        format: formatArg.describe("popunder or sticker"),
        date_start: day("Range start, default 6 days before date_end"),
        date_end: day("Range end, default today"),
      },
    },
    (a) => {
      const { start, end } = lastWeek(a.date_start, a.date_end, now());
      return text([
        `Publisher report for ${a.format} sell orders, ${start} – ${end} (UTC).`,
        "",
        "Call these tools:",
        `1. get_account_stats format=${a.format} side=sell group_by=order date_start=${start} date_end=${end} size=1000 — per sell order: total, unique, sold, earned, cpm, with id_numeric and name.`,
        `2. get_account_stats format=${a.format} side=sell group_by=country date_start=${start} date_end=${end} size=50 order_field=earned order_direction=desc.`,
        "",
        "Present, with markdown tables:",
        "- Totals: earned, total, sold, and cpm recomputed from the totals (earned / sold × 1000), not averaged.",
        "- Top 5 and bottom 5 sell orders by earned, and top 5 and bottom 5 by cpm among orders with at least 1,000 sold (smaller ones are noise). Columns: order (name and id_numeric), earned, sold, total, sold share (sold / total), cpm.",
        "- Top 10 countries by earned with sold and cpm, and the 5 countries with the most traffic but the lowest cpm.",
        "- 2–3 takeaways (e.g. traffic that is sent but rarely sold, countries worth pushing).",
        "If a response carries `truncated`, say so. Do not change anything in the account.",
        NO_GUESSING,
      ]);
    },
  );
}
