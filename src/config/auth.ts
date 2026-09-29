import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const NYX_DIR = join(homedir(), ".nyx");
const CRED_FILE = join(NYX_DIR, "credentials.json");

export interface StoredCredentials {
  token: string;
  email?: string;
  /** Server-validated identity keeps durable local state stable across token rotation. */
  user_id?: string;
  /** Account is part of every Nyx idempotency boundary. */
  account_id?: string;
  expires_at?: string;
}

function storedCredentials(): StoredCredentials | null {
  if (!existsSync(CRED_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(CRED_FILE, "utf-8")) as StoredCredentials;
    return typeof data.token === "string" && data.token ? data : null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  const envToken = process.env.NYX_TOKEN;
  if (envToken) return envToken;

  return storedCredentials()?.token ?? null;
}

function jwtPrincipal(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const value = payload.userId ?? payload.sub;
    return typeof value === "string" && value.length > 0 && value.length <= 300
      && !/[\u0000-\u001f\u007f]/.test(value) ? `user:${value}` : null;
  } catch {
    return null;
  }
}

/**
 * Stable local namespace only; authentication still uses the signed token on
 * every request. JWT claims are decoded (not trusted for authorization) so a
 * refreshed token for the same user can recover uncertain local operations.
 */
export function getPrincipalId(): string | null {
  const token = getToken();
  if (!token) return null;
  const explicitAccount = process.env.NYX_ACCOUNT_ID;
  const explicitPrincipal = process.env.NYX_PRINCIPAL_ID;
  const valid = (value: string | undefined): value is string => Boolean(
    value && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value),
  );
  const decoded = jwtPrincipal(token);
  if (valid(explicitAccount) && (valid(explicitPrincipal) || decoded)) {
    return `account:${explicitAccount}:${explicitPrincipal ? `configured:${explicitPrincipal}` : decoded}`;
  }
  if (valid(explicitAccount)) {
    return `account:${explicitAccount}:credential:${createHash("sha256").update(token).digest("hex")}`;
  }
  const stored = storedCredentials();
  if (!process.env.NYX_TOKEN && stored?.token === token && stored.user_id && stored.account_id) {
    return `account:${stored.account_id}:user:${stored.user_id}`;
  }
  return null;
}

/** Account asserted on every Nyx transport request and checked server-side. */
export function getExpectedAccountId(): string | null {
  const explicit = process.env.NYX_ACCOUNT_ID;
  if (explicit && explicit.length <= 300 && !/[\u0000-\u001f\u007f]/.test(explicit)) {
    return explicit;
  }
  const stored = storedCredentials();
  return !process.env.NYX_TOKEN && stored?.account_id ? stored.account_id : null;
}

export function saveCredentials(creds: StoredCredentials): void {
  mkdirSync(NYX_DIR, { recursive: true, mode: 0o700 });
  chmodSync(NYX_DIR, 0o700);
  const temporary = `${CRED_FILE}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, JSON.stringify(creds, null, 2) + "\n");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, CRED_FILE);
    chmodSync(CRED_FILE, 0o600);
    syncDirectory(NYX_DIR);
    syncDirectory(dirname(NYX_DIR));
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename normally consumed it. */ }
  }
}

export function removeCredentials(): boolean {
  if (!existsSync(CRED_FILE)) return false;
  unlinkSync(CRED_FILE);
  syncDirectory(NYX_DIR);
  return true;
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "EPERM", "ENOTSUP", "EISDIR"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
