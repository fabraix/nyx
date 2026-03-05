import { z } from "zod";

const protocolEndpoint = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  body: z.record(z.unknown()).optional(),
  response: z.record(z.string()).optional(),
});

const target = z.object({
  base_url: z.string().url("target.base_url must be a valid URL"),
  protocol: z.object({
    create_session: protocolEndpoint,
    send_message: protocolEndpoint,
  }),
});

const model = z.object({
  provider: z.enum(["openai", "anthropic", "deepseek"]),
  name: z.string().min(1, "model.name is required"),
});

export const configSchema = z.object({
  name: z.string().min(1, "name is required"),
  target,
  objective: z.string().min(1, "objective is required"),
  budget: z.number().positive().default(5),
  goal: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  hints: z.array(z.string()).optional(),
  model,
});

export type NyxConfig = z.infer<typeof configSchema>;
