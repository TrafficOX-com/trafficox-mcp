// Write tools answer with a preview until they are called with confirm: true.
// The preview is built from the current record (one GET), so the user sees
// what would change before anything is written.

export const APPLY = "Call again with confirm: true after the user agrees.";
export const MAX_FILTER_DOMAINS = 15_000;
const SHOWN = 100;

type Item = Record<string, unknown>;

// Mirrors DomainFilter.normalize_domain_url and DOMAIN_PATTERN_REGEXP of the API.
const DOMAIN_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function normalizeDomain(raw: string): string {
  return raw.replace(/^https?:\/\//, "").replace(/\r$/, "").split("/")[0];
}

function sample(list: string[]) {
  return { count: list.length, domains: list.slice(0, SHOWN), ...(list.length > SHOWN ? { not_shown: list.length - SHOWN } : {}) };
}

function sampleIds(list: number[]) {
  return { count: list.length, domain_ids: list.slice(0, SHOWN), ...(list.length > SHOWN ? { not_shown: list.length - SHOWN } : {}) };
}

function label(record: Item) {
  return { id: record.id, id_numeric: record.id_numeric, name: record.display_name ?? record.name };
}

export function statePreview(action: string, record: Item, next: "active" | "paused", what: string) {
  const current = record.state;
  const notes: string[] = [];
  if (current === next) notes.push(`The ${what} is already ${next}; nothing would change.`);
  else if (current !== "active" && current !== "paused") notes.push(`The ${what} is ${String(current)}; the API may refuse this change.`);
  if (next === "active" && current !== next) notes.push(`Activating resumes ${what === "order" ? "buying traffic and spending balance" : "bidding"}.`);
  return { action, [what]: label(record), current_state: current, new_state: next, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

function filterLabel(filter: Item) {
  return { id: filter.id, name: filter.name, list_type: filter.list_type };
}

// Accounts with hidden source names get domain_ids instead of domains.
function storedDomains(filter: Item): string[] | null {
  return Array.isArray(filter.domains) ? (filter.domains as string[]) : null;
}

function storedIds(filter: Item): number[] {
  return Array.isArray(filter.domain_ids) ? (filter.domain_ids as unknown[]).map(Number) : [];
}

const HIDDEN = "This account sees source domains only as Domain IDs: the API refuses `domains` (422). Use domain_ids.";
const ID_NOTE =
  "Domain IDs are the {domain_id_numeric} macro value (domain_id_numeric in domain stats). The API refuses the whole request if an ID is unknown, and skips an ID whose domain is already in the filter (duplicate_domain_ids).";

// New vs already present IDs, each ID once.
function splitIds(filter: Item, ids: number[]) {
  const have = new Set(storedIds(filter));
  const unique = [...new Set(ids)];
  return { fresh: unique.filter((id) => !have.has(id)), present: unique.filter((id) => have.has(id)) };
}

function splitInput(input: string[]) {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    if (!DOMAIN_RE.test(domain)) invalid.push(raw);
    else if (!seen.has(domain)) {
      seen.add(domain);
      valid.push(domain);
    }
  }
  return { valid, invalid };
}

export function addDomainsPreview(filter: Item, input: string[], ids: number[] = []) {
  const stored = storedDomains(filter);
  const before = stored ? stored.length : Number(filter.domains_count ?? 0);
  // The API refuses the whole request once stored + submitted (duplicates included) reaches the cap.
  const submitted = input.length + ids.length;
  const within_limit = before + submitted < MAX_FILTER_DOMAINS;
  const limit = {
    max_domains: MAX_FILTER_DOMAINS,
    within_limit,
    ...(within_limit
      ? {}
      : { limit_note: `Rejected as a whole: ${before} stored + ${submitted} submitted reaches the ${MAX_FILTER_DOMAINS} cap.` }),
  };
  const head = { action: "add_domains_to_filter", filter: filterLabel(filter), domains_before: before };
  const { fresh, present: idsPresent } = splitIds(filter, ids);
  const idPart = ids.length ? { new_domain_ids: sampleIds(fresh), already_present_domain_ids: sampleIds(idsPresent), domain_ids_note: ID_NOTE } : {};
  if (!stored) {
    return {
      ...head,
      ...(input.length ? { refused: true, note: HIDDEN } : { domains_after: within_limit ? before + fresh.length : before, note: "Takes effect on every order that uses this filter." }),
      ...limit,
      ...idPart,
    };
  }

  const have = new Set(stored);
  const { valid, invalid } = splitInput(input);
  const added = valid.filter((d) => !have.has(d));
  const present = valid.filter((d) => have.has(d));
  return {
    ...head,
    domains_after: within_limit ? before + added.length + fresh.length : before,
    ...limit,
    ...(input.length ? { new: sample(added), already_present: sample(present) } : {}),
    ...(invalid.length ? { invalid: { ...sample(invalid), note: "Not valid domain names; the API skips them." } } : {}),
    ...idPart,
    note: "Takes effect on every order that uses this filter.",
  };
}

export function removeDomainsPreview(filter: Item, input: string[], ids: number[] = []) {
  const stored = storedDomains(filter);
  const head = { action: "remove_domains_from_filter", filter: filterLabel(filter) };
  const { fresh: idsAbsent, present: idsPresent } = splitIds(filter, ids);
  const idPart = ids.length
    ? { removed_domain_ids: sampleIds(idsPresent), not_present_domain_ids: sampleIds(idsAbsent) }
    : {};
  if (!stored) {
    return {
      ...head,
      domains_before: Number(filter.domains_count ?? 0),
      ...(input.length ? { refused: true, note: HIDDEN } : { note: "Takes effect on every order that uses this filter." }),
      ...idPart,
    };
  }

  const have = new Set(stored);
  const unique = [...new Set(input)];
  const present = unique.filter((d) => have.has(d));
  const absent = unique.filter((d) => !have.has(d));
  const viaIds = ids.length || storedIds(filter).length;
  return {
    ...head,
    domains_before: stored.length,
    domains_after: stored.length - present.length - idsPresent.length,
    max_domains: MAX_FILTER_DOMAINS,
    ...(input.length
      ? {
          removed: sample(present),
          not_present: {
            ...sample(absent),
            ...(absent.length ? { note: "Only exact matches of the stored spelling are removed (see get_domain_filter)." } : {}),
          },
        }
      : {}),
    ...idPart,
    ...(viaIds ? { domain_ids_note: "A domain that is in the filter through a Domain ID is removed by its ID only, not by its name." } : {}),
    note: "Takes effect on every order that uses this filter.",
  };
}

export function createFilterPreview(a: { name: string; list_type: string; domains?: string[]; domain_ids?: number[]; ips?: string[] }) {
  const { valid, invalid } = splitInput(a.domains ?? []);
  return {
    action: "create_domain_filter",
    will_create: {
      name: a.name,
      list_type: a.list_type,
      domains: sample(valid),
      ...(invalid.length ? { invalid: { ...sample(invalid), note: "Not valid domain names; the API skips them." } } : {}),
      ...(a.domain_ids?.length ? { domain_ids: sampleIds([...new Set(a.domain_ids)]), domain_ids_note: ID_NOTE } : {}),
      ...(a.ips?.length ? { ips: a.ips } : {}),
    },
    note: "The new filter is not attached to any order; attach it in the dashboard.",
  };
}
