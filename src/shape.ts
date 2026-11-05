// Every tool answers `{ "data": … }`. Stats endpoints can return up to 1000
// rows; a model reading 100+ KB of JSON loses the thread, so oversized data is
// cut row-wise and the cut is reported in a separate `truncated` field — never
// inside the rows themselves.
export const MAX_RESPONSE_CHARS = 60_000;

const HINT = "Rows were cut to fit the model context. Narrow filters or the date range, or page with from/size where supported.";

export type Truncated = { shown: number; total: number; hint: string };

export function fitResponse(data: unknown, maxChars = MAX_RESPONSE_CHARS): string {
  const full = JSON.stringify({ data });
  if (full.length <= maxChars) return full;

  const rows = rowsOf(data);
  if (!rows) {
    // Not row-shaped (should not happen for API responses): say so instead of cutting JSON mid-way.
    return JSON.stringify({
      data: null,
      truncated: { shown: 0, total: 1, hint: `Response is ${full.length} chars and cannot be split into rows. ${HINT}` },
    });
  }

  const render = (n: number) =>
    JSON.stringify({ data: rows.take(n), truncated: { shown: n, total: rows.total, hint: HINT } satisfies Truncated });
  let lo = 0;
  let hi = rows.total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}

type Rows = { total: number; take: (n: number) => unknown };

function rowsOf(data: unknown): Rows | null {
  if (Array.isArray(data)) return { total: data.length, take: (n) => data.slice(0, n) };
  if (!data || typeof data !== "object") return null;

  const obj = data as Record<string, unknown>;
  // { after, data: [...] } (v2 sub-id report), { summary, data: [...] } (balance)
  if (Array.isArray(obj.data)) {
    const list = obj.data;
    return { total: list.length, take: (n) => ({ ...obj, data: list.slice(0, n) }) };
  }

  // Keyed stats map: { "US": {...}, "DE": {...} }
  const entries = Object.entries(obj);
  return { total: entries.length, take: (n) => Object.fromEntries(entries.slice(0, n)) };
}
