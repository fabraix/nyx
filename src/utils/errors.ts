import chalk from "chalk";

export type ErrorCategory = "auth" | "config" | "api" | "network" | "file" | "unknown";

export class NyxError extends Error {
  constructor(
    message: string,
    public readonly category: ErrorCategory,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "NyxError";
  }
}

const EXIT_CODES: Record<ErrorCategory, number> = {
  auth: 1,
  config: 2,
  api: 3,
  network: 4,
  file: 5,
  unknown: 99,
};

export function handleError(err: unknown): never {
  if (err instanceof NyxError) {
    console.error(chalk.red(`\n  Error: ${err.message}\n`));
    process.exit(EXIT_CODES[err.category]);
  }

  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`\n  Unexpected error: ${msg}\n`));
  process.exit(99);
}
