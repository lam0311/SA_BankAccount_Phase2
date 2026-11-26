import type { TransactionEntryRecord } from "./unit-of-work.port";

// nhan dung de dang ky va inject service trong nestjs
export const BALANCE_RESERVATION = Symbol("BALANCE_RESERVATION");
export const WITHDRAW_SETTLEMENT = Symbol("WITHDRAW_SETTLEMENT");

// du lieu toi thieu cua mot tai khoan can luu tren redis
export interface AccountBalanceCache {
  accountId: string;
  userId: string;
  status: "ACTIVE" | "CLOSED";
  balance: string;
}

// mot lenh rut tien dang nam trong hang doi redis cho worker ghi xuong postgres
export interface QueuedWithdrawalItem {
  id: string;
  accountId: string;
  userId: string;
  amount: string;
  balanceAfter: string;
  description: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

// cac ket qua co the tra ve sau khi chay lua tren redis
export type ReserveStatus =
  | "OK"
  | "INSUFFICIENT_FUNDS"
  | "NOT_OWNER"
  | "CLOSED"
  | "REPLAY"
  | "MISS"
  | "FALLBACK";

export interface ReserveResult {
  status: ReserveStatus;
  remainingBalance?: string;
  queuedTransaction?: TransactionEntryRecord;
  replayedTransaction?: TransactionEntryRecord;
}

// danh sach ham ma cac use case se goi de lam viec voi lop giu tien tren redis
export interface BalanceReservationPort {
  seedAccount(data: AccountBalanceCache): Promise<void>;
  syncAccount(data: AccountBalanceCache): Promise<void>;
  reserveDebit(
    accountId: string,
    userId: string,
    amount: string,
    idempotencyKey?: string,
    description?: string | null,
  ): Promise<ReserveResult>;
  releaseDebit(accountId: string, amount: string): Promise<void>;
  markIdempotencyKey(accountId: string, idempotencyKey: string): Promise<void>;
  invalidate(accountId: string): Promise<void>;
  // lay toi da limit lenh rut tu dau hang doi redis de worker ghi theo lo
  popSettlementBatch?(limit: number): Promise<QueuedWithdrawalItem[]>;
  // day nguoc lai dau hang doi neu postgres gap loi tam thoi
  requeueSettlementBatch?(items: QueuedWithdrawalItem[]): Promise<void>;
  // khoa tam luc khoi tao cache tai khoan de tranh nhieu luong miss cung chay db
  acquireInitLock?(accountId: string): Promise<boolean>;
  releaseInitLock?(accountId: string): Promise<void>;
}

export interface WithdrawSettlementPort {
  // xa toan bo lenh rut dang cho trong hang doi redis xuong postgres
  flush(): Promise<number>;
}
