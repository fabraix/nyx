import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { apiRequest } from "../api/client.js";
import { renderHeader } from "../ui/renderer.js";
import { writeReport } from "../ui/report-writer.js";
import { handleError } from "../utils/errors.js";
import type { RunCreated, RunStatus, RunSubmission } from "../api/types.js";

export function registerRun(program: Command): void {
  program
    .command("run <config>")
    .description("Run a security audit")
    .option("--budget <n>", "Max spend in USD", parseFloat)
    .option("--goal <level>", "AIVSS goal: low|medium|high|critical")
    .option("--output <dir>", "Report output directory", ".")
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

        renderHeader(config, run, budget);

        const sigintHandler = () => {
          console.log("\n  Interrupted. Run continues server-side.");
          console.log(`  Check status:  nyx status ${configName}\n`);
          process.exit(0);
        };
        process.on("SIGINT", sigintHandler);

        try {
          const terminalStatuses = ["completed", "failed", "cancelled"];
          let lastLine = "";

          while (true) {
            const status = await apiRequest<RunStatus>(
              "GET",
              `/v1/nyx/runs/${run.run_id}`
            );
            const line = formatPollLine(status);
            if (line !== lastLine) {
              console.log(line);
              lastLine = line;
            }
            if (terminalStatuses.includes(status.status)) {
              if (status.result === "success") {
                await writeReport(run.run_id, configName, opts.output);
              }
              break;
            }
            await new Promise((r) => setTimeout(r, 5000));
          }
        } finally {
          process.off("SIGINT", sigintHandler);
        }
      } catch (err) {
        handleError(err);
      }
    });
}

function formatPollLine(r: RunStatus): string {
  const spent = `$${r.spent_usd.toFixed(2)}`;
  const budget = `$${r.budget_usd.toFixed(2)}`;
  const findings = r.findings_count > 0 ? `, ${r.findings_count} finding${r.findings_count === 1 ? "" : "s"}` : "";

  if (r.status === "running") {
    return `  ● Running — attempt ${r.attempts_completed + 1}, ${spent} / ${budget} spent${findings}`;
  }
  if (r.status === "queued") {
    return "  ○ Queued — waiting to start";
  }
  if (r.status === "completed" && r.result === "success") {
    return `  ✔ Completed — vulnerability found (${spent} spent${findings})`;
  }
  if (r.status === "completed" || r.status === "failed") {
    return `  ✗ ${r.result === "exhausted" ? "Exhausted" : "Failed"} — ${spent} / ${budget} spent${findings}`;
  }
  if (r.status === "cancelled") {
    return `  ○ Cancelled — ${spent} spent`;
  }
  return `  ● ${r.status}`;
}
