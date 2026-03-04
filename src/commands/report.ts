import { Command } from "commander";
import { apiRequest } from "../api/client.js";
import { writeReport } from "../ui/report-writer.js";
import { handleError } from "../utils/errors.js";
import { resolveConfigName } from "../utils/config-name.js";
import type { RunStatus } from "../api/types.js";

export function registerReport(program: Command): void {
  program
    .command("report <config>")
    .description("Download audit report")
    .option("--output <dir>", "Output directory", ".")
    .action(async (configArg: string, opts) => {
      try {
        const configName = resolveConfigName(configArg);
        const run = await apiRequest<RunStatus>(
          "GET",
          `/v1/nyx/runs/by-config/${encodeURIComponent(configName)}`
        );

        const path = await writeReport(run.run_id, configName, opts.output);
        console.log(`\n  Report written to: ${path}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}
