#!/usr/bin/env node
import { Command } from "commander";
import { version } from "./version.js";
import { registerLogin } from "./commands/login.js";
import { registerLogout } from "./commands/logout.js";
import { startTui } from "./commands/tui.js";

const program = new Command();
program
  .name("nyx")
  .description("Open Nyx's interactive terminal")
  .allowExcessArguments(false)
  .version(version)
  .action(startTui)
  .addHelpText("after", `
Get started:
  nyx login
  nyx

Enter your requests in the terminal. Use /help for available actions.`);

registerLogin(program);
registerLogout(program);

await program.parseAsync();
