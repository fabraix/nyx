# Nyx

Nyx is a long-running adversarial agent that autonomously explores the attack surface of AI systems. Point it at a target, set a budget, and Nyx will methodically probe for real-world vulnerabilities - adapting its strategy as it learns how the system behaves.

## How It Works

Nyx operates as one durable agent runtime against your target over an extended session. Its root agent can create generic child agents when parallel investigation or an independent review is useful. Unlike scanners that run a fixed set of checks, Nyx explores - it probes, observes how the system responds, adapts its approach, and follows leads deeper. Each interaction informs the next.

Long-running adversarial sessions generate a lot of state - past attempts, observed behaviors, failed strategies, partial leads. Nyx keeps the exact durable transcript and uses bounded projections plus semantic compaction for the model's working context. Stable references let the agent reopen exact transcript, source, workspace, and artifact pages instead of losing them to UI or prompt clipping.

Describe the outcome you want. Nyx can use the account and workspace tools made
available to its durable runtime to inspect existing context, select an existing
target and policy, create an assessment, write a harness, and follow the work
through.

## Install

```bash
npm install -g @fabraix/nyx
```

## Quick Start

```bash
# Authenticate
nyx login

# Start the durable terminal
nyx
```

Inside the terminal, describe what you want Nyx to do. For example:

```text
Check the account for existing PostHog targets and start an assessment
```

## Authentication

