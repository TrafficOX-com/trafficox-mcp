// The REST API keeps its historical formats for existing integrations; the MCP
// layer turns them into one predictable shape for models and scripts:
// - date keys/values "October 30, 2026" / "October 30, 2026 13:00" → ISO
// - rows with no data are dropped, so an empty period is {} / [] everywhere
// - ratios with a zero denominator are 0, never null
// - money rounded to cents, unit prices (cpm, cpc, cost per …, payout) to 4 decimals

const MONTHS: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

const DATE_RE = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})(?: (\d{2}):(\d{2}))?$/;

const MONEY = new Set(["spent", "earned", "profit", "conversion_revenue", "balance", "current_balance"]);
// Per-unit amounts are fractions of a cent, so they keep 4 decimals.
const UNIT_PRICE = new Set(["cpm", "cpc", "cost_per_conversion", "cost_per_click", "payout_usd"]);
// Ratios: a zero denominator gives 0. payout_usd is not a ratio — null there means "no payout".
const RATIO = new Set(["cpm", "cpc", "cost_per_conversion", "cost_per_click"]);

export function isoDate(s: string): string | null {
  const m = DATE_RE.exec(s);
  if (!m || !MONTHS[m[1]]) return null;
  const day = `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}`;
  return m[4] ? `${day}T${m[4]}:${m[5]}:00Z` : day;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function normalize(value: unknown): Json {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    // Day lists (balance_stats `data`) follow the same "no empty rows" rule as date-keyed maps.
    return items.every(isDatedRow) ? items.filter((row) => !isEmpty(row)) : items;
  }
  if (!value || typeof value !== "object") return value as Json;

  const out: Record<string, Json> = {};
  let datedKeys = false;
  for (const [key, raw] of Object.entries(value)) {
    const iso = isoDate(key);
    if (iso) datedKeys = true;
    out[iso ?? key] = normalizeField(key, normalize(raw));
  }
  if (!datedKeys) return out;
  return Object.fromEntries(Object.entries(out).filter(([, row]) => !isEmpty(row)));
}

function normalizeField(key: string, v: Json): Json {
  if (key === "date" && typeof v === "string") return isoDate(v) ?? v;
  if (MONEY.has(key) && typeof v === "number") return round(v, 2);
  if (RATIO.has(key) && (v === null || (typeof v === "number" && !Number.isFinite(v)))) return 0;
  if (UNIT_PRICE.has(key) && typeof v === "number") return round(v, 4);
  return v;
}

function isDatedRow(v: Json): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof v.date === "string";
}

// Identifiers label a row; they are not data, so they never keep an empty row alive.
const IDENTIFIER = new Set(["domain_id_numeric", "id_numeric"]);

// A row is empty when every metric in it (nested `sub`, `by_format` …) is 0 or null.
function isEmpty(v: Json): boolean {
  if (v === null) return true;
  if (typeof v === "number") return v === 0;
  if (typeof v === "string" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.every(isEmpty);
  return Object.entries(v).every(([key, field]) => IDENTIFIER.has(key) || isEmpty(field));
}
