#!/usr/bin/env node
import { Command } from "commander";
import { version } from "./version.js";
import { registerLogin } from "./commands/login.js";
import { registerLogout } from "./commands/logout.js";
import { registerRun } from "./commands/run.js";
import { registerStatus } from "./commands/status.js";
import { registerList } from "./commands/list.js";
import { registerReport } from "./commands/report.js";
import { registerCancel } from "./commands/cancel.js";

const program = new Command();
program
  .name("nyx")
  .description("Nyx by Fabraix — AI Agent Security Audits")
  .version(version);

registerLogin(program);
registerLogout(program);
registerRun(program);
registerStatus(program);
registerList(program);
registerReport(program);
registerCancel(program);

program.parse();
