import { z } from "zod";

const target = z.object({
  url: z.string().url("target.url must be a valid URL").optional(),
  endpoint: z.string().min(1, "target.endpoint must not be empty").optional(),
  credentials: z.record(z.string()).optional(),
}).refine(
  (t) => t.url || t.endpoint,
  { message: "At least one of target.url or target.endpoint is required" },
);

export const configSchema = z.object({
  name: z.string().min(1, "name is required"),
  target,
  objective: z.string().min(1, "objective is required"),
  mode: z.enum(["deep", "standard", "shallow", "fast"]).default("standard"),
  hints: z.array(z.string()).optional(),
});

export type NyxConfig = z.infer<typeof configSchema>;
