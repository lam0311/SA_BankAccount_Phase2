import { ServiceUnavailableError } from '@src/common/domain/errors';
import { HealthService } from '@src/modules/health/application/health.service';
import type { OutboxHealthIndicatorPort } from '@src/modules/health/application/ports/outbox-health.port';
import { PrismaOutboxHealthIndicator } from '@src/modules/health/infrastructure/prisma-outbox-health.indicator';
import { HealthController } from '@src/modules/health/presentation/http/health.controller';

describe('Health Check Endpoint (GET /api/v1/health)', () => {
  function createDeps() {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const cache = {
      ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 0.45 }),
    };
    const bcryptHasher = {
      getMetrics: jest.fn().mockReturnValue({
        inFlight: 1,
        queued: 0,
        maxThreads: 3,
        maxQueue: 100,
        currentLimit: 3,
        activeOtherRequests: 0,
        isDestroyed: false,
      }),
    };
    const outbox: jest.Mocked<OutboxHealthIndicatorPort> = {
      check: jest.fn().mockResolvedValue({
        status: 'OK',
        pendingCount: 0,
        lagMs: 0,
      }),
    };

    const service = new HealthService(
      prisma as any,
      cache as any,
      bcryptHasher as any,
      outbox,
    );
    return { prisma, cache, bcryptHasher, outbox, service };
  }

  it('trả về status OK kèm đầy đủ thông số của Postgres, Redis, Piscina và Outbox lag', async () => {
    const { service } = createDeps();
    const controller = new HealthController(service);

    const report = await controller.check();

    expect(report.status).toBe('OK');
    expect(typeof report.timestamp).toBe('string');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(report.checks).toEqual({
      postgres: {
        status: 'OK',
        latencyMs: expect.any(Number),
      },
      redis: {
        status: 'OK',
        latencyMs: 0.45,
      },
      piscina: {
        status: 'OK',
        inFlight: 1,
        queued: 0,
        maxThreads: 3,
        maxQueue: 100,
        currentLimit: 3,
      },
      outbox: {
        status: 'OK',
        pendingCount: 0,
        lagMs: 0,
      },
    });
  });

  it('trả về status DEGRADED (vẫn HTTP 200) khi Redis mất kết nối hoặc Outbox lag cao nhưng Postgres vẫn sống', async () => {
    const { cache, outbox, service } = createDeps();
    cache.ping.mockResolvedValue({ ok: false, latencyMs: 1500 });
    outbox.check.mockResolvedValue({
      status: 'DEGRADED',
      pendingCount: 42,
      lagMs: 45000,
    });

    const report = await service.check();

    expect(report.status).toBe('DEGRADED');
    expect(report.checks.postgres.status).toBe('OK');
    expect(report.checks.redis.status).toBe('DEGRADED');
    expect(report.checks.outbox).toEqual({
      status: 'DEGRADED',
      pendingCount: 42,
      lagMs: 45000,
    });
  });

  it('trả về status DEGRADED khi hàng đợi Piscina chạm trần maxQueue', async () => {
    const { bcryptHasher, service } = createDeps();
    bcryptHasher.getMetrics.mockReturnValue({
      inFlight: 3,
      queued: 100,
      maxThreads: 3,
      maxQueue: 100,
      currentLimit: 3,
      activeOtherRequests: 0,
      isDestroyed: false,
    });

    const report = await service.check();

    expect(report.status).toBe('DEGRADED');
    expect(report.checks.piscina.status).toBe('DEGRADED');
  });

  it('ném ServiceUnavailableError (503) khi Postgres bị DOWN và không lộ chuỗi lỗi nội bộ', async () => {
    const { prisma, service } = createDeps();
    prisma.$queryRaw.mockRejectedValue(
      new Error('password authentication failed for user secret_db_user'),
    );

    await expect(service.check()).rejects.toThrow(ServiceUnavailableError);
    await expect(service.check()).rejects.toMatchObject({
      errorCode: 'SERVICE_UNAVAILABLE',
      httpStatus: 503,
      details: [{ field: 'postgres', reason: 'down' }],
    });
  });

  describe('PrismaOutboxHealthIndicator', () => {
    it('trả OK (lagMs = 0) khi schema hiện tại chưa tạo bảng outbox', async () => {
      const mockPrisma = {
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      const indicator = new PrismaOutboxHealthIndicator(mockPrisma as any);

      await expect(indicator.check()).resolves.toEqual({
        status: 'OK',
        pendingCount: 0,
        lagMs: 0,
      });
    });

    it('đo chính xác pendingCount và lagMs khi có bảng outbox_events, đánh dấu DEGRADED nếu vượt ngưỡng', async () => {
      const mockPrisma = {
        $queryRaw: jest
          .fn()
          // Lần 1: tìm thấy bảng outbox_events
          .mockResolvedValueOnce([
            { tableName: 'outbox_events', columnName: 'id' },
            { tableName: 'outbox_events', columnName: 'processed_at' },
            { tableName: 'outbox_events', columnName: 'created_at' },
          ])
          // Lần 2: lag thấp (250ms) -> OK
          .mockResolvedValueOnce([{ pendingCount: BigInt(3), lagMs: 250.4 }])
          // Lần 3: tìm thấy bảng outbox_events
          .mockResolvedValueOnce([
            { tableName: 'outbox_events', columnName: 'status' },
            { tableName: 'outbox_events', columnName: 'created_at' },
          ])
          // Lần 4: lag cao (65000ms > 30000ms) -> DEGRADED
          .mockResolvedValueOnce([{ pendingCount: BigInt(15), lagMs: 65000 }]),
      };
      const indicator = new PrismaOutboxHealthIndicator(mockPrisma as any);

      await expect(indicator.check()).resolves.toEqual({
        status: 'OK',
        pendingCount: 3,
        lagMs: 250,
      });

      await expect(indicator.check()).resolves.toEqual({
        status: 'DEGRADED',
        pendingCount: 15,
        lagMs: 65000,
      });
    });
  });
});
