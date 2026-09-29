import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getPrincipalId, getToken } from "../config/auth.js";
import { NyxError } from "../utils/errors.js";
import { getBaseUrl } from "./client.js";

type RequestKind = "create-session" | "message";

interface PendingRequest<T> {
  version: 1 | 2 | 3 | 4;
  kind: RequestKind;
  fingerprint: string;
  identity: string;
  body: T;
  /** Number of dispatches begun; v1 is conservatively treated as already attempted. */
  attempts?: number;
  /** False for a random per-launch identity; true only for caller-requested sharing. */
  shared_identity?: boolean;
  /** Keyed semantic operation scope (including session ID for messages). */
  operation_fingerprint?: string;
  owner_pid?: number;
  owner_id?: string;
  created_at?: string;
  updated_at?: string;
  /** Local routing metadata. This is never included in the HTTP request body. */
  session_id?: string;
}

export interface OutboxReceiptQuery {
  kind: RequestKind;
  identity: string;
  sessionId?: string;
}

export type OutboxReceiptState = "committed" | "not_committed" | "unknown";

export interface OutboxMaintenanceResult {
  enumerated: number;
  scanned: number;
  reclaimed: number;
  retained: number;
  errors: string[];
}

export interface PreparedRequest<T> {
  body: T;
  beginAttempt(): number;
  rejectIfUnambiguous(attempt: number): boolean;
  acknowledge(): void;
  /** Release this process's in-memory claim while retaining uncertain state. */
  abandon(): void;
}

