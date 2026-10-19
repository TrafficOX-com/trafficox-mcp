export const DEFAULT_BASE_URL = "https://api.trafficox.com/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`TrafficOX API responded ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

type Query = Record<string, string | number | undefined>;

// Thin wrapper over the public REST API. Every call is made with the user's
// own Api-Key, so the server can only see and do what that key allows.
export class TrafficoxClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get(path: string, query?: Query) {
    return this.request("GET", path, undefined, query);
  }

  post(path: string, body?: object) {
    return this.request("POST", path, body);
  }

  async request(method: string, path: string, body?: object, query?: Query): Promise<unknown> {
    const url = new URL(this.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        "Api-Key": this.apiKey,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body (proxy error page etc.) — keep the raw text
    }

    if (!res.ok) throw new ApiError(res.status, parsed);
    // v1 filter validation renders `{ errors: "..." }` with status 200.
    if (isErrorEnvelope(parsed)) throw new ApiError(422, parsed);
    return parsed;
  }
}

function isErrorEnvelope(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "errors";
}
