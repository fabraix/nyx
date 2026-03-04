import { Command } from "commander";
import chalk from "chalk";
import { removeCredentials } from "../config/auth.js";
import { handleError } from "../utils/errors.js";

export function registerLogout(program: Command): void {
  program
    .command("logout")
    .description("Remove stored credentials")
    .action(async () => {
      try {
        const removed = removeCredentials();
        if (removed) {
          console.log(chalk.green("\n  Logged out. Credentials removed.\n"));
        } else {
          console.log(chalk.dim("\n  No stored credentials found.\n"));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
