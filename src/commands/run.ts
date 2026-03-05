import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { apiRequest } from "../api/client.js";
import { connectStream } from "../api/stream.js";
import { renderHeader, createStreamRenderer } from "../ui/renderer.js";
import { writeReport } from "../ui/report-writer.js";
import { handleError } from "../utils/errors.js";
import type { RunCreated, RunSubmission } from "../api/types.js";

export function registerRun(program: Command): void {
  program
    .command("run <config>")
    .description("Run a security audit")
    .option("--budget <n>", "Max spend in USD", parseFloat)
    .option("--goal <level>", "AIVSS goal: low|medium|high|critical")
    .option("--output <dir>", "Report output directory", ".")
    .option("--no-stream", "Submit and exit without streaming")
    .option("--verbose", "Show full transcripts")
    .action(async (configArg: string, opts) => {
      try {
        const { config, configName } = loadConfig(configArg);

        const budget = opts.budget ?? config.budget;
        const goal = opts.goal ?? config.goal;

        const submission: RunSubmission = {
          config_name: configName,
          name: config.name,
          target: config.target,
          objective: config.objective,
          budget_usd: budget,
          severity_target: goal,
          hints: config.hints,
          model: config.model,
        };

        const run = await apiRequest<RunCreated>(
          "POST",
          "/v1/nyx/runs",
          submission
        );

        if (!opts.stream) {
          console.log(`\n  Run submitted: ${run.run_id}`);
          console.log(`  Check status:  nyx status ${configName}\n`);
          return;
        }

        renderHeader(config, run, budget);
        const result = await connectStream(
          run.stream_url,
          createStreamRenderer({
            verbose: opts.verbose,
            runId: run.run_id,
          })
        );

        if (result.reportUrl) {
          await writeReport(run.run_id, configName, opts.output);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
