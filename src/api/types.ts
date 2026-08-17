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

export type BudgetTier = "deep" | "standard" | "shallow" | "fast";

export interface RunSubmission {
  config_name: string;
  name: string;
  target: {
    url?: string;
    endpoint?: string;
    credentials?: Record<string, string>;
  };
  target_id: string;
  objective: string;
  budget_tier: BudgetTier;
  hints?: string[];
}

// --- Targets ---

export interface TargetIn {
  name: string;
  slug: string;
  url: string | null;
  endpoint: string | null;
  credentials: Record<string, string>;
  hints: string[];
  default_budget_tier: BudgetTier;
}

export interface TargetOut extends TargetIn {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
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
  budget_tier?: BudgetTier | null;
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
