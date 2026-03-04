import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { apiRawRequest } from "../api/client.js";
import { NyxError } from "../utils/errors.js";

export async function writeReport(
  runId: string,
  configName: string,
  outputDir: string
): Promise<string> {
  const res = await apiRawRequest("GET", `/v1/nyx/runs/${runId}/report`, "text/markdown");

  const markdown = await res.text();
  const filename = `nyx-report-${configName}.md`;
  const outputPath = join(outputDir, filename);

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, markdown, "utf-8");
  } catch (err) {
    throw new NyxError(
      `Failed to write report to ${outputPath}: ${(err as Error).message}`,
      "file"
    );
  }

  console.log(`  Report:      ${outputPath}`);
  return outputPath;
}
