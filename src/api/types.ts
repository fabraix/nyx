// --- Auth ---

export interface TokenValidationResponse {
  userId: string;
  email: string;
  username: string;
  beta: string;
  skillCreated: boolean;
  token: string;
}

// --- Runs ---

export interface ModelConfig {
  provider: string; // openai | anthropic | deepseek | gemini
  name: string;     // model identifier, e.g. claude-opus-4-6
}

export interface RunSubmission {
  config_name: string;
  name: string;
  target: {
    url?: string;
    endpoint?: string;
    credentials?: Record<string, string>;
  };
  objective: string;
  budget_usd: number;
  severity_target: "low" | "medium" | "high" | "critical";
  hints?: string[];
  model: ModelConfig;
}

export interface RunCreated {
  run_id: string;
  config_name: string;
  status: string;
  created_at: string;
}

export interface RunStatus {
  run_id: string;
  config_name: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result: "success" | "exhausted" | "error" | null;
  budget_usd: number;
  spent_usd: number;
  attempts_completed: number;
  findings_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RunList {
  runs: RunStatus[];
  total: number;
  limit: number;
  offset: number;
}
