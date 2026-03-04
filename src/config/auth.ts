import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NYX_DIR = join(homedir(), ".nyx");
const CRED_FILE = join(NYX_DIR, "credentials.json");

export interface StoredCredentials {
  token: string;
  email?: string;
  expires_at?: string;
}

export function getToken(): string | null {
  const envToken = process.env.NYX_TOKEN;
  if (envToken) return envToken;

  if (!existsSync(CRED_FILE)) return null;
  try {
    const data: StoredCredentials = JSON.parse(readFileSync(CRED_FILE, "utf-8"));
    return data.token || null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  mkdirSync(NYX_DIR, { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export function removeCredentials(): boolean {
  if (!existsSync(CRED_FILE)) return false;
  unlinkSync(CRED_FILE);
  return true;
}
