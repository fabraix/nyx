# Nyx

Nyx is a long-running adversarial agent that autonomously explores the attack surface of AI systems. Point it at a target and Nyx will methodically probe for real-world vulnerabilities - adapting its strategy as it learns how the system behaves.

This package is the Nyx command-line client. It opens an interactive terminal where you tell Nyx what you want done and check on the work.

## How It Works

Nyx works against your target over an extended session. Unlike scanners that run a fixed set of checks, Nyx explores - it probes, observes how the system responds, adapts its approach, and follows leads deeper. Each interaction informs the next.

Long-running adversarial sessions generate a lot of state - past attempts, observed behaviors, failed strategies, partial leads. Nyx keeps track of what it has tried and learned, so it can pursue multi-step attack chains that surface-level tools never reach.

You describe the outcome you want in plain language. Nyx works with the targets and policies already set up in your account: it can start an assessment and tell you how it is going when you ask.

## Install

```bash
npm install -g @fabraix/nyx
```

Requires Node.js 18 or newer.

## Quick Start

You need a Fabraix account with at least one target and one policy that has an objective. Create them in the web app at [app.fabraix.com](https://app.fabraix.com); the terminal works with what is there and cannot create them.

```bash
# Authenticate
nyx login

# Open the interactive terminal
nyx
```

Inside the terminal, describe what you want Nyx to do. For example:

```text
List my targets and policies, then start an assessment
```

## Authentication

The CLI uses the same account as the web app. If you do not have one, sign up at [app.fabraix.com/signup](https://app.fabraix.com/signup).

```bash
# Interactive browser-based login
nyx login

# Verify current auth
nyx login --check

# Logout
nyx logout
```

`nyx login` opens your browser, signs you in with Google, and stores the resulting credential in `~/.nyx/credentials.json`, readable only by your user. `nyx logout` deletes it. Single sign-on is not available in the CLI.

On a machine without a browser, set both of these instead, using the `token` and `account_id` values that `nyx login` wrote to `~/.nyx/credentials.json` on another machine:

```bash
export NYX_TOKEN=...
export NYX_ACCOUNT_ID=...
```

The token expires; log in again to get a new one.

Auth resolution order: `NYX_TOKEN` env var → `~/.nyx/credentials.json` → error. When `NYX_TOKEN` is set, `NYX_ACCOUNT_ID` is required to open the terminal.

## Using the terminal

Run `nyx` in an interactive terminal, then type requests in its input area:

```text
List the targets and policies in this account
Start an assessment of my staging target
How is the current assessment going?
Cancel the running assessment
```

You can ask Nyx to list your targets and policies, start an assessment of an existing target under an existing policy, check on an assessment, and continue or cancel one. Nyx does not report progress unprompted, so ask when you want an update. An assessment's findings appear in the web app. You can keep typing while Nyx is working, to add context or redirect it.

When Nyx needs something from you it asks a question. Each question is shown with an identifier; reply with `/answer <request> <text>`, using that identifier as `<request>`.

The CLI sends what you type and shows what comes back. It does not give Nyx access to files on your machine.

## Terminal commands

| Command | What it does |
|---------|--------------|
| `/help` | List the available commands |
| `/status` | Show the session's details |
| `/agents` | List the agents working in this session |
| `/use <agent>` | Send your next messages to that agent |
| `/interrupt [agent]` | Stop what an agent in this terminal is doing right now; defaults to the selected agent |
| `/memory [query]` | Ask the selected agent what it remembers, optionally about a topic |
| `/questions` | List the questions waiting for your answer |
| `/answer <request> <text>` | Answer a pending question |
| `/approve <request>` | Answer a pending question with "Approved." |
| `/artifacts` | Show any artifact items in the loaded transcript |
| `/findings` | Show any finding items in the loaded transcript |
| `/transcript` | Return to the conversation |
| `/quit` | Leave the terminal |

Nyx may run several agents in one session. `/agents` lists them and `/use` chooses which one your messages go to; until you choose, they go to the main agent. The header shows the selected agent, the session status and the session's spend so far.

Page Up and Page Down scroll the transcript, the Up and Down arrows recall earlier input, and Escape closes a detail view.

`/quit` and Ctrl-C close the terminal and cancel nothing. An assessment that has started keeps running until you ask Nyx to cancel it; `/interrupt` does not stop it. Each `nyx` launch opens a new session and cannot return to an earlier conversation, but you can ask about your assessments from any session.

If the connection drops, the terminal reconnects and carries on from where it left off.

## Local files

| Path | Contents |
|------|----------|
| `~/.nyx/credentials.json` | Your stored login. Written by `nyx login`, removed by `nyx logout`. |
| `~/.nyx/sessions/` | Requests the server has not confirmed yet, including the text you typed, kept so that a request retried after a dropped connection is not delivered twice. Never contains your token. |

Both are readable only by your user. Set `NYX_STATE_DIR` to keep the second one somewhere else.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NYX_TOKEN` | Auth token (overrides stored credentials) |
| `NYX_ACCOUNT_ID` | Account to use. Required to open the terminal whenever `NYX_TOKEN` is set; otherwise overrides the account saved by `nyx login` |
| `NYX_PRINCIPAL_ID` | Optional label that keeps local request state under one name when `NYX_TOKEN` is replaced. Used only together with `NYX_ACCOUNT_ID`; never sent to the server |
| `NYX_API_URL` | API base URL (default: `https://api.fabraix.com`) |
| `NYX_STATE_DIR` | Directory for unconfirmed requests (default: `~/.nyx/sessions`) |

## License

Apache 2.0 — see [LICENSE](./LICENSE).
