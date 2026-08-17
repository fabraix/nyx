import chalk from "chalk";
import type { NyxConfig } from "../config/schema.js";
import type { BudgetTier, RunCreated } from "../api/types.js";
import { version } from "../version.js";
import { TRACE_ID } from "../utils/session.js";

export function renderHeader(
  config: NyxConfig,
  run: RunCreated,
  mode: BudgetTier
): void {
  console.log("");
  console.log(chalk.bold(`  nyx v${version} — AI Agent Security Audit`));
  console.log("");
  console.log(`  Target:    ${config.name}`);
  console.log(`  Objective: ${truncate(config.objective, 60)}`);
  console.log(`  Mode:      ${mode}`);
  console.log(`  Run ID:    ${run.run_id}`);
  console.log(`  Trace ID:  ${TRACE_ID}`);
  console.log("");
  console.log(chalk.dim("  " + "─".repeat(45)));
  console.log("");
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 3) + "..." : oneLine;
}
