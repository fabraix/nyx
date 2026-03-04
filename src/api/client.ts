import { getToken } from "../config/auth.js";
import { NyxError } from "../utils/errors.js";

const DEFAULT_BASE = "https://api.fabraix.com";

export function getBaseUrl(): string {
  return process.env.NYX_API_URL || DEFAULT_BASE;
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await request(method, path, {
    accept: "application/json",
    body,
  });
  return res.json() as Promise<T>;
}

export async function apiRawRequest(
  method: string,
  path: string,
  accept: string
): Promise<Response> {
  return request(method, path, { accept });
}

async function request(
  method: string,
  path: string,
  opts: { accept: string; body?: unknown }
): Promise<Response> {
  const token = getToken();
  if (!token) {
    throw new NyxError(
      "Not authenticated. Run `nyx login` or set NYX_TOKEN.",
      "auth"
    );
  }

  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "X-Verification-Token": token,
    Accept: opts.accept,
  };
  if (opts.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new NyxError(
      `Network error: could not reach ${getBaseUrl()}. Check your internet connection.`,
      "network"
    );
  }

  if (!res.ok) {
    await handleApiError(res, path);
  }

  return res;
}

async function handleApiError(res: Response, path: string): Promise<never> {
  let detail = "";
  try {
    const body = await res.json();
    detail =
      (body as Record<string, string>).error ||
      (body as Record<string, string>).message ||
      JSON.stringify(body);
  } catch {
    /* ignore parse failures */
  }

  const messages: Record<number, string> = {
    401: "Authentication failed. Your token may have expired. Run `nyx login`.",
    402: "Insufficient account balance. Add funds at https://app.fabraix.com/billing.",
    404: `Not found: ${path}`,
    409: "A run for this config is already in progress. Use `nyx status <name>` to check it.",
    422: `Validation error: ${detail}`,
    425: "Run is still in progress. Report not ready yet.",
  };

  throw new NyxError(
    messages[res.status] || `API error ${res.status}: ${detail}`,
    "api",
    res.status
  );
}
