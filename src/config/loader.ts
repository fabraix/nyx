import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type NyxConfig } from "./schema.js";
import { resolveConfigName } from "../utils/config-name.js";
import { NyxError } from "../utils/errors.js";

export function loadConfig(name: string): { config: NyxConfig; configName: string } {
  const configName = resolveConfigName(name);
  const candidates = [
    resolve(`${configName}.yaml`),
    resolve(`${configName}.yml`),
    resolve(name),
  ];

  const filePath = candidates.find(existsSync);
  if (!filePath) {
    throw new NyxError(
      `Config file not found: ${configName}.yaml\n` +
        `  Create a YAML config file. See: https://docs.fabraix.com/nyx/config`,
      "config"
    );
  }

  let raw: unknown;
  try {
    const content = readFileSync(filePath, "utf-8");
    raw = parseYaml(content);
  } catch (err) {
    throw new NyxError(
      `Failed to parse ${filePath}: ${(err as Error).message}`,
      "config"
    );
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new NyxError(`Invalid config in ${filePath}:\n${issues}`, "config");
  }

  return { config: result.data, configName };
}
