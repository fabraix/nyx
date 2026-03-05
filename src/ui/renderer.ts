import chalk from "chalk";
import type { NyxConfig } from "../config/schema.js";
import type { RunCreated, SSEEvent } from "../api/types.js";
import type { StreamCallbacks } from "../api/stream.js";
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

export function createStreamRenderer(opts: {
  verbose?: boolean;
  runId: string;
}): StreamCallbacks {
  return {
    onEvent(event: SSEEvent) {
      renderEvent(event, opts.verbose ?? false, opts.runId);
    },
    onDone() {},
  };
}

function renderEvent(
  event: SSEEvent,
  verbose: boolean,
  runId: string
): void {
  const d = event.data;

  switch (event.event) {
    case "run.started":
      console.log(chalk.cyan("  ● Starting reconnaissance...\n"));
      break;

    case "attempt.started":
      console.log(
        `  ${chalk.bold(`Attempt ${d.attempt}`)} — ${d.strategy_summary}`
      );
      break;

    case "attempt.progress":
      console.log(chalk.dim(`  │ [${d.tool}] ${d.preview}`));
      break;

    case "attempt.completed": {
      const status = d.success
        ? chalk.green("✔ Success")
        : chalk.red("✗ Failed");
      if (d.summary) {
        console.log(`  │ Result:   ${d.summary}`);
      }
      console.log(`  │ Cost:     $${(d.cost_usd as number).toFixed(2)}`);
      console.log(`  └ Status:   ${status}\n`);
      break;
    }

    case "finding.saved":
      console.log(chalk.dim(`  ℹ Finding: [${d.category}] ${d.content}`));
      break;

    case "run.completed": {
      const spent = (d.total_spent_usd as number).toFixed(2);
      console.log(chalk.dim("\n  " + "─".repeat(45)));
      console.log("");
      console.log(
        chalk.green.bold("  ✔ OBJECTIVE ACHIEVED") +
          ` on attempt ${d.winning_attempt}`
      );
      console.log("");
      console.log(`  Technique:   ${d.technique_summary}`);
      console.log(`  Total cost:  $${spent}`);
      if (d.report_url) {
        console.log(
          `  View online: https://app.fabraix.com/nyx/runs/${runId}`
        );
      }
      console.log(chalk.dim("\n  " + "─".repeat(45) + "\n"));
      break;
    }

    case "run.failed": {
      const spent = (d.total_spent_usd as number).toFixed(2);
      const budget = d.budget_usd
        ? `$${(d.budget_usd as number).toFixed(2)}`
        : null;
      console.log(chalk.dim("\n  " + "─".repeat(45)));
      console.log("");
      const label = String(d.result ?? "FAILED").toUpperCase();
      if (budget) {
        console.log(
          chalk.red.bold(`  ✗ ${label}`) + ` ($${spent} / ${budget} spent)`
        );
      } else {
        console.log(chalk.red.bold(`  ✗ ${label}`) + ` ($${spent} spent)`);
      }
      if (d.closest_attempt) {
        console.log(
          `\n  Closest attempt: #${d.closest_attempt} — ${d.closest_detail}`
        );
      }
      console.log(chalk.dim("\n  " + "─".repeat(45) + "\n"));
      break;
    }

    case "run.error":
      console.log(chalk.red(`\n  ✗ Error: ${d.error}`));
      if (d.retriable) {
        console.log(chalk.dim("    This error may be temporary. Try again.\n"));
      }
      break;
  }
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 3) + "..." : oneLine;
}
