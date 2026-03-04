import { Command } from "commander";
import chalk from "chalk";
import { apiRequest } from "../api/client.js";
import { handleError } from "../utils/errors.js";
import type { RunList } from "../api/types.js";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("List recent runs")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Number of runs", "10")
    .action(async (opts) => {
      try {
        const params = new URLSearchParams();
        if (opts.status) params.set("status", opts.status);
        params.set("limit", opts.limit);

        const data = await apiRequest<RunList>(
          "GET",
          `/v1/nyx/runs?${params.toString()}`
        );

        if (data.runs.length === 0) {
          console.log(chalk.dim("\n  No runs found.\n"));
          return;
        }

        console.log("");
        for (const run of data.runs) {
          const status =
            run.status === "running"
              ? chalk.cyan("running")
              : run.result === "success"
                ? chalk.green("success")
                : run.result === "exhausted"
                  ? chalk.yellow("exhausted")
                  : chalk.dim(run.status);

          console.log(
            `  ${chalk.bold(run.config_name.padEnd(20))} ${status.padEnd(20)} ` +
              `$${run.spent_usd.toFixed(2)}/$${run.budget_usd.toFixed(2)}  ${run.run_id}`
          );
        }
        console.log(
          chalk.dim(`\n  Showing ${data.runs.length} of ${data.total}\n`)
        );
      } catch (err) {
        handleError(err);
      }
    });
}
