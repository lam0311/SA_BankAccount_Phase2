import { Module } from '@nestjs/common';
import { IdentityModule } from '@src/modules/identity/identity.module';
import { HealthService } from './application/health.service';
import { OUTBOX_HEALTH_INDICATOR } from './application/ports/outbox-health.port';
import { PrismaOutboxHealthIndicator } from './infrastructure/prisma-outbox-health.indicator';
import { HealthController } from './presentation/http/health.controller';

@Module({
  imports: [IdentityModule],
  controllers: [HealthController],
  providers: [
    PrismaOutboxHealthIndicator,
    {
      provide: OUTBOX_HEALTH_INDICATOR,
      useExisting: PrismaOutboxHealthIndicator,
    },
    HealthService,
  ],
})
export class HealthModule {}
