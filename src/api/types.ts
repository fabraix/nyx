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

export interface ProtocolEndpoint {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  response?: Record<string, string>;
}

export interface ModelConfig {
  provider: string; // openai | anthropic | deepseek
  name: string;     // model identifier, e.g. claude-opus-4-6
}

export interface RunSubmission {
  config_name: string;
  name: string;
  target: {
    base_url: string;
    protocol: {
      create_session: ProtocolEndpoint;
      send_message: ProtocolEndpoint;
    };
  };
  objective: string;
  budget_usd: number;
  severity_target: string;
  hints?: string[];
  model: ModelConfig;
}

export interface RunCreated {
  run_id: string;
  config_name: string;
  status: string;
  created_at: string;
  stream_url: string;
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

// --- SSE Events ---

export type SSEEventType =
  | "run.started"
  | "attempt.started"
  | "attempt.progress"
  | "attempt.completed"
  | "finding.saved"
  | "run.completed"
  | "run.failed"
  | "run.error";

export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, unknown>;
  id?: string;
}
