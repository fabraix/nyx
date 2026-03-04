import { Command } from "commander";
import chalk from "chalk";
import { apiRequest } from "../api/client.js";
import { handleError } from "../utils/errors.js";
import { resolveConfigName } from "../utils/config-name.js";
import type { RunStatus } from "../api/types.js";

export function registerStatus(program: Command): void {
  program
    .command("status <config>")
    .description("Check status of a run")
    .action(async (configArg: string) => {
      try {
        const name = resolveConfigName(configArg);
        const run = await apiRequest<RunStatus>(
          "GET",
          `/v1/nyx/runs/by-config/${encodeURIComponent(name)}`
        );

        console.log("");
        console.log(`  Config:    ${run.config_name}`);
        console.log(`  Run ID:    ${run.run_id}`);
        console.log(`  Target:    ${run.name}`);
        console.log(`  Status:    ${formatStatus(run)}`);
        console.log(`  Started:   ${timeAgo(run.created_at)}`);
        console.log(`  Findings:  ${run.findings_count} saved`);
        console.log("");
      } catch (err) {
        handleError(err);
      }
    });
}

function formatStatus(run: RunStatus): string {
  if (run.status === "running") {
    return `Running (attempt ${run.attempts_completed + 1}, $${run.spent_usd.toFixed(2)} / $${run.budget_usd.toFixed(2)} spent)`;
  }
  if (run.status === "queued") {
    return chalk.dim("Queued");
  }
  if (run.status === "completed" && run.result === "success") {
    return chalk.green("Completed — vulnerability found");
  }
  if (run.status === "completed" && run.result === "exhausted") {
    return chalk.yellow("Completed — budget exhausted");
  }
  if (run.status === "failed") {
    return chalk.red("Failed");
  }
  if (run.status === "cancelled") {
    return chalk.dim("Cancelled");
  }
  return run.status;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