const lockWaiter = new Int32Array(new SharedArrayBuffer(4));
const processOwnerId = randomUUID();
const activeFiles = new Set<string>();
const CLAIM_STALE_MS = 5 * 60_000;
const TEMP_STALE_MS = 30_000;
const UNATTEMPTED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const OUTBOX_NAMESPACE = "requests-v4";
const DEFAULT_SWEEP_LIMIT = 128;
const digestPattern = /^[a-f0-9]{64}$/;
const migratedScopes = new Set<string>();

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // Windows and a few network filesystems do not expose directory fsync.
    // File fsync still preserves the inode; Unix production hosts take the
    // stronger directory-entry durability path.
    if (!["EINVAL", "EPERM", "ENOTSUP", "EISDIR"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeDurableExclusive(file: string, contents: string | Buffer): void {
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureDurableDirectory(directory: string): void {
  while (true) {
    const missing: string[] = [];
    let cursor = directory;
    while (!existsSync(cursor)) {
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      // Persist each newly created name in its parent, outermost first. This is
      // what makes a freshly created ~/.nyx/outbox scope survive a machine
      // crash, not only the record inode inside it.
      for (const created of missing.reverse()) {
        syncDirectory(created);
        syncDirectory(dirname(created));
      }
      if (existsSync(directory)) return;
    } catch (error) {
      // Background pruning can remove a still-empty operation shard between
      // mkdir and fsync. Retry until this foreground caller publishes its lock.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function unlinkDurable(file: string): boolean {
  try {
    unlinkSync(file);
    syncDirectory(dirname(file));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function stateRoot(): string {
  return process.env.NYX_STATE_DIR ?? join(homedir(), ".nyx", "sessions");
}

function localOutboxKey(): Buffer {
  const root = stateRoot();
  const file = join(root, "outbox.key");
  ensureDurableDirectory(root);
  try {
    const value = readFileSync(file);
    if (value.length !== 32) throw unreadableState();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const candidate = randomBytes(32);
  try {
    writeDurableExclusive(file, candidate);
    syncDirectory(root);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    const value = readFileSync(file);
    if (value.length !== 32) throw unreadableState();
    return value;
  } catch (error) {
    if (error instanceof NyxError) throw error;
    throw unreadableState();
  }
}

interface OutboxScope {
  directory: string;
  principal: string;
  secret: Buffer;
  server: string;
}

function scope(): OutboxScope {
  const token = getToken();
  if (!token) throw new NyxError("Not authenticated. Run `nyx login` or set NYX_TOKEN.", "auth");
  const principal = getPrincipalId();
  if (!principal) throw new NyxError("Could not identify the authenticated principal.", "auth");
  const server = getBaseUrl().replace(/\/$/, "");
  // The token is never written. The stable principal preserves recovery when
  // a short-lived credential rotates; the server still authenticates every
  // request with the current token.
  const key = createHash("sha256").update(canonical([server, principal])).digest("hex");
  return { directory: join(stateRoot(), "outbox", key), principal, secret: localOutboxKey(), server };
}

function fingerprint(secret: Buffer, server: string, principal: string, kind: RequestKind,
  key: unknown): string {
  // A local random key keeps low-entropy prompt text out of filenames without
  // coupling recovery to an expiring authentication token.
  return createHmac("sha256", secret)
    .update(canonical([server, principal, kind, key]))
    .digest("hex");
}

function unreadableState(): NyxError {
  // Never silently replace an uncertain idempotency identity: that could
  // duplicate a paid session or a user instruction.
  return new NyxError(
    "Pending Nyx request state is unreadable. Preserve ~/.nyx and inspect the local outbox before retrying.",
    "config",
  );
}

function readRecord<T>(file: string): PendingRequest<T> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingRequest<T>>;
    if (![1, 2, 3, 4].includes(value.version ?? 0)
      || ((value.version === 2 || value.version === 3 || value.version === 4)
        && (!Number.isSafeInteger(value.attempts) || (value.attempts ?? -1) < 0))
      || !["create-session", "message"].includes(value.kind ?? "")
      || typeof value.fingerprint !== "string" || typeof value.identity !== "string"
      || !value.identity || value.body === null || typeof value.body !== "object" || Array.isArray(value.body)) {
      throw unreadableState();
    }
    if ((value.version === 3 || value.version === 4) && (typeof value.shared_identity !== "boolean"
      || typeof value.operation_fingerprint !== "string" || !value.operation_fingerprint
      || !digestPattern.test(value.operation_fingerprint)
      || !Number.isSafeInteger(value.owner_pid) || (value.owner_pid ?? 0) <= 0
      || typeof value.owner_id !== "string" || !value.owner_id
      || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
      || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at)))) {
      throw unreadableState();
    }
    if (value.version === 4 && value.session_id !== undefined
      && (typeof value.session_id !== "string" || !value.session_id || value.session_id.length > 200
        || /[\u0000-\u001f\u007f]/.test(value.session_id))) throw unreadableState();
    return value as PendingRequest<T>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof NyxError) throw error;
    throw unreadableState();
  }
}

function replaceRecord<T>(file: string, record: PendingRequest<T>): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeDurableExclusive(temporary, `${JSON.stringify(record)}\n`);
    renameSync(temporary, file);
    // The renamed inode and its replacement directory entry must reach stable
    // storage before a network dispatch can begin.
    syncDirectory(dirname(file));
  } finally {
    try { unlinkDurable(temporary); } catch { /* Preserve the original operation error. */ }
  }
}

function lockFile(file: string): () => void {
  const lock = `${file}.lock`;
  const owner = join(lock, "owner.json");
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(owner, `${JSON.stringify({ pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        try { rmdirSync(lock); } catch { /* Preserve the original write error. */ }
        throw error;
      }
      return () => {
        try { unlinkSync(owner); } catch { /* A dead-process recovery may already have removed it. */ }
        try { rmdirSync(lock); } catch { /* A concurrent recovery will retry safely. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Empty operation shards are pruned in the background. Recreate the
        // parent and retry if pruning raced this foreground allocation; once
        // the lock directory exists, rmdir can no longer remove the shard.
        ensureDurableDirectory(dirname(file));
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const saved = JSON.parse(readFileSync(owner, "utf8")) as { pid?: unknown };
        // A lock is held only around a few synchronous filesystem calls. Treat
        // an old directory as abandoned even if the recorded PID has since
        // been reused by an unrelated process; otherwise that ordinary OS
        // event can wedge this request identity forever.
        stale = Date.now() - statSync(lock).mtimeMs > 30_000;
        if (Number.isSafeInteger(saved.pid) && (saved.pid as number) > 0) {
          try { process.kill(saved.pid as number, 0); }
          catch (probe) {
            stale = stale || (probe as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        // A creator can crash between mkdir and writing the owner. Never break
        // a fresh lock, but recover that otherwise permanent wedge after 30s.
        try { stale = Date.now() - statSync(lock).mtimeMs > 30_000; } catch { /* It disappeared. */ }
      }
      if (stale) {
        try { unlinkSync(owner); } catch { /* Missing owner is expected. */ }
        try { rmdirSync(lock); } catch { /* A live owner won the race. */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new NyxError("Another Nyx process is updating this pending request; retry shortly.", "config");
      }
      Atomics.wait(lockWaiter, 0, 0, 10);
    }
  }
}

function writeExclusive<T>(file: string, record: PendingRequest<T>): boolean {
  ensureDurableDirectory(dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    // Publish a fully closed immutable inode. A concurrent reader can observe
    // either no record or the complete record, never a partially written JSON
    // file, and link's EEXIST preserves the winner.
    writeDurableExclusive(temporary, `${JSON.stringify(record)}\n`);
    try {
      linkSync(temporary, file);
      syncDirectory(dirname(file));
      return true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try { unlinkDurable(temporary); } catch { /* The temporary was never a request identity. */ }
  }
}

function recordAttempts(record: PendingRequest<unknown>): number {
  return record.version === 1 ? 1 : record.attempts!;
}

function expectedRecordName(record: PendingRequest<unknown>): string {
  return `${record.kind}-${record.fingerprint}.json`;
}

function strictRecordName(name: string): boolean {
  return /^(?:create-session|message)-[a-f0-9]{64}\.json$/.test(name);
}

function namespaceDirectory(directory: string): string {
  return join(directory, OUTBOX_NAMESPACE);
}

function identityDirectory(directory: string): string {
  return join(namespaceDirectory(directory), "identities");
}

function operationDirectory(directory: string, kind: RequestKind,
  operationFingerprint: string): string {
  if (!digestPattern.test(operationFingerprint)) throw unreadableState();
  return join(namespaceDirectory(directory), "operations", kind, operationFingerprint);
}

function recordFile(directory: string, record: PendingRequest<unknown>): string {
  if (record.version < 3 || !record.operation_fingerprint) throw unreadableState();
  const parent = record.shared_identity
    ? identityDirectory(directory)
    : operationDirectory(directory, record.kind, record.operation_fingerprint);
  return join(parent, expectedRecordName(record));
}

function sameIdentityAndBody(left: PendingRequest<unknown>, right: PendingRequest<unknown>): boolean {
  return left.kind === right.kind && left.fingerprint === right.fingerprint
    && left.identity === right.identity && canonical(left.body) === canonical(right.body);
}

interface MigrationScope {
  sharedIdentity: boolean;
  operationFingerprint: string;
  sessionId?: string;
}

function migrationScoped(record: PendingRequest<Record<string, unknown>>,
  expected?: MigrationScope): PendingRequest<Record<string, unknown>> {
  if (record.version === 1 || record.version === 2) {
    if (!expected) throw unreadableState();
    const now = new Date().toISOString();
    return {
      ...record,
      version: 4,
      attempts: recordAttempts(record),
      shared_identity: expected.sharedIdentity,
      operation_fingerprint: expected.operationFingerprint,
      owner_pid: process.pid,
      owner_id: processOwnerId,
      created_at: now,
      updated_at: now,
      ...(expected.sessionId ? { session_id: expected.sessionId } : {}),
    };
  }
  if (expected && (record.shared_identity !== expected.sharedIdentity
    || record.operation_fingerprint !== expected.operationFingerprint
    || (record.session_id !== undefined && expected.sessionId !== undefined
      && record.session_id !== expected.sessionId))) throw unreadableState();
  return expected?.sessionId && record.session_id === undefined
    ? { ...record, version: 4, session_id: expected.sessionId }
    : record;
}

function mergedMigrationRecord(
  source: PendingRequest<Record<string, unknown>>,
  destination: PendingRequest<Record<string, unknown>>,
): PendingRequest<Record<string, unknown>> {
  if (!sameIdentityAndBody(source, destination)
    || source.version < 3 || destination.version < 3
    || source.shared_identity !== destination.shared_identity
    || source.operation_fingerprint !== destination.operation_fingerprint
    || (source.session_id !== undefined && destination.session_id !== undefined
      && source.session_id !== destination.session_id)) throw unreadableState();
  const sourceUpdated = Date.parse(source.updated_at!);
  const destinationUpdated = Date.parse(destination.updated_at!);
  const newest = sourceUpdated > destinationUpdated ? source : destination;
  const createdAt = Date.parse(source.created_at!) < Date.parse(destination.created_at!)
    ? source.created_at! : destination.created_at!;
  return {
    ...newest,
    version: 4,
    attempts: Math.max(recordAttempts(source), recordAttempts(destination)),
    shared_identity: source.shared_identity,
    operation_fingerprint: source.operation_fingerprint,
    created_at: createdAt,
    updated_at: new Date(Math.max(sourceUpdated, destinationUpdated)).toISOString(),
    ...(source.session_id ?? destination.session_id
      ? { session_id: source.session_id ?? destination.session_id }
      : {}),
  };
}

/**
 * Publish a legacy record into the strict namespace before unlinking its old
 * name. A crash can leave two equivalent receipts, but can never lose the only
 * idempotency identity. Maintenance safely collapses the duplicate later.
 */
function migrateRecord(source: string, destination: string,
  record: PendingRequest<Record<string, unknown>>, expected?: MigrationScope): boolean {
  if (source === destination || activeFiles.has(source)) return source === destination;
  ensureDurableDirectory(dirname(destination));
  const releaseSource = lockFile(source);
  try {
    const current = readRecord<Record<string, unknown>>(source);
    if (!current || !sameIdentityAndBody(current, record)) return false;
    const scopedCurrent = migrationScoped(current, expected);
    if (ownerAppearsActive(scopedCurrent, source)) return false;
    const releaseDestination = lockFile(destination);
    try {
      const existing = readRecord<Record<string, unknown>>(destination);
      if (existing && ownerAppearsActive(existing, destination)) return false;
      if (existing) {
        const merged = mergedMigrationRecord(scopedCurrent, migrationScoped(existing, expected));
        replaceRecord(destination, merged);
      } else if (!writeExclusive(destination, scopedCurrent)) {
        const winner = readRecord<Record<string, unknown>>(destination);
        if (!winner || ownerAppearsActive(winner, destination)) return false;
        replaceRecord(
          destination,
          mergedMigrationRecord(scopedCurrent, migrationScoped(winner, expected)),
        );
      }
      unlinkDurable(source);
      return true;
    } finally {
      releaseDestination();
    }
  } finally {
    releaseSource();
  }
}

/**
 * Current flat v3 records contain enough keyed metadata to migrate without
 * inspecting request prose. Do this at most once per authenticated scope in a
 * process; every submit after startup touches only its identity or operation
 * shard. Malformed legacy files remain in place for operator inspection and do
 * not poison unrelated operation shards.
 */
function migrateLegacyScopeOnce(scoped: OutboxScope): void {
  if (migratedScopes.has(scoped.directory)) return;
  ensureDurableDirectory(scoped.directory);
  let retryNeeded = false;
  for (const name of readdirSync(scoped.directory)) {
    if (!strictRecordName(name)) continue;
    const source = join(scoped.directory, name);
    let record: PendingRequest<Record<string, unknown>> | undefined;
    try {
      record = readRecord<Record<string, unknown>>(source);
    } catch {
      // Retain an unreadable possible receipt. It is surfaced by maintenance,
      // while unrelated semantic operations remain usable.
      continue;
    }
    if (!record || name !== expectedRecordName(record) || record.version < 3) continue;
    try {
      if (!migrateRecord(source, recordFile(scoped.directory, record), record)) retryNeeded = true;
    } catch {
      // A readable legacy receipt that could not be published must be retried;
      // otherwise a transient lock could make a later launch allocate a second
      // identity for the same unresolved operation.
      retryNeeded = true;
    }
  }
  if (!retryNeeded) migratedScopes.add(scoped.directory);
}

function ownerAppearsActive(record: PendingRequest<unknown>, file: string): boolean {
  if (activeFiles.has(file)) return true;
  if (record.version !== 3 && record.version !== 4) return false;
  if (record.owner_id === processOwnerId) return false;
  if (Date.now() - Date.parse(record.updated_at!) > CLAIM_STALE_MS) return false;
  try {
    process.kill(record.owner_pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function strictEntries(directory: string): string[] {
  try {
    return readdirSync(directory).filter(strictRecordName).map((name) => join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function recordMtime(file: string): number {
  try { return statSync(file).mtimeMs; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Number.POSITIVE_INFINITY;
    throw error;
  }
}

function pruneEmptyOperationDirectory(directory: string): void {
  const kindDirectory = dirname(directory);
  if (!digestPattern.test(basename(directory))
    || !["create-session", "message"].includes(basename(kindDirectory))
    || basename(dirname(kindDirectory)) !== "operations") return;
  try {
    rmdirSync(directory);
    syncDirectory(kindDirectory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )) throw error;
  }
}

function pruneOperationShardForFile(file: string): void {
  pruneEmptyOperationDirectory(dirname(file));
}

interface MaintenanceListing {
  files: string[];
  enumerated: number;
}

async function streamRecordDirectory(options: {
  directory: string;
  files: string[];
  fileLimit: number;
  workLimit: number;
  signal?: AbortSignal;
  pruneWhenEmpty?: boolean;
}): Promise<number> {
  let enumerated = 0;
  try {
    const entries = await opendir(options.directory);
    for await (const entry of entries) {
      if (options.signal?.aborted || options.files.length >= options.fileLimit
        || enumerated >= options.workLimit) break;
      enumerated += 1;
      const file = join(options.directory, entry.name);
      if (entry.isFile() && strictRecordName(entry.name)) {
        options.files.push(file);
      } else if (entry.isFile() && entry.name.endsWith(".tmp")) {
        try {
          if (Date.now() - statSync(file).mtimeMs > TEMP_STALE_MS) unlinkDurable(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    if (options.pruneWhenEmpty) pruneEmptyOperationDirectory(options.directory);
  }
  return enumerated;
}

async function streamOperationShards(options: {
  directory: string;
  files: string[];
  fileLimit: number;
  workLimit: number;
  signal?: AbortSignal;
}): Promise<number> {
  let enumerated = 0;
  try {
    const shards = await opendir(options.directory);
    for await (const entry of shards) {
      if (options.signal?.aborted || options.files.length >= options.fileLimit
        || enumerated >= options.workLimit) break;
      enumerated += 1;
      if (!entry.isDirectory() || !digestPattern.test(entry.name)) continue;
      const remaining = options.workLimit - enumerated;
      if (remaining <= 0) break;
      enumerated += await streamRecordDirectory({
        directory: join(options.directory, entry.name),
        files: options.files,
        fileLimit: options.fileLimit,
        workLimit: remaining,
        signal: options.signal,
        pruneWhenEmpty: true,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return enumerated;
}

/** Stream only bounded work from the namespace owned by this outbox. */
async function maintenanceFiles(directory: string, limit: number,
  signal?: AbortSignal): Promise<MaintenanceListing> {
  const files: string[] = [];
  // Count directory entries, not only records: a historical forest of empty
  // shards must not turn one TUI startup into an O(all-shards) pause.
  const workLimit = Math.max(32, Math.min(limit * 8, 4_000));
  const smallSectionLimit = Math.min(64, Math.max(4, Math.floor(workLimit / 8)));
  let enumerated = 0;
  for (const staticDirectory of [directory, identityDirectory(directory)]) {
    enumerated += await streamRecordDirectory({
      directory: staticDirectory,
      files,
      fileLimit: limit,
      workLimit: Math.min(smallSectionLimit, workLimit - enumerated),
      signal,
    });
  }
  const remaining = Math.max(0, workLimit - enumerated);
  const perKind = Math.max(1, Math.floor(remaining / 2));
  for (const kind of ["create-session", "message"] as const) {
    if (files.length >= limit || signal?.aborted) break;
    enumerated += await streamOperationShards({
      directory: join(namespaceDirectory(directory), "operations", kind),
      files,
      fileLimit: limit,
      workLimit: Math.min(perKind, workLimit - enumerated),
      signal,
    });
  }
  return { files, enumerated };
}

function deleteIfCurrent(file: string, identity: string,
  predicate: (record: PendingRequest<Record<string, unknown>>) => boolean): boolean {
  const release = lockFile(file);
  let deleted = false;
  try {
    const current = readRecord<Record<string, unknown>>(file);
    if (!current || current.identity !== identity || activeFiles.has(file)
      || ownerAppearsActive(current, file) || !predicate(current)) return false;
    deleted = unlinkDurable(file);
  } finally {
    release();
  }
  if (deleted) pruneOperationShardForFile(file);
  return deleted;
}

/**
 * Bounded, lifecycle-owned maintenance. Attempted writes are never removed by
 * age: only the authenticated server can authoritatively classify them as
 * committed or definitively not committed. Unknown and transport failures are
 * retained byte-for-byte for a future sweep.
 */
export async function maintainRequestOutbox(options: {
  signal?: AbortSignal;
  limit?: number;
  resolveReceipt(query: OutboxReceiptQuery, signal?: AbortSignal): Promise<OutboxReceiptState>;
}): Promise<OutboxMaintenanceResult> {
  // Let the caller start its foreground request first; maintenance must never
  // add synchronous startup latency to the bare TUI.
  await Promise.resolve();
  const result: OutboxMaintenanceResult = {
    enumerated: 0, scanned: 0, reclaimed: 0, retained: 0, errors: [],
  };
  if (options.signal?.aborted) return result;
  let scoped: OutboxScope;
  try {
    scoped = scope();
    migrateLegacyScopeOnce(scoped);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SWEEP_LIMIT, 1_000));
  let files: string[];
  try {
    const listing = await maintenanceFiles(scoped.directory, limit, options.signal);
    files = listing.files;
    result.enumerated = listing.enumerated;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index];
      result.scanned += 1;
      try {
        const record = readRecord<Record<string, unknown>>(file);
        if (!record) continue;
        const name = basename(file);
        if (name !== expectedRecordName(record)) throw unreadableState();
        if (activeFiles.has(file) || ownerAppearsActive(record, file)) {
          result.retained += 1;
          continue;
        }
        const attempts = recordAttempts(record);
        if (attempts === 0) {
          let stale = false;
          try { stale = Date.now() - statSync(file).mtimeMs > UNATTEMPTED_RETENTION_MS; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (stale && deleteIfCurrent(file, record.identity,
            (current) => recordAttempts(current) === 0)) result.reclaimed += 1;
          else result.retained += 1;
          continue;
        }
        if (record.kind === "message" && !record.session_id) {
          // Legacy message journals did not persist the routing metadata. They
          // remain replay-safe but cannot be queried without guessing a tenant
          // resource, so only an exact later replay may retire them.
          result.retained += 1;
          continue;
        }
        let state: OutboxReceiptState;
        try {
          state = await options.resolveReceipt({
            kind: record.kind,
            identity: record.identity,
            ...(record.session_id ? { sessionId: record.session_id } : {}),
          }, options.signal);
        } catch {
          result.retained += 1;
          continue;
        }
        if (state === "unknown") {
          result.retained += 1;
          continue;
        }
        if (deleteIfCurrent(file, record.identity,
          (current) => recordAttempts(current) > 0)) result.reclaimed += 1;
        else result.retained += 1;
      } catch (error) {
        // One corrupt receipt can block only its identity/operation shard. It
        // is deliberately retained, and every other shard is still swept.
        result.retained += 1;
        if (result.errors.length < 32) {
          result.errors.push(`${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => worker()));
  return result;
}

function claimed<T>(record: PendingRequest<T>, sharedIdentity: boolean,
  operationFingerprint: string, sessionId?: string): PendingRequest<T> {
  const now = new Date().toISOString();
  return {
    ...record,
    version: 4,
    attempts: recordAttempts(record as PendingRequest<unknown>),
    shared_identity: sharedIdentity,
    operation_fingerprint: operationFingerprint,
    owner_pid: process.pid,
    owner_id: processOwnerId,
    created_at: record.version === 3 || record.version === 4 ? record.created_at : now,
    updated_at: now,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function prepare<T extends Record<string, unknown>>(options: {
  kind: RequestKind;
  semanticBody: unknown;
  identityField: string;
  preferredIdentity?: string;
  sessionId?: string;
  makeBody(identity: string): T;
  matches(stored: T): boolean;
}): PreparedRequest<T> {
  if (options.preferredIdentity !== undefined && !options.preferredIdentity) throw unreadableState();
  const scoped = scope();
  ensureDurableDirectory(scoped.directory);
  const sharedIdentity = options.preferredIdentity !== undefined;
  const operationFingerprint = fingerprint(
    scoped.secret, scoped.server, scoped.principal, options.kind,
    { semantic: options.semanticBody },
  );
  migrateLegacyScopeOnce(scoped);
  let record: PendingRequest<T> | undefined;
  let file: string | undefined;

  if (!sharedIdentity) {
    // A fresh launch owns a fresh server idempotency identity. Recover only an
    // inactive prior launch with the same exact semantic body; a live caller,
    // even with identical options, remains an independent requested session.
    const operation = operationDirectory(scoped.directory, options.kind, operationFingerprint);
    ensureDurableDirectory(operation);
    // v1/v2 generated journals used the semantic fingerprint as their flat
    // filename. Migrate that one exact candidate without scanning the scope.
    const legacy = join(scoped.directory, `${options.kind}-${operationFingerprint}.json`);
    if (existsSync(legacy)) {
      const legacyRecord = readRecord<T>(legacy);
      if (!legacyRecord || legacyRecord.kind !== options.kind
        || legacyRecord.fingerprint !== operationFingerprint
        || !options.matches(legacyRecord.body)
        || legacyRecord.body[options.identityField] !== legacyRecord.identity) throw unreadableState();
      migrateRecord(
        legacy,
        join(operation, expectedRecordName(legacyRecord as PendingRequest<unknown>)),
        legacyRecord as PendingRequest<Record<string, unknown>>,
        { sharedIdentity: false, operationFingerprint, sessionId: options.sessionId },
      );
    }
    const candidates = strictEntries(operation)
      .sort((left, right) => recordMtime(left) - recordMtime(right));
    for (const candidateFile of candidates) {
      const name = basename(candidateFile);
      const candidate = readRecord<T>(candidateFile);
      if (!candidate || name !== expectedRecordName(candidate as PendingRequest<unknown>)
        || (candidate.version === 3 || candidate.version === 4
          ? candidate.shared_identity || candidate.operation_fingerprint !== operationFingerprint
          : candidate.fingerprint !== operationFingerprint)
        || !options.matches(candidate.body)
        || candidate.body[options.identityField] !== candidate.identity
        || ownerAppearsActive(candidate as PendingRequest<unknown>, candidateFile)) continue;
      const release = lockFile(candidateFile);
      try {
        const current = readRecord<T>(candidateFile);
        if (!current || (current.version === 3 || current.version === 4
          ? current.shared_identity || current.operation_fingerprint !== operationFingerprint
          : current.fingerprint !== operationFingerprint)
          || !options.matches(current.body)
          || current.body[options.identityField] !== current.identity
          || ownerAppearsActive(current as PendingRequest<unknown>, candidateFile)) continue;
        record = claimed(current, false, operationFingerprint, options.sessionId);
        replaceRecord(candidateFile, record);
        file = candidateFile;
        break;
      } finally {
        release();
      }
    }
  }

  if (!record) {
    const identity = options.preferredIdentity ?? randomUUID();
    const digest = fingerprint(scoped.secret, scoped.server, scoped.principal, options.kind, { identity });
    const parent = sharedIdentity
      ? identityDirectory(scoped.directory)
      : operationDirectory(scoped.directory, options.kind, operationFingerprint);
    ensureDurableDirectory(parent);
    file = join(parent, `${options.kind}-${digest}.json`);
    if (sharedIdentity) {
      // A caller-provided identity is globally fenced within this authenticated
      // scope. Import its one legacy flat record into the direct identity slot.
      const legacy = join(scoped.directory, `${options.kind}-${digest}.json`);
      if (!existsSync(file) && existsSync(legacy)) {
        const legacyRecord = readRecord<T>(legacy);
        if (!legacyRecord || legacyRecord.kind !== options.kind
          || legacyRecord.fingerprint !== digest || legacyRecord.identity !== identity
          || !options.matches(legacyRecord.body)
          || legacyRecord.body[options.identityField] !== legacyRecord.identity) throw unreadableState();
        migrateRecord(
          legacy,
          file,
          legacyRecord as PendingRequest<Record<string, unknown>>,
          { sharedIdentity: true, operationFingerprint, sessionId: options.sessionId },
        );
      }
    }
    const unlock = lockFile(file);
    try {
      record = readRecord<T>(file);
      if (!record) {
        const now = new Date().toISOString();
        const candidate: PendingRequest<T> = {
          version: 4,
          kind: options.kind,
          fingerprint: digest,
          identity,
          body: options.makeBody(identity),
          attempts: 0,
          shared_identity: sharedIdentity,
          operation_fingerprint: operationFingerprint,
          owner_pid: process.pid,
          owner_id: processOwnerId,
          created_at: now,
          updated_at: now,
          ...(options.sessionId ? { session_id: options.sessionId } : {}),
        };
        if (writeExclusive(file, candidate)) record = candidate;
        else record = readRecord<T>(file);
      } else if (sharedIdentity) {
        // An explicit identity is the caller's cross-retry operation key, not
        // permission to retarget that operation. Validate its full
        // semantic scope before refreshing its owner claim; in particular,
        // identical message prose in another session must fail closed without
        // mutating the recoverable original journal.
        if (record.kind !== options.kind || record.fingerprint !== digest
          || record.identity !== options.preferredIdentity
          || !options.matches(record.body)
          || record.body[options.identityField] !== record.identity
          || ((record.version === 3 || record.version === 4) && (!record.shared_identity
            || record.operation_fingerprint !== operationFingerprint))) throw unreadableState();
        // A legacy record has no separately persisted semantic fingerprint.
        // Its exact identity/body validation above preserves recovery; this
        // successful claim upgrades it once to the scoped v4 representation.
        record = claimed(record, true, operationFingerprint, options.sessionId);
        replaceRecord(file, record);
      }
    } finally {
      unlock();
    }
  }

  if (!file || !record || record.kind !== options.kind
    || basename(file) !== expectedRecordName(record as PendingRequest<unknown>)
    || (options.preferredIdentity !== undefined && record.identity !== options.preferredIdentity)
    || !options.matches(record.body) || record.body[options.identityField] !== record.identity
    || ((record.version === 3 || record.version === 4)
      && record.operation_fingerprint !== operationFingerprint)
    || (record.version === 4 && options.sessionId !== undefined
      && record.session_id !== options.sessionId)) {
    throw unreadableState();
  }
  activeFiles.add(file);

  const requestFile = file;
  const requestRecord = record;
  return {
    body: requestRecord.body,
    beginAttempt(): number {
      // Persist dispatch admission before touching the network. If the process
      // dies after this point, a later 4xx can no longer erase a request whose
      // first effect may already have committed.
      const release = lockFile(requestFile);
      try {
        const current = readRecord<T>(requestFile);
        if (!current || current.identity !== requestRecord.identity) throw unreadableState();
        const attempt = recordAttempts(current as PendingRequest<unknown>) + 1;
        replaceRecord(requestFile, {
          ...claimed(current, sharedIdentity, operationFingerprint, options.sessionId),
          attempts: attempt,
        });
        return attempt;
      } finally {
        release();
      }
    },
    rejectIfUnambiguous(attempt: number): boolean {
      // Only the sole first admitted dispatch can prove a synchronous 4xx had
      // no effect. A restart, concurrent caller or retry increments attempts
      // first and therefore retains the exact identity for receipt recovery.
      const release = lockFile(requestFile);
      let rejected = false;
      try {
        const current = readRecord<T>(requestFile);
        if (current?.identity === requestRecord.identity && attempt === 1
          && recordAttempts(current as PendingRequest<unknown>) === 1) {
          rejected = unlinkDurable(requestFile);
          activeFiles.delete(requestFile);
        }
      } finally {
        release();
      }
      pruneOperationShardForFile(requestFile);
      return rejected;
    },
    acknowledge(): void {
      // Serialize compare-and-unlink with allocation. A late ACK for an older
      // identity can never erase a newly installed request.
      const release = lockFile(requestFile);
      let acknowledged = false;
      try {
        const current = readRecord<T>(requestFile);
        if (current?.identity === requestRecord.identity) acknowledged = unlinkDurable(requestFile);
      } finally {
        activeFiles.delete(requestFile);
        release();
      }
      if (acknowledged || !existsSync(requestFile)) pruneOperationShardForFile(requestFile);
    },
    abandon(): void {
      // The durable record remains recoverable. Only the ephemeral ownership
      // claim is released, allowing another invocation in this process (or a
      // later process after liveness recovery) to deliver the exact identity.
      activeFiles.delete(requestFile);
    },
  };
}

export function prepareCreateSession<T extends Record<string, unknown>>(
  semanticBody: T,
  preferredIdentity?: string,
): PreparedRequest<T & { request_id: string }> {
  return prepare({
    kind: "create-session",
    semanticBody,
    identityField: "request_id",
    preferredIdentity,
    makeBody: (identity) => ({ ...semanticBody, request_id: identity }),
    matches: (stored) => {
      const { request_id: _identity, ...body } = stored;
      return canonical(body) === canonical(semanticBody);
    },
  });
}

export function prepareMessage<T extends Record<string, unknown>>(
  sessionId: string,
  semanticBody: T,
  expectedTurnId: string | null,
  preferredIdentity?: string,
): PreparedRequest<T & { expected_turn_id: string | null; message_id: string }> {
  return prepare({
    kind: "message",
    // expected_turn_id is deliberately absent. If an ACK was lost and the
    // selected turn advances, a restart must retry the original fenced write,
    // not silently redirect the same instruction to the new turn.
    semanticBody: { session_id: sessionId, ...semanticBody },
    identityField: "message_id",
    preferredIdentity,
    sessionId,
    makeBody: (identity) => ({ ...semanticBody, expected_turn_id: expectedTurnId, message_id: identity }),
    matches: (stored) => {
      const { expected_turn_id: _turn, message_id: _identity, ...body } = stored;
      return canonical(body) === canonical(semanticBody);
    },
  });
}
