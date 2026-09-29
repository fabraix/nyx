import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  createSession,
  interruptAgent,
  resolveOutboxReceipt,
  resumeRun,
  submitMessage,
} from "../dist/api/session.js";
import {
  maintainRequestOutbox,
  prepareCreateSession,
  prepareMessage,
} from "../dist/api/request-outbox.js";
import { startCallbackServer } from "../dist/commands/login.js";
import { createSessionController } from "../dist/ui/session-controller.js";
import { initialSessionState } from "../dist/ui/session-state.js";

const cli = new URL("../dist/index.js", import.meta.url);
const stateDirectory = mkdtempSync(join(tmpdir(), "nyx-cli-tests-"));
process.env.NYX_TOKEN = "local-test-token";
process.env.NYX_ACCOUNT_ID = "local-test-account";
process.env.NYX_API_URL = "http://127.0.0.1:1";
process.env.NYX_STATE_DIR = stateDirectory;

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function fixtureJwt(userId, nonce) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ userId, nonce })}.fixture`;
}

test("session creation reuses its authenticated-principal request identity after a lost response or HTTP500", async () => {
  const previous = globalThis.fetch;
  try {
    for (const failure of ["network", "500"]) {
      const bodies = [];
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.headers["X-Nyx-Account-ID"], "local-test-account");
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) {
          if (failure === "network") throw new TypeError("response lost after commit");
          return new Response("{}", { status: 500 });
        }
        return new Response(JSON.stringify({ session_id: "one-session", status: "idle" }));
      };
      assert.equal((await createSession({ budget: 5 })).session_id, "one-session");
      assert.equal(bodies.length, 2);
      assert.equal(typeof bodies[0].request_id, "string");
      assert.ok(bodies[0].request_id.length > 20);
      assert.deepEqual(bodies[0], bodies[1]);
    }
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("{}", { status: 409 }); };
    await assert.rejects(createSession({ requestId: "same-id", budget: 8 }), /409/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test("configured-run recovery uses the account-scoped idempotent resume endpoint", async () => {
  const previous = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(JSON.stringify({
        run_id: "run/with spaces",
        session_id: "session-1",
        status: "pending",
      }));
    };
    assert.deepEqual(await resumeRun("run/with spaces"), {
      run_id: "run/with spaces",
      session_id: "session-1",
      status: "pending",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, "POST");
    assert.equal(
      requests[0].url.pathname,
      "/v1/nyx/runs/run%2Fwith%20spaces/resume",
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("outbox receipt lookup uses authenticated query parameters and validates authority", async () => {
  const previous = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url);
      requests.push({ parsed, options });
      if (parsed.pathname.endsWith("/receipts/create")) {
        return new Response(JSON.stringify({ state: "committed", session_id: "created-session" }));
      }
      return new Response(JSON.stringify({
        state: "committed", completion_token: "input-message", sequence: 7,
      }));
    };
    assert.equal(await resolveOutboxReceipt({
      kind: "create-session", identity: "request/with space",
    }), "committed");
    assert.equal(await resolveOutboxReceipt({
      kind: "message", identity: "message/with space", sessionId: "session/with space",
    }), "committed");
    assert.equal(requests[0].parsed.pathname, "/v1/nyx/sessions/receipts/create");
    assert.equal(requests[0].parsed.searchParams.get("request_id"), "request/with space");
    assert.equal(requests[1].parsed.pathname,
      "/v1/nyx/sessions/session%2Fwith%20space/receipts/message");
    assert.equal(requests[1].parsed.searchParams.get("message_id"), "message/with space");
    assert.equal(requests[0].options.headers["X-Nyx-Account-ID"], "local-test-account");

    globalThis.fetch = async () => new Response(JSON.stringify({
      state: "committed", completion_token: null, sequence: null,
    }));
    await assert.rejects(
      resolveOutboxReceipt({ kind: "message", identity: "bad", sessionId: "session" }),
      /inconsistent message receipt/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("a malformed create acknowledgement stays pending until an exact retry succeeds", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-create-ack-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "", status: "idle" }));
    };
    await assert.rejects(createSession({ budget: 11 }), /invalid create acknowledgement/);
    assert.equal(bodies.length, 2, "a malformed 2xx is retried once with the same identity");
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(filesUnder(join(directory, "outbox")).length, 1);

    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "validated-session", status: "idle" }));
    };
    assert.equal((await createSession({ budget: 11 })).session_id, "validated-session");
    assert.deepEqual(bodies[2], bodies[0]);
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a 4xx after an uncertain create attempt cannot erase its durable identity", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-create-uncertain-4xx-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) throw new TypeError("lost response after commit");
      return new Response(JSON.stringify({ detail: "token rotated" }), { status: 401 });
    };
    await assert.rejects(
      createSession({ requestId: "uncertain-create", budget: 12 }),
      /token rotated/,
    );
    assert.equal(filesUnder(join(directory, "outbox")).length, 1);

    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "committed-session", status: "idle" }));
    };
    assert.equal((await createSession({ requestId: "uncertain-create", budget: 12 })).session_id,
      "committed-session");
    assert.ok(bodies.every((body) => body.request_id === "uncertain-create"));
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("session creation survives a process-style restart with its persisted request identity", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-create-outbox-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      throw new TypeError("connection lost after possible commit");
    };
    await assert.rejects(createSession({ budget: 7, target: "target-1", maxAgents: 3 }), /Could not reach/);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);

    const pending = filesUnder(join(directory, "outbox"));
    assert.equal(pending.length, 1);
    assert.equal(statSync(dirname(pending[0])).mode & 0o777, 0o700);
    assert.equal(statSync(pending[0]).mode & 0o777, 0o600);
    const persisted = JSON.parse(readFileSync(pending[0], "utf8"));
    assert.equal(persisted.identity, bodies[0].request_id);
    assert.equal(persisted.body.request_id, bodies[0].request_id);

    // A new invocation has no in-memory identity. It must recover the journaled
    // one and remove it only after the server acknowledges the exact request.
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "recovered-session", status: "idle" }));
    };
    assert.equal((await createSession({ budget: 7, target: "target-1", maxAgents: 3 })).session_id,
      "recovered-session");
    assert.deepEqual(bodies[2], bodies[0]);
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a new process delivers the shipping random-identity create journal", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-create-real-restart-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const moduleUrl = new URL("../dist/api/session.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { createSession } from ${JSON.stringify(moduleUrl)};
      try { await createSession({ budget: 19, target: "restart-target" }); } catch {}
    `], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        NYX_STATE_DIR: directory,
        NYX_API_URL: "http://127.0.0.1:1",
        NYX_TOKEN: "local-test-token",
        NYX_ACCOUNT_ID: "local-test-account",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const [journal] = filesUnder(join(directory, "outbox"));
    assert.ok(journal);
    const persisted = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(persisted.shared_identity, false);
    assert.equal(persisted.attempts, 2);

    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "restarted-session", status: "idle" }));
    };
    assert.equal((await createSession({ budget: 19, target: "restart-target" })).session_id,
      "restarted-session");
    assert.equal(bodies[0].request_id, persisted.identity);
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a late concurrent acknowledgement cannot erase a newer identical request", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-race-"));
  const requests = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => new Promise((resolve) => {
      requests.push({ body: JSON.parse(options.body), resolve });
    });
    const first = createSession({ budget: 13 });
    const second = createSession({ budget: 13 });
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].body.request_id, requests[1].body.request_id,
      "separate launches must not coalesce merely because their configuration matches");

    requests[0].resolve(new Response(JSON.stringify({ session_id: "first-session", status: "idle" })));
    await first;
    const third = createSession({ budget: 13 });
    assert.equal(requests.length, 3);
    assert.notEqual(requests[2].body.request_id, requests[0].body.request_id);

    // The second caller's ACK is for the old inode. Its compare-and-unlink is
    // serialized with allocation and must leave the third request intact.
    requests[1].resolve(new Response(JSON.stringify({ session_id: "second-session", status: "idle" })));
    await second;
    const pending = filesUnder(join(directory, "outbox"));
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(readFileSync(pending[0], "utf8")).identity, requests[2].body.request_id);

    requests[2].resolve(new Response(JSON.stringify({ session_id: "third-session", status: "idle" })));
    await third;
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("caller identities isolate concurrent equal requests and reject body reuse", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-preferred-identities-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const first = prepareCreateSession({ budget_usd: 5, config: {} }, "request-a");
    const second = prepareCreateSession({ budget_usd: 5, config: {} }, "request-b");
    assert.equal(first.body.request_id, "request-a");
    assert.equal(second.body.request_id, "request-b");
    assert.equal(filesUnder(join(directory, "outbox")).length, 2);
    assert.throws(
      () => prepareCreateSession({ budget_usd: 6, config: {} }, "request-a"),
      /outbox|unreadable/i,
    );
    first.acknowledge();
    second.acknowledge();
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("outbox maintenance deletes stale never-dispatched orphans off the submit path", async () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-gc-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const neverDispatched = prepareCreateSession({ budget_usd: 20, config: {} });
    neverDispatched.abandon();
    const [neverDispatchedFile] = filesUnder(join(directory, "outbox"));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    utimesSync(neverDispatchedFile, old, old);

    const uncertain = prepareCreateSession({ budget_usd: 21, config: {} });
    uncertain.beginAttempt();
    uncertain.abandon();
    const uncertainFile = filesUnder(join(directory, "outbox"))
      .find((file) => JSON.parse(readFileSync(file, "utf8")).body.budget_usd === 21);
    utimesSync(uncertainFile, old, old);

    const trigger = prepareCreateSession({ budget_usd: 22, config: {} });
    assert.equal(existsSync(neverDispatchedFile), true,
      "foreground prepare must not scan and clean the whole scope");
    trigger.acknowledge();
    await maintainRequestOutbox({ resolveReceipt: async () => "unknown" });
    assert.equal(existsSync(neverDispatchedFile), false);
    assert.equal(existsSync(uncertainFile), true,
      "an attempted write remains an idempotency receipt regardless of age");
    uncertain.acknowledge();
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("generated recovery reads only its semantic shard and ignores unrelated state files", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-shards-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const damaged = prepareCreateSession({ budget_usd: 31, config: {} });
    damaged.abandon();
    const [damagedFile] = filesUnder(join(directory, "outbox"));
    writeFileSync(damagedFile, "{not-json\n", { mode: 0o600 });
    const [scopeName] = readdirSync(join(directory, "outbox"));
    writeFileSync(join(directory, "outbox", scopeName, "notes.json"), "{not-an-outbox-record}\n");

    const unrelated = prepareCreateSession({ budget_usd: 32, config: {} });
    assert.equal(unrelated.body.budget_usd, 32,
      "a corrupt different shard must not make all foreground submissions scan or fail");
    unrelated.acknowledge();
    assert.throws(
      () => prepareCreateSession({ budget_usd: 31, config: {} }),
      /outbox|unreadable/i,
      "corruption remains fail-closed for the one semantic operation it can affect",
    );
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("flat v3 journals migrate into the keyed operation shard without changing identity", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-v3-migration-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const moduleUrl = new URL("../dist/api/request-outbox.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { prepareCreateSession } from ${JSON.stringify(moduleUrl)};
      prepareCreateSession({ budget_usd: 33, config: {} }).abandon();
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        NYX_STATE_DIR: directory,
        NYX_API_URL: "http://127.0.0.1:1",
        NYX_TOKEN: "local-test-token",
        NYX_ACCOUNT_ID: "local-test-account",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const outbox = join(directory, "outbox");
    const [journal] = filesUnder(outbox);
    const legacy = JSON.parse(readFileSync(journal, "utf8"));
    legacy.version = 3;
    delete legacy.session_id;
    writeFileSync(journal, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const [scopeName] = readdirSync(outbox);
    const flat = join(outbox, scopeName, basename(journal));
    renameSync(journal, flat);

    const recovered = prepareCreateSession({ budget_usd: 33, config: {} });
    assert.equal(recovered.body.request_id, legacy.identity);
    assert.equal(existsSync(flat), false);
    const [migrated] = filesUnder(outbox).filter((file) => file.endsWith(".json"));
    assert.match(migrated, /requests-v4\/operations\/create-session\/[a-f0-9]{64}\//);
    assert.equal(JSON.parse(readFileSync(migrated, "utf8")).version, 4);
    recovered.acknowledge();
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("crash-duplicate migration preserves the highest admitted attempt", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-duplicate-merge-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const moduleUrl = new URL("../dist/api/request-outbox.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { prepareCreateSession } from ${JSON.stringify(moduleUrl)};
      prepareCreateSession({ budget_usd: 34, config: {} }).abandon();
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        NYX_STATE_DIR: directory,
        NYX_API_URL: "http://127.0.0.1:1",
        NYX_TOKEN: "local-test-token",
        NYX_ACCOUNT_ID: "local-test-account",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const outbox = join(directory, "outbox");
    const [destination] = filesUnder(outbox);
    const destinationRecord = JSON.parse(readFileSync(destination, "utf8"));
    assert.equal(destinationRecord.attempts, 0);
    const [scopeName] = readdirSync(outbox);
    const source = join(outbox, scopeName, basename(destination));
    writeFileSync(source, `${JSON.stringify({
      ...destinationRecord,
      attempts: 3,
      updated_at: new Date(Date.now() + 1_000).toISOString(),
    })}\n`, { mode: 0o600 });

    const recovered = prepareCreateSession({ budget_usd: 34, config: {} });
    assert.equal(existsSync(source), false);
    const [mergedFile] = filesUnder(outbox).filter((file) => file.endsWith(".json"));
    assert.equal(JSON.parse(readFileSync(mergedFile, "utf8")).attempts, 3,
      "migration must never replace an admitted receipt with an attempts=0 copy");
    assert.equal(recovered.beginAttempt(), 4);
    recovered.acknowledge();
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("migration never coalesces an explicit identity across operation or session scope", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-scope-merge-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const moduleUrl = new URL("../dist/api/request-outbox.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { prepareMessage } from ${JSON.stringify(moduleUrl)};
      prepareMessage("session-a", { text: "same", agent_path: "/root" }, null, "shared-id").abandon();
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        NYX_STATE_DIR: directory,
        NYX_API_URL: "http://127.0.0.1:1",
        NYX_TOKEN: "local-test-token",
        NYX_ACCOUNT_ID: "local-test-account",
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const outbox = join(directory, "outbox");
    const [destination] = filesUnder(outbox);
    const original = JSON.parse(readFileSync(destination, "utf8"));
    const [scopeName] = readdirSync(outbox);
    const source = join(outbox, scopeName, basename(destination));
    writeFileSync(source, `${JSON.stringify({
      ...original,
      operation_fingerprint: "b".repeat(64),
      session_id: "session-b",
      attempts: 2,
    })}\n`, { mode: 0o600 });

    const attached = prepareMessage(
      "session-a", { text: "same", agent_path: "/root" }, null, "shared-id",
    );
    const preserved = JSON.parse(readFileSync(destination, "utf8"));
    assert.equal(preserved.operation_fingerprint, original.operation_fingerprint);
    assert.equal(preserved.session_id, "session-a");
    assert.equal(existsSync(source), true,
      "scope-conflicting possible receipts must both remain for explicit reconciliation");
    attached.abandon();
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("empty operation shards are pruned after acknowledgement, rejection, and maintenance", async () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-shard-prune-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const outbox = join(directory, "outbox");
    const acknowledged = prepareCreateSession({ budget_usd: 35, config: {} });
    const acknowledgedFile = filesUnder(outbox).find((file) => file.endsWith(".json"));
    const acknowledgedShard = dirname(acknowledgedFile);
    acknowledged.acknowledge();
    assert.equal(existsSync(acknowledgedShard), false);

    const rejected = prepareCreateSession({ budget_usd: 36, config: {} });
    const rejectedFile = filesUnder(outbox).find((file) => file.endsWith(".json"));
    const rejectedShard = dirname(rejectedFile);
    assert.equal(rejected.rejectIfUnambiguous(rejected.beginAttempt()), true);
    assert.equal(existsSync(rejectedShard), false);

    const resolved = prepareCreateSession({ budget_usd: 37, config: {} });
    const resolvedFile = filesUnder(outbox).find((file) => file.endsWith(".json"));
    const resolvedShard = dirname(resolvedFile);
    resolved.beginAttempt();
    resolved.abandon();
    const report = await maintainRequestOutbox({ resolveReceipt: async () => "committed" });
    assert.equal(report.reclaimed, 1);
    assert.equal(existsSync(resolvedShard), false);
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("maintenance streams a bounded prefix and prunes empty shards without materializing the root", async () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-bounded-sweep-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const seed = prepareCreateSession({ budget_usd: 38, config: {} });
    seed.acknowledge();
    const outbox = join(directory, "outbox");
    const [scopeName] = readdirSync(outbox);
    const operations = join(outbox, scopeName, "requests-v4", "operations", "create-session");
    mkdirSync(operations, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      mkdirSync(join(operations, index.toString(16).padStart(64, "0")));
      mkdirSync(join(operations, `unrelated-${index}`));
    }

    let resolverCalls = 0;
    const report = await maintainRequestOutbox({
      limit: 1,
      resolveReceipt: async () => { resolverCalls += 1; return "unknown"; },
    });
    assert.equal(report.scanned, 0);
    assert.equal(resolverCalls, 0);
    assert.ok(report.enumerated <= 32, `enumerated ${report.enumerated} entries`);
    const remaining = readdirSync(operations);
    assert.ok(remaining.length >= 968,
      "one bounded sweep must not walk or materialize all 1,000 shard entries");
    assert.equal(remaining.filter((name) => name.startsWith("unrelated-")).length, 500,
      "entries outside the strict digest namespace are ignored, never deleted");
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("authenticated receipt maintenance reclaims only definitive outcomes", async () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-receipts-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const committed = prepareCreateSession({ budget_usd: 41, config: {} }, "committed-create");
    committed.beginAttempt();
    committed.abandon();
    const absent = prepareMessage(
      "terminal-session",
      { text: "resolved", agent_path: "/root" },
      null,
      "absent-message",
    );
    absent.beginAttempt();
    absent.abandon();
    const unknown = prepareMessage(
      "live-session",
      { text: "pending", agent_path: "/root" },
      null,
      "unknown-message",
    );
    unknown.beginAttempt();
    unknown.abandon();
    const transport = prepareCreateSession({ budget_usd: 42, config: {} }, "transport-create");
    transport.beginAttempt();
    transport.abandon();
    const legacy = prepareMessage(
      "legacy-session",
      { text: "legacy pending", agent_path: "/root" },
      null,
      "legacy-message",
    );
    legacy.beginAttempt();
    legacy.abandon();
    const legacyFile = filesUnder(join(directory, "outbox")).find((file) => {
      if (!file.endsWith(".json")) return false;
      return JSON.parse(readFileSync(file, "utf8")).identity === "legacy-message";
    });
    const legacyRecord = JSON.parse(readFileSync(legacyFile, "utf8"));
    legacyRecord.version = 3;
    delete legacyRecord.session_id;
    writeFileSync(legacyFile, `${JSON.stringify(legacyRecord)}\n`, { mode: 0o600 });

    const queries = [];
    const result = await maintainRequestOutbox({
      resolveReceipt: async (query) => {
        queries.push(query);
        if (query.identity === "committed-create") return "committed";
        if (query.identity === "absent-message") return "not_committed";
        if (query.identity === "transport-create") throw new TypeError("offline");
        return "unknown";
      },
    });
    assert.equal(result.reclaimed, 2);
    assert.equal(result.retained, 3);
    assert.deepEqual(
      queries.find((query) => query.identity === "absent-message"),
      { kind: "message", identity: "absent-message", sessionId: "terminal-session" },
    );
    const survivors = filesUnder(join(directory, "outbox"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(file, "utf8")).identity)
      .sort();
    assert.deepEqual(survivors, ["legacy-message", "transport-create", "unknown-message"]);
    assert.equal(queries.some((query) => query.identity === "legacy-message"), false,
      "a legacy message without session routing metadata must be retained, never guessed");
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("outbox maintenance is abortable and settles its lifecycle task", async () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-abort-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const pending = prepareCreateSession({ config: {} }, "abort-receipt");
    pending.beginAttempt();
    pending.abandon();
    const abort = new AbortController();
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    const task = maintainRequestOutbox({
      signal: abort.signal,
      resolveReceipt: async (_query, signal) => new Promise((_resolve, reject) => {
        began();
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    await started;
    abort.abort(new Error("detached"));
    const result = await task;
    assert.equal(result.retained, 1);
    assert.equal(filesUnder(join(directory, "outbox")).filter((file) => file.endsWith(".json")).length, 1);
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("account-bound principal survives JWT rotation but never crosses accounts", () => {
  const previous = {
    state: process.env.NYX_STATE_DIR,
    token: process.env.NYX_TOKEN,
    account: process.env.NYX_ACCOUNT_ID,
  };
  const directory = mkdtempSync(join(tmpdir(), "nyx-token-rotation-"));
  process.env.NYX_STATE_DIR = directory;
  process.env.NYX_ACCOUNT_ID = "account-a";
  process.env.NYX_TOKEN = fixtureJwt("user-1", "old");
  try {
    const first = prepareCreateSession({ config: {} }, "rotation-request");
    process.env.NYX_TOKEN = fixtureJwt("user-1", "new");
    const rotated = prepareCreateSession({ config: {} }, "rotation-request");
    assert.equal(rotated.body.request_id, first.body.request_id);
    assert.equal(filesUnder(join(directory, "outbox")).length, 1);

    process.env.NYX_ACCOUNT_ID = "account-b";
    const otherAccount = prepareCreateSession({ config: {} }, "rotation-request");
    assert.equal(filesUnder(join(directory, "outbox")).length, 2);
    otherAccount.acknowledge();
    process.env.NYX_ACCOUNT_ID = "account-a";
    rotated.acknowledge();
  } finally {
    if (previous.state === undefined) delete process.env.NYX_STATE_DIR;
    else process.env.NYX_STATE_DIR = previous.state;
    if (previous.token === undefined) delete process.env.NYX_TOKEN;
    else process.env.NYX_TOKEN = previous.token;
    if (previous.account === undefined) delete process.env.NYX_ACCOUNT_ID;
    else process.env.NYX_ACCOUNT_ID = previous.account;
  }
});

test("an old outbox lock is reclaimed even when its recorded PID is still alive", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-outbox-stale-live-pid-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      throw new TypeError("connection lost after possible commit");
    };
    await assert.rejects(createSession({ budget: 17 }), /Could not reach/);
    const [record] = filesUnder(join(directory, "outbox"));
    assert.ok(record);

    const lock = `${record}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    const abandoned = new Date(Date.now() - 31_000);
    utimesSync(lock, abandoned, abandoned);

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({ session_id: "reclaimed-session", status: "idle" }));
    };
    assert.equal((await createSession({ budget: 17 })).session_id, "reclaimed-session");
    assert.deepEqual(bodies[2], bodies[0], "reclaiming the lock must preserve the uncertain request identity");
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

async function run(args, baseUrl, input = "", localState = stateDirectory) {
  // A test never inherits a production API URL or real authentication token.
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const child = spawn(process.execPath, [cli.pathname, ...args], {
    env: { ...process.env, NYX_API_URL: baseUrl, NYX_TOKEN: "local-test-token", NYX_STATE_DIR: localState },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = await once(child, "exit");
  clearTimeout(timeout);
  return { code, stdout, stderr };
}

test("login callback is loopback-only and requires the flow nonce", async () => {
  const nonce = "callback_nonce_0123456789abcdef";
  const { port, tokenPromise, server } = await startCallbackServer(nonce);
  try {
    assert.equal(server.address().address, "127.0.0.1");
    const wrong = await fetch(`http://127.0.0.1:${port}/?token=attacker&n=wrong`);
    assert.equal(wrong.status, 403);
    const valid = await fetch(
      `http://127.0.0.1:${port}/?token=trusted-token&email=user%40example.com&n=${nonce}`,
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(await tokenPromise, {
      token: "trusted-token",
      email: "user@example.com",
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("nonce-valid OAuth denial rejects login immediately", async () => {
  const nonce = "denial_nonce_0123456789abcdef";
  const { port, tokenPromise, server } = await startCallbackServer(nonce);
  try {
    const callback = await fetch(
      `http://127.0.0.1:${port}/?error=denied&n=${nonce}`,
    );
    assert.equal(callback.status, 200);
    await assert.rejects(tokenPromise, /cancelled/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("credential replacement repairs legacy permissions and stays valid JSON", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyx-credential-save-"));
  const directory = join(home, ".nyx");
  const credentialFile = join(directory, "credentials.json");
  mkdirSync(directory, { mode: 0o755 });
  writeFileSync(credentialFile, '{"token":"legacy"}\n', { mode: 0o644 });
  const authModule = new URL("../dist/config/auth.js", import.meta.url).href;
  const script = [
    `const { saveCredentials } = await import(${JSON.stringify(authModule)});`,
    `saveCredentials({ token: "replacement", email: "user@example.com", user_id: "u1", account_id: "a1" });`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(credentialFile, "utf8")), {
    token: "replacement",
    email: "user@example.com",
    user_id: "u1",
    account_id: "a1",
  });
});

test("message transport retries an uncertain request with the same durable identity", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const failure of ["network", "500"]) {
      const bodies = [];
      globalThis.fetch = async (url, options) => {
        assert.match(String(url), /^http:\/\/127\.0\.0\.1:1\//);
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) {
          if (failure === "network") throw new TypeError("connection reset after commit");
          return new Response("{}", { status: 500 });
        }
        const body = bodies.at(-1);
        return new Response(JSON.stringify({ session_id: "s1", message_id: body.message_id,
          sequence: 1, completion_token: `input_${body.message_id}`, queued: true }), { status: 202 });
      };
      await submitMessage("s1", `hello-${failure}`, "/root", "turn-1", `stable-message-${failure}`);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0], bodies[1]);
      assert.equal(bodies[0].message_id, `stable-message-${failure}`);
      assert.equal(bodies[0].expected_turn_id, "turn-1");
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("ordinary controller prose recovers its generated message identity after restart", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-controller-message-restart-"));
  process.env.NYX_STATE_DIR = directory;
  const state = initialSessionState({ session_id: "controller-session", status: "idle" });
  const api = {
    listAgents: async () => [{ agent_path: "/root", status: "idle", active_turn_id: "turn-1" }],
    submitMessage,
    interruptAgent: async () => {},
    getSession: async () => state.session,
    listOperations: async () => [],
    reconcileOperation: async () => {},
    resumeRun: async () => { throw new Error("ordinary session must not resume a run"); },
  };
  try {
    globalThis.fetch = async () => { throw new TypeError("response lost after possible commit"); };
    const firstController = createSessionController({
      state: () => state,
      dispatch: () => {},
      detach: () => {},
      api,
    });
    await assert.rejects(firstController.send("inspect the owned target"), /Could not reach/);
    const [journal] = filesUnder(join(directory, "outbox"));
    const persisted = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(persisted.shared_identity, false,
      "ordinary TUI prose must use the recoverable generated-identity path");

    const delivered = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      delivered.push(body);
      return new Response(JSON.stringify({
        session_id: "controller-session",
        message_id: body.message_id,
        sequence: 3,
        completion_token: `input_${body.message_id}`,
        queued: true,
      }), { status: 202 });
    };
    // A new controller has no in-memory UUID. The journal, not UI state,
    // restores the exact unresolved request identity.
    const restartedController = createSessionController({
      state: () => state,
      dispatch: () => {},
      detach: () => {},
      api,
    });
    const accepted = await restartedController.send("inspect the owned target");
    assert.equal(accepted.message_id, persisted.identity);
    assert.equal(delivered[0].message_id, persisted.identity);
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("generated message recovery never crosses session boundaries", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-message-session-scope-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      throw new TypeError("uncertain");
    };
    await assert.rejects(submitMessage("session-a", "same prose", "/root", null), /Could not reach/);
    const firstIdentity = bodies[0].message_id;

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({
        session_id: "session-b", message_id: body.message_id, sequence: 1,
        completion_token: `input_${body.message_id}`, queued: true,
      }), { status: 202 });
    };
    const accepted = await submitMessage("session-b", "same prose", "/root", null);
    assert.notEqual(accepted.message_id, firstIdentity);
    assert.equal(filesUnder(join(directory, "outbox")).length, 1,
      "session A's uncertain identity remains isolated and recoverable");
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("an explicit message identity cannot be retargeted to another session", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-explicit-message-scope-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const first = prepareMessage(
      "session-a",
      { text: "identical prose", agent_path: "/root" },
      null,
      "explicit-message-id",
    );
    const [journal] = filesUnder(join(directory, "outbox"));
    const before = readFileSync(journal, "utf8");
    assert.throws(
      () => prepareMessage(
        "session-b",
        { text: "identical prose", agent_path: "/root" },
        null,
        "explicit-message-id",
      ),
      /outbox|unreadable/i,
    );
    assert.equal(readFileSync(journal, "utf8"), before,
      "a rejected retarget must not rewrite the original operation scope or owner claim");
    assert.equal(first.body.message_id, "explicit-message-id");
    first.acknowledge();
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a validated legacy explicit journal upgrades without losing recovery", () => {
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-legacy-explicit-upgrade-"));
  process.env.NYX_STATE_DIR = directory;
  try {
    const original = prepareMessage(
      "legacy-session",
      { text: "resume legacy", agent_path: "/root" },
      "original-turn",
      "legacy-explicit-id",
    );
    original.abandon();
    const [journal] = filesUnder(join(directory, "outbox"));
    const current = JSON.parse(readFileSync(journal, "utf8"));
    const legacy = {
      version: 2,
      kind: current.kind,
      fingerprint: current.fingerprint,
      identity: current.identity,
      body: current.body,
      attempts: current.attempts,
    };
    writeFileSync(journal, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const recovered = prepareMessage(
      "legacy-session",
      { text: "resume legacy", agent_path: "/root" },
      "newer-turn-is-not-used",
      "legacy-explicit-id",
    );
    assert.equal(recovered.body.message_id, "legacy-explicit-id");
    assert.equal(recovered.body.expected_turn_id, "original-turn");
    const upgraded = JSON.parse(readFileSync(journal, "utf8"));
    assert.equal(upgraded.version, 4);
    assert.equal(upgraded.shared_identity, true);
    assert.equal(typeof upgraded.operation_fingerprint, "string");
    recovered.acknowledge();
  } finally {
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a 4xx after an uncertain message dispatch retains the exact instruction", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-message-uncertain-4xx-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) throw new TypeError("lost response after commit");
      return new Response(JSON.stringify({ detail: "membership changed" }), { status: 409 });
    };
    await assert.rejects(
      submitMessage("session-one", "inspect target", "/root", null),
      /membership changed/,
    );
    assert.equal(filesUnder(join(directory, "outbox")).length, 1);
    const messageId = bodies[0].message_id;

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({
        session_id: "session-one", message_id: body.message_id,
        sequence: 2, completion_token: `input_${body.message_id}`, queued: true,
      }));
    };
    const accepted = await submitMessage("session-one", "inspect target", "/root", null);
    assert.equal(accepted.message_id, messageId);
    assert.ok(bodies.every((body) => body.message_id === messageId));
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a malformed message acknowledgement remains uncertain and cannot clear the outbox", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-message-ack-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "wrong-session", message_id: "wrong-message",
        sequence: 1, completion_token: "input-wrong", queued: true }), { status: 202 });
    };
    await assert.rejects(submitMessage("ack-session", "inspect", "/root", null),
      /invalid message acknowledgement/);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(filesUnder(join(directory, "outbox")).length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("an unacknowledged message is replayed exactly after restart and then removed", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-message-outbox-"));
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      throw new TypeError("connection lost after possible commit");
    };
    await assert.rejects(submitMessage("durable-session", "check --disable-security safely", "/root",
      "original-turn"), /Could not reach/);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);

    const pending = filesUnder(join(directory, "outbox"));
    assert.equal(pending.length, 1);
    assert.equal(statSync(pending[0]).mode & 0o777, 0o600);
    const persisted = JSON.parse(readFileSync(pending[0], "utf8"));
    assert.equal(persisted.identity, bodies[0].message_id);
    assert.equal(persisted.body.text, "check --disable-security safely");

    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ session_id: "durable-session", message_id: bodies[0].message_id,
        sequence: 4, completion_token: "input-4", queued: true }), { status: 202 });
    };
    // A fresh caller may observe a newer turn and allocate another UUID. The
    // pending write remains authoritative until its original fence is resolved.
    await submitMessage("durable-session", "check --disable-security safely", "/root", "newer-turn");
    assert.deepEqual(bodies[2], bodies[0]);
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("a stale turn is not retried and its rejected entry cannot wedge later prose", async () => {
  const previousFetch = globalThis.fetch;
  const previousState = process.env.NYX_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "nyx-message-rejected-"));
  let calls = 0;
  const bodies = [];
  process.env.NYX_STATE_DIR = directory;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ detail: "Selected turn ended" }), { status: 409 });
  };
  try {
    await assert.rejects(submitMessage("s1", "hello", "/root", "old-turn"), /Selected turn ended/);
    assert.equal(calls, 1);
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({ session_id: "s1", message_id: body.message_id,
        sequence: 2, completion_token: `input_${body.message_id}`, queued: true }), { status: 202 });
    };
    await submitMessage("s1", "hello", "/root", "new-turn");
    assert.equal(bodies[0].expected_turn_id, "new-turn");
    assert.deepEqual(filesUnder(join(directory, "outbox")), []);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.NYX_STATE_DIR = previousState;
  }
});

test("inactive stop transport preserves the state-generation precondition", async () => {
  const previousFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: "stop_queued" }));
  };
  try {
    await interruptAgent("s1", "/root/recon", null, 17);
    assert.deepEqual(body, {
      agent_path: "/root/recon",
      expected_turn_id: null,
      expected_state_sequence: 17,
    });
  } finally { globalThis.fetch = previousFetch; }
});

test("CLI presents the TUI entrypoint and authentication commands", async () => {
  const result = await run(["--help"], "http://127.0.0.1:1");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: nyx \[options\] \[command\]\n/);
  for (const command of ["login", "logout"]) {
    assert.match(result.stdout, new RegExp(`^\\s+${command}(?:\\s|$)`, "m"));
  }
  assert.doesNotMatch(result.stdout, /\[request|--once|--json|--budget|--target|--max-agents/);
  assert.doesNotMatch(result.stdout, /^\s+(?:chat|legacy|compat)(?:\s|$)/m);
});

test("CLI rejects command-line prompts and retired options before creating a session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nyx-unsupported-cli-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "Unsupported CLI input must not reach the API" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const args of [
      ["inspect", "the", "account"],
      ["--", "inspect the account"],
      ["chat"],
      ["legacy"],
      ["compat"],
      ["--once"],
      ["--json"],
      ["--budget", "5"],
      ["--target", "target-1"],
      ["--max-agents", "2"],
    ]) {
      const result = await run(args, base, "", directory);
      assert.notEqual(result.code, 0, `${args.join(" ")} unexpectedly succeeded`);
      assert.match(result.stderr, /unknown (?:command|option)|too many arguments/i,
        `${args.join(" ")}: ${result.stderr}`);
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(filesUnder(directory), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bare and piped non-TTY invocations require an interactive terminal before network access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nyx-non-tty-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "Non-TTY input must not reach the API" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const input of ["", "inspect the account\n"]) {
      const result = await run([], base, input, directory);
      assert.notEqual(result.code, 0, "a non-TTY invocation unexpectedly succeeded");
      assert.match(result.stderr, /interactive terminal/i);
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(filesUnder(directory), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
