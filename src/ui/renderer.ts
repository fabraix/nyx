import chalk from "chalk";
import type { NyxConfig } from "../config/schema.js";
import type { RunCreated } from "../api/types.js";
import { version } from "../version.js";

export function renderHeader(
  config: NyxConfig,
  run: RunCreated,
  budget: number
): void {
  console.log("");
  console.log(chalk.bold(`  nyx v${version} — AI Agent Security Audit`));
  console.log("");
  console.log(`  Target:    ${config.name}`);
  console.log(`  Objective: ${truncate(config.objective, 60)}`);
  console.log(`  Budget:    $${budget.toFixed(2)}`);
  console.log(`  Run ID:    ${run.run_id}`);
  console.log("");
  console.log(chalk.dim("  " + "─".repeat(45)));
  console.log("");
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 3) + "..." : oneLine;
}
