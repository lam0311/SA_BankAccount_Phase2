export const ACCOUNT_STATUSES = ['ACTIVE', 'FROZEN', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
