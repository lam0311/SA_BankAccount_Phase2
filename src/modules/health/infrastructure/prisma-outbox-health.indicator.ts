import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/prisma';
import type {
  OutboxHealthIndicatorPort,
  OutboxHealthStatus,
} from '../application/ports/outbox-health.port';

const CANDIDATE_OUTBOX_TABLES = [
  'outbox_events',
  'outbox_messages',
  'outbox',
] as const;

type CandidateOutboxTable = (typeof CANDIDATE_OUTBOX_TABLES)[number];

interface ColumnRow {
  tableName: string;
  columnName: string;
}

interface OutboxStatsRow {
  pendingCount: bigint | number | string;
  lagMs: number | string | null;
}

const DEFAULT_MAX_OUTBOX_LAG_MS = 30_000;

/**
 * Đo độ trễ (lag) của hàng đợi Transactional Outbox trong PostgreSQL.
 * - Nếu bảng Outbox chưa được tạo trong schema hiện tại: trả trạng thái mặc định OK (0 pending, 0ms lag).
 * - Nếu bảng Outbox đã tồn tại: tự động tính số bản ghi chưa gửi và tuổi của bản ghi cũ nhất (lagMs).
 */
@Injectable()
export class PrismaOutboxHealthIndicator implements OutboxHealthIndicatorPort {
  private readonly maxLagMs: number;

  constructor(private readonly prisma: PrismaService) {
    this.maxLagMs = parseInt(
      process.env.OUTBOX_MAX_LAG_MS ?? String(DEFAULT_MAX_OUTBOX_LAG_MS),
      10,
    );
  }

  async check(timeoutMs = 1500): Promise<OutboxHealthStatus> {
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<OutboxHealthStatus>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Outbox health check timeout')),
          timeoutMs,
        );
        timer.unref();
      });

      return await Promise.race([this.queryOutboxLag(), timeoutPromise]);
    } catch {
      return {
        status: 'DEGRADED',
        pendingCount: 0,
        lagMs: 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async queryOutboxLag(): Promise<OutboxHealthStatus> {
    const columns = await this.prisma.$queryRaw<ColumnRow[]>(
      Prisma.sql`
        SELECT
          table_name AS "tableName",
          column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('outbox_events', 'outbox_messages', 'outbox')
      `,
    );

    if (columns.length === 0) {
      return { status: 'OK', pendingCount: 0, lagMs: 0 };
    }

    const foundTable = CANDIDATE_OUTBOX_TABLES.find((candidate) =>
      columns.some((col) => col.tableName === candidate),
    );
    if (!foundTable) {
      return { status: 'OK', pendingCount: 0, lagMs: 0 };
    }

    const colSet = new Set(
      columns
        .filter((col) => col.tableName === foundTable)
        .map((col) => col.columnName),
    );

    const rows = await this.executeSafeTableStats(foundTable, colSet);
    const row = rows[0];
    const pendingCount = Number(row?.pendingCount ?? 0);
    const lagMs = Math.max(0, Math.round(Number(row?.lagMs ?? 0)));

    return {
      status: lagMs > this.maxLagMs ? 'DEGRADED' : 'OK',
      pendingCount,
      lagMs,
    };
  }

  private executeSafeTableStats(
    table: CandidateOutboxTable,
    colSet: Set<string>,
  ): Promise<OutboxStatsRow[]> {
    const tableIdent = Prisma.raw(`"public"."${table}"`);
    const createdExpr = colSet.has('created_at')
      ? Prisma.raw(
          `COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000), 0)`,
        )
      : Prisma.raw('0');

    let whereClause = Prisma.raw('TRUE');
    if (colSet.has('processed_at')) {
      whereClause = Prisma.raw('processed_at IS NULL');
    } else if (colSet.has('published_at')) {
      whereClause = Prisma.raw('published_at IS NULL');
    } else if (colSet.has('status')) {
      whereClause = Prisma.raw(`status IN ('PENDING', 'FAILED', 'RETRYING')`);
    }

    return this.prisma.$queryRaw<OutboxStatsRow[]>(
      Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "pendingCount",
          ${createdExpr} AS "lagMs"
        FROM ${tableIdent}
        WHERE ${whereClause}
      `,
    );
  }
}
