// --- Auth ---

export interface TokenValidationResponse {
  userId: string;
  email: string;
  accountId?: string;
}
