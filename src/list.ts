// The list endpoints (orders, RTB feeds) return every record at once; the MCP
// filters and pages them so "how many active orders do I have" is one call.

export type ListQuery = { state?: string; search?: string; page?: number; per_page?: number };

export const DEFAULT_PER_PAGE = 50;
export const MAX_PER_PAGE = 200;

type Item = Record<string, unknown>;

// name (and display_name) match as a case-insensitive substring; ids match exactly.
function matches(item: Item, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  for (const key of ["name", "display_name"]) {
    const v = item[key];
    if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
  }
  return [item.id, item.id_numeric].some((v) => v !== undefined && v !== null && String(v).toLowerCase() === q);
}

export function pageList(raw: unknown, q: ListQuery) {
  const all = (Array.isArray(raw) ? raw : []) as Item[];
  const counts_by_state: Record<string, number> = {};
  for (const item of all) {
    const state = typeof item.state === "string" ? item.state : "unknown";
    counts_by_state[state] = (counts_by_state[state] ?? 0) + 1;
  }

  const filtered = all.filter((item) => (!q.state || item.state === q.state) && (!q.search || matches(item, q.search)));
  const page = q.page ?? 1;
  const per_page = q.per_page ?? DEFAULT_PER_PAGE;
  const start = (page - 1) * per_page;
  return {
    items: filtered.slice(start, start + per_page),
    total: filtered.length,
    page,
    per_page,
    pages: Math.ceil(filtered.length / per_page),
    counts_by_state,
  };
}
