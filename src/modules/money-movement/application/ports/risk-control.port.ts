export const RISK_CONTROL = Symbol("RISK_CONTROL");

export type RiskCheckStatus =
  | "OK"
  | "DAILY_LIMIT_EXCEEDED"
  | "VELOCITY_LIMIT_EXCEEDED"
  | "SKIPPED";

export interface RiskCheckResult {
  status: RiskCheckStatus;
  memberId?: string;
  dailySpent?: string;
  velocityCount?: number;
}

export interface RiskControlPort {
  checkAndConsumeOutflow(accountId: string, amount: string): Promise<RiskCheckResult>;
  releaseOutflow(accountId: string, amount: string, memberId?: string): Promise<void>;
}
