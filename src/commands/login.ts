import { Command } from "commander";
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
  console.log(chalk.green("\n  Authenticated"));
  console.log(`  Email:   ${data.email}`);
  console.log(`  User:    ${data.username}\n`);
}

async function interactiveLogin(): Promise<void> {
  const { port, tokenPromise, server } = startCallbackServer();

  const loginUrl = `https://app.fabraix.com/auth/cli?port=${port}`;
  console.log(chalk.dim(`\n  Opening browser to: ${loginUrl}`));
  console.log(chalk.dim("  Waiting for authentication...\n"));

  await open(loginUrl);

  let token: string;
  let email: string | undefined;
  try {
    const result = await tokenPromise;
    token = result.token;
    email = result.email;
  } finally {
    server.close();
  }

  saveCredentials({
    token,
    email,
  });

  console.log(chalk.green("  Logged in successfully!"));
  if (email) {
    console.log(`  Email: ${email}\n`);
  }
}

function startCallbackServer(): {
  port: number;
  tokenPromise: Promise<{ token: string; email?: string }>;
  server: ReturnType<typeof createServer>;
} {
  let resolveToken!: (result: { token: string; email?: string }) => void;
  let rejectToken!: (err: Error) => void;
  const tokenPromise = new Promise<{ token: string; email?: string }>(
    (resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    }
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);
    const token = url.searchParams.get("token");
    const email = url.searchParams.get("email") ?? undefined;

    if (token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackPage("success", email));
      resolveToken({ token, email });
    } else {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(callbackPage("error"));
    }
  });

  server.on("error", (err) => {
    rejectToken(
      new NyxError(`Failed to start login server: ${err.message}`, "network")
    );
  });

  server.listen(0);
  const port = (server.address() as { port: number }).port;

  const timeout = setTimeout(() => {
    rejectToken(new NyxError("Login timed out. Please try again.", "auth"));
    server.close();
  }, 120_000);

  tokenPromise.finally(() => clearTimeout(timeout));

  return { port, tokenPromise, server };
}