Get a token by signing up at [app.fabraix.com/signup](https://app.fabraix.com/signup).

```bash
# Interactive browser-based login
nyx login

# Verify current auth
nyx login --check

# Logout
nyx logout

# Alternatively, supply an account-bound token
export NYX_TOKEN=nyx_...
export NYX_ACCOUNT_ID=acct_...

# Optional for opaque rotating tokens: a stable, non-secret local principal ID
export NYX_PRINCIPAL_ID=operator-terminal
```

Auth resolution order: `NYX_TOKEN` env var → `~/.nyx/credentials.json` → error.
Browser login stores the server-validated user and account with the credential.
The browser flow binds its loopback callback to `127.0.0.1`, requires a
cryptographically random one-time nonce, and consumes a hashed OAuth state from
the shared database so a callback can land on any API replica exactly once.
Provider errors are returned to the waiting CLI instead of leaving it parked
until timeout. The credential directory is owner-only (`0700`) and the
credential file is durably replaced with owner-only permissions (`0600`);
logout durably removes it.
When `NYX_TOKEN` is supplied directly, `NYX_ACCOUNT_ID` is required by the
session API and is asserted on every request for server-side validation.
`NYX_PRINCIPAL_ID` affects only the local outbox namespace; it is useful when an
opaque token rotates and has no stable user claim, and never grants account
authority by itself.

## Using the terminal

Run `nyx` to open the durable TUI, then type requests in its input area:

```text
Check your memory for the target setup
Inspect account-level target and run history before starting new work
Create an assessment for the saved PostHog target
Write the reconstructed client in the managed workspace and show me the artifact
Inspect the desktop source, build a harness, and test it
```

Nyx chooses the appropriate account, assessment, memory, and workspace tools
exposed by the service and can explain or ask for missing authority. Files are written in
the agent's managed workspace and can be referenced or read back by their
workspace-relative path; the CLI does not grant the remote runtime implicit
access to arbitrary files on the operator's machine.

Conversational sessions can list credential-free target and policy summaries,
inspect a policy, list or inspect assessment progress, continue an existing
assessment, cancel queued or running work, and start one from an existing
authorized target and policy. Every read is scoped to the authenticated account
and user. Assessment detail includes
cursor-paged activity from the existing customer-safe session projection, so the
conversation can read the configured agents' replies without exposing raw target
transcripts or provider receipts. Continuing can queue an operation-bound,
idempotent instruction to an exact agent or answer an exact pending question,
then ensures a supervisor is active; omitting the instruction only resumes the
checkpoint and does not create a synthetic paid turn. One question has one
durable answer identity: an identical retry converges, while a competing answer
is rejected as an ordinary conflict without pausing the assessment for
reconciliation. Cancellation converges on the durable status. Cancellation and
authoritative preflight failure atomically close the run's mailbox boundary:
unread accepted inputs receive a causal `not_applied` terminal receipt, and an
input already consumed by a live turn is interrupted with its own terminal
receipt.

Assessment creation uses a durable operation-derived identity. A retry can reuse
only the same complete normalized persisted submission, including the resolved
target/source/credential binding, policy, budget and hints. A target edit or
default/configuration drift therefore fails closed instead of silently changing
an already identified launch. An ambiguous dispatcher acknowledgement leaves the
durable queued run available for a single-flight recovery claim instead of
failing it or launching duplicate supervisors. Mutating account tools bind the
authenticated message actor to the sampled tool intent and recheck current
account membership at effect time.

When enabled, managed-workspace tools compose with these account tools in the
same ordinary conversation, so Nyx can inspect account state, select or follow an
assessment, and create its harness or other artifacts without a separate mode.
Configured assessment sessions do not receive the account-control tools, which
prevents recursive assessment creation. Workspace file paths are relative to the
managed remote guest. Absolute paths, traversal and existing symlink escapes are
rejected. When workspace capability is
disabled, Nyx receives no file or shell tools and does not fall back to the CLI's
working directory or any other operator-host path.

The transcript, tool activity, questions, and results all use the same durable
session stream. There is no separate chat mode or run mode.

## Terminal controls

The terminal supports normal messages and steering while agents work.
Conversation and configured assessments use one server runtime; there is no
client-selectable execution mode.

Use `/agents`, `/use /root/child`, `/interrupt [agent]`, `/memory [query]`,
`/questions`, `/answer <request> <text>`, `/approve <request>`, `/artifacts`, and
`/findings` as shortcuts. `/status` shows budget and session status. `/help` lists all
commands. Page Up/Down browses the loaded transcript; Escape closes a detail view.
`/quit` and Ctrl-C detach without cancelling the server's agents.
`/interrupt` interrupts the exact active turn shown in the roster, or stops the
exact inactive state generation of a child. If that child starts or completes a
newer turn concurrently, the request is rejected instead of cancelling newer work.

An admin can inspect unknown effects with `/reconcile` and submit an explicit,
evidence-backed resolution using `/reconcile <operation-id> <resolution.json>`.
The existing API enforces account and admin authorization.

After an answer, approval, or reconciliation is durably recorded, configured-run
recovery continues as one cancellable background task per run. Its bounded
lease-handoff backoff never blocks `/status`, `/interrupt`, or later terminal
commands; detaching cancels and drains only that local recovery task.

`/approve` is a shorthand answer to a specific durable question. It does not
grant network, publication, finding, or reconciliation authority; those actions
remain behind their typed authenticated server APIs.

Transient read failures reconnect from the last observed sequence cursor. Before
a create-session or message request is dispatched, the CLI writes a small
account-principal/server-scoped outbox entry under `~/.nyx/sessions` (or
`NYX_STATE_DIR`). It contains the exact unresolved body and idempotency identity,
not the token; its keyed filename contains neither the prompt nor token. This
preserves the request identity when the transport outcome is uncertain.
Directories are mode `0700` and files are mode `0600`.

Each ordinary session launch receives its own random identity, including when
two concurrent launches have identical options. Only a caller-supplied request
identity opts into sharing. After a process exits, a later invocation can claim
and deliver its exact unresolved random-identity record. Local cleanup removes
only stale temporary inodes and old records whose dispatch count is still zero;
an attempted request is never age-deleted because its server effect may be
uncertain.

Transport entries retire after a validated acknowledgement.
A synchronous 4xx may retire an entry only when this process proves it was the
sole first admitted dispatch and therefore had no effect; after a restart,
concurrent caller or retry, even a 4xx cannot erase the unresolved identity.
Ambiguous transport/server failures always retain it. Acknowledged transcript
data stays on the server; the running TUI tracks its read cursor in memory and
keeps a bounded recent projection. Pending input identities, the durable cursor,
and the latest assessment verdict remain explicit even as older render items and
settled terminal receipts roll out of that projection. The latest verdict is
pinned as status outside chronological scrollback rather than being reinserted
as an old transcript item after eviction.
Authentication and authorization errors from
the authoritative session or item reads still surface immediately.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NYX_TOKEN` | Auth token (overrides stored credentials) |
| `NYX_ACCOUNT_ID` | Expected account for an env-provided token; required by session requests and checked by the server |
| `NYX_PRINCIPAL_ID` | Optional stable, non-secret local outbox principal for opaque rotating tokens; not authorization |
| `NYX_API_URL` | API base URL (default: `https://api.fabraix.com`) |
| `NYX_STATE_DIR` | Optional local outbox directory (default: `~/.nyx/sessions`) |

## License

Apache 2.0 — see [LICENSE](./LICENSE).
