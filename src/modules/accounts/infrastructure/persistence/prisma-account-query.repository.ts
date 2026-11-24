import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/prisma/prisma.service';
import type {
  AccountQueryRepositoryPort,
  ListAccountsByOwnerOptions,
} from '../../application/ports/account-query.repository.port';
import type {
  AccountPageReadModel,
  AccountReadModel,
} from '../../application/queries/account.read-model';

const ACCOUNT_READ_SELECT = {
  id: true,
  userId: true,
  accountNumber: true,
  accountName: true,
  accountType: true,
  currentBalance: true,
  currency: true,
  status: true,
  createdAt: true,
  closedAt: true,
} satisfies Prisma.BankAccountSelect;

type AccountReadRow = Prisma.BankAccountGetPayload<{
  select: typeof ACCOUNT_READ_SELECT;
}>;

@Injectable()
export class PrismaAccountQueryRepository
  implements AccountQueryRepositoryPort
{
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<AccountReadModel | null> {
    const row = await this.prisma.bankAccount.findUnique({
      where: { id },
      select: ACCOUNT_READ_SELECT,
    });

    return row === null ? null : this.toReadModel(row);
  }

  async findByAccountNumber(
    accountNumber: string,
  ): Promise<AccountReadModel | null> {
    const row = await this.prisma.bankAccount.findUnique({
      where: { accountNumber },
      select: ACCOUNT_READ_SELECT,
    });

    return row === null ? null : this.toReadModel(row);
  }

  async listByOwner(
    userId: string,
    options: ListAccountsByOwnerOptions,
  ): Promise<AccountPageReadModel> {
    const where: Prisma.BankAccountWhereInput = {
      userId,
      ...(options.status === undefined ? {} : { status: options.status }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.bankAccount.findMany({
        where,
        select: ACCOUNT_READ_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (options.page - 1) * options.limit,
        take: options.limit,
      }),
      this.prisma.bankAccount.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toReadModel(row)),
      total,
    };
  }

  private toReadModel(row: AccountReadRow): AccountReadModel {
    if (row.currency !== 'VND') {
      throw new Error('Unsupported account currency');
    }

    return {
      id: row.id,
      userId: row.userId,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      accountType: row.accountType,
      currentBalance: row.currentBalance.toString(),
      currency: row.currency,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    };
  }
}
