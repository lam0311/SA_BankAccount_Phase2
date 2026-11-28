export const ACCOUNT_EVENTS = {
  OPENED: 'account.opened',
  CLOSED: 'account.closed',
  BALANCE_CHANGED: 'account.balance_changed',
} as const;

export type AccountEventType =
  (typeof ACCOUNT_EVENTS)[keyof typeof ACCOUNT_EVENTS];

export interface AccountIdentityPayload {
  readonly accountId: string;
  readonly userId: string;
  readonly accountNumber: string;
}

export type AccountOpenedEventPayload = AccountIdentityPayload;

export type AccountClosedEventPayload = AccountIdentityPayload;

export interface AccountBalanceChangedEventPayload {
  readonly accounts: readonly AccountIdentityPayload[];
}
