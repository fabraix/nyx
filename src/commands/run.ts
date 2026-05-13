import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import type { NyxConfig } from "../config/schema.js";
import { apiRequest } from "../api/client.js";
import { renderHeader } from "../ui/renderer.js";
import { handleError } from "../utils/errors.js";
import type {
  RunCreated,
  RunStatus,
  RunSubmission,
  Severity,
  TargetIn,
  TargetOut,
} from "../api/types.js";

export function registerRun(program: Command): void {
  program
    .command("run <config>")
    .description("Run a security audit")
    .option("--budget <n>", "Max spend in USD", parseFloat)
    .option("--goal <level>", "AIVSS goal: low|medium|high|critical")
    .option("--target <id>", "Use this saved target id (skips find-or-create)")
    .option("--verbose", "Show full transcripts")
    .action(async (configArg: string, opts) => {
      try {
        const { config, configName } = loadConfig(configArg);

        const budget = opts.budget ?? config.budget;
        const goal = opts.goal ?? config.goal;

        const targetId =
          opts.target ?? (await findOrCreateTarget(config, budget, goal));

        const submission: RunSubmission = {
          config_name: configName,
          name: config.name,
          target: config.target,
          target_id: targetId,
          objective: config.objective,
          budget_usd: budget,
          severity_target: goal,
          hints: config.hints,
        };

        const run = await apiRequest<RunCreated>(
          "POST",
          "/v1/nyx/runs",
          submission,
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
              `/v1/nyx/runs/${run.run_id}`,
            );
            const line = formatPollLine(status);
            if (line !== lastLine) {
              console.log(line);
              lastLine = line;
            }
            if (terminalStatuses.includes(status.status)) {
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

async function findOrCreateTarget(
  config: NyxConfig,
  budget: number,
  goal: Severity,
): Promise<string> {
  const targets = await apiRequest<TargetOut[]>("GET", "/v1/nyx/targets");
  const existing = targets.find((t) => t.name === config.name);
  if (existing) return existing.id;

  const body: TargetIn = {
    name: config.name,
    slug: deriveSlug(config),
    url: config.target.url ?? null,
    endpoint: config.target.endpoint ?? null,
    credentials: config.target.credentials ?? {},
    hints: config.hints ?? [],
    severity_target: goal,
    default_budget_usd: budget,
  };
  const created = await apiRequest<TargetOut>("POST", "/v1/nyx/targets", body);
  return created.id;
}

function deriveSlug(config: NyxConfig): string {
  if (config.target.url) {
    try {
      return new URL(config.target.url).host;
    } catch {
      // fall through to name-based slug
    }
  }
  return config.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
