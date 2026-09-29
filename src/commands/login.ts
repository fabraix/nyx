import { Command } from "commander";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { terminalField } from "../utils/terminal.js";
import { createServer } from "node:http";
import open from "open";
import chalk from "chalk";
import { getToken, saveCredentials } from "../config/auth.js";
import { getBaseUrl } from "../api/client.js";
import { NyxError, handleError } from "../utils/errors.js";
import type { TokenValidationResponse } from "../api/types.js";
import { callbackPage } from "../ui/callback-page.js";

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate with Fabraix")
    .option("--check", "Verify current authentication")
    .action(async (opts) => {
      try {
        if (opts.check) {
          await checkAuth();
        } else {
          await interactiveLogin();
        }
      } catch (err) {
        handleError(err);
      }
    });
}

async function checkAuth(): Promise<void> {
  const token = getToken();
  if (!token) {
    throw new NyxError(
      "Not authenticated. Run `nyx login` or set NYX_TOKEN.",
      "auth"
    );
  }

  const baseUrl = getBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/verify/token-validation`, {
      method: "GET",
      headers: { "X-Verification-Token": token },
    });
  } catch {
    throw new NyxError(
      `Network error: could not reach ${baseUrl}. Check your internet connection.`,
      "network"
    );
  }

  if (!res.ok) {
    throw new NyxError(
      "Authentication failed. Your token may have expired. Run `nyx login`.",
      "auth"
    );
  }

  const data = (await res.json()) as TokenValidationResponse;
  if (!data.accountId) throw new NyxError("Your user has no Nyx account membership.", "auth");
  if (!process.env.NYX_TOKEN) {
    saveCredentials({ token, email: data.email, user_id: data.userId, account_id: data.accountId });
  }
  console.log(chalk.green("\n  Authenticated"));
  console.log(`  Email:   ${terminalField(data.email)}`);
  console.log(`  User:    ${terminalField(data.userId)}\n`);
}

async function interactiveLogin(): Promise<void> {
  const nonce = randomBytes(32).toString("base64url");
  const { port, tokenPromise, server } = await startCallbackServer(nonce);

  const loginUrl = new URL("https://app.fabraix.com/auth/cli");
  loginUrl.searchParams.set("port", String(port));
  loginUrl.searchParams.set("n", nonce);
  console.log(chalk.dim(`\n  Opening browser to: ${terminalField(loginUrl.toString())}`));
  console.log(chalk.dim("  Waiting for authentication...\n"));

  await open(loginUrl.toString());

  let token: string;
  let email: string | undefined;
  try {
    const result = await tokenPromise;
    token = result.token;
    email = result.email;
  } finally {
    server.close();
  }

  const baseUrl = getBaseUrl();
  let validation: Response;
  try {
    validation = await fetch(`${baseUrl}/v1/verify/token-validation`, {
      method: "GET",
      headers: { "X-Verification-Token": token },
    });
  } catch {
    throw new NyxError(`Network error: could not verify authentication with ${baseUrl}.`, "network");
  }
  if (!validation.ok) throw new NyxError("Authentication failed. Please try again.", "auth");
  const identity = (await validation.json()) as TokenValidationResponse;
  if (!identity.userId || !identity.email || !identity.accountId) {
    throw new NyxError("Authentication server returned an invalid identity.", "auth");
  }
  saveCredentials({
    token,
    email: identity.email ?? email,
    user_id: identity.userId,
    account_id: identity.accountId,
  });

  console.log(chalk.green("  Logged in successfully!"));
  console.log(`  Email: ${terminalField(identity.email ?? email ?? "")}\n`);
}

export async function startCallbackServer(nonce: string): Promise<{
  port: number;
  tokenPromise: Promise<{ token: string; email?: string }>;
  server: ReturnType<typeof createServer>;
}> {
  if (!nonce || nonce.length > 256) {
    throw new NyxError("Invalid login callback nonce.", "auth");
  }
  let resolveToken!: (result: { token: string; email?: string }) => void;
  let rejectToken!: (err: Error) => void;
  const tokenPromise = new Promise<{ token: string; email?: string }>(
    (resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    }
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    const email = url.searchParams.get("email") ?? undefined;
    const authenticationError = url.searchParams.get("error");
    const returnedNonce = url.searchParams.get("n");
    const expected = Buffer.from(nonce);
    const received = Buffer.from(returnedNonce ?? "");

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    if (req.method !== "GET" || url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(callbackPage("error"));
      return;
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      // A stray local/LAN request must not resolve or reject the real flow.
      // Keep waiting for the browser carrying the unguessable nonce.
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end(callbackPage("error"));
      return;
    }

    if (authenticationError) {
      const messages: Record<string, string> = {
        denied: "Google sign-in was cancelled.",
        no_account: "No Fabraix account was found for that identity.",
        invalid_state: "The authentication state expired or was already used.",
        token_exchange: "Google rejected the authentication exchange.",
        user_info: "Google did not return a usable identity.",
      };
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackPage("error"));
      rejectToken(new NyxError(
        messages[authenticationError] ?? "Authentication failed. Please try again.",
        "auth",
      ));
      return;
    }

    if (token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackPage("success", email));
      resolveToken({ token, email });
    } else {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(callbackPage("error"));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(
      new NyxError(`Failed to start login server: ${error.message}`, "network"),
    );
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });

  server.on("error", (err) => {
    rejectToken(
      new NyxError(`Failed to start login server: ${err.message}`, "network")
    );
  });

  const port = (server.address() as { port: number }).port;

  const timeout = setTimeout(() => {
    rejectToken(new NyxError("Login timed out. Please try again.", "auth"));
    server.close();
  }, 120_000);

  void tokenPromise.then(
    () => clearTimeout(timeout),
    () => clearTimeout(timeout),
  );

  return { port, tokenPromise, server };
}
