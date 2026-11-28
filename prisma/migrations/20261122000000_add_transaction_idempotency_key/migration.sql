-- AlterTable
ALTER TABLE "financial_transactions" ADD COLUMN "idempotency_key" VARCHAR(128);

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_account_id_idempotency_key_key" ON "financial_transactions"("account_id", "idempotency_key");
