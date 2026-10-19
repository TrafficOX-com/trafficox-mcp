// Stats endpoints can return up to 1000 rows; a model reading 100+ KB of JSON
// loses the thread. Keep the first rows that fit and say how many were cut.
export const MAX_RESPONSE_CHARS = 60_000;

export function fitResponse(data: unknown, maxChars = MAX_RESPONSE_CHARS): string {
  const full = JSON.stringify(data);
  if (full.length <= maxChars) return full;

  const rows = rowsOf(data);
  if (!rows) {
    return JSON.stringify({
      _truncated: `Response is ${full.length} chars; narrow the date range or filters.`,
      preview: full.slice(0, maxChars),
    });
  }

  let lo = 0;
  let hi = rows.total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(rows.take(mid)).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return JSON.stringify(rows.take(lo));
}

type Rows = { total: number; take: (n: number) => unknown };

function note(shown: number, total: number) {
  return {
    shown,
    total,
    hint: "Response trimmed to fit the model context. Narrow filters/date range, or page with from/size where supported.",
  };
}

function rowsOf(data: unknown): Rows | null {
  if (Array.isArray(data)) {
    return { total: data.length, take: (n) => ({ _truncated: note(n, data.length), rows: data.slice(0, n) }) };
  }
  if (!data || typeof data !== "object") return null;

  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    const list = obj.data;
    return { total: list.length, take: (n) => ({ ...obj, data: list.slice(0, n), _truncated: note(n, list.length) }) };
  }

  // Keyed stats map: { "US": {...}, "DE": {...} }
  const entries = Object.entries(obj);
  return {
    total: entries.length,
    take: (n) => ({ ...Object.fromEntries(entries.slice(0, n)), _truncated: note(n, entries.length) }),
  };
}
