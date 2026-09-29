const DEFAULT_BASE = "https://api.fabraix.com";

export function getBaseUrl(): string {
  return process.env.NYX_API_URL || DEFAULT_BASE;
}
