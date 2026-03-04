import { Command } from "commander";
import chalk from "chalk";
import { apiRequest } from "../api/client.js";
import { handleError } from "../utils/errors.js";
import { resolveConfigName } from "../utils/config-name.js";
import type { RunStatus } from "../api/types.js";

export function registerCancel(program: Command): void {
  program
    .command("cancel <config>")
    .description("Cancel a running audit")
    .action(async (configArg: string) => {
      try {
        const name = resolveConfigName(configArg);

        const run = await apiRequest<RunStatus>(
          "GET",
          `/v1/nyx/runs/by-config/${encodeURIComponent(name)}`
        );

        if (run.status !== "running" && run.status !== "queued") {
          console.log(
            chalk.dim(`\n  No active run for "${name}" (status: ${run.status}).\n`)
          );
          return;
        }

        const result = await apiRequest<{ run_id: string; status: string }>(
          "POST",
          `/v1/nyx/runs/${run.run_id}/cancel`
        );

        console.log(chalk.yellow(`\n  Cancelled run ${result.run_id} for "${name}".\n`));
      } catch (err) {
        handleError(err);
      }
    });
}
