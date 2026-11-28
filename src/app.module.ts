import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "@src/infrastructure/prisma";
import { CacheModule } from "@src/infrastructure/cache/cache.module";
import { OutboxModule } from "@src/infrastructure/outbox";
import { IdentityModule } from "@src/modules/identity/identity.module";
import { AccountsModule } from "@src/modules/accounts/accounts.module";
import { MoneyMovementModule } from "@src/modules/money-movement/money-movement.module";
import { HealthModule } from "@src/modules/health/health.module";
import { AccessTokenGuard, RateLimiterGuard } from "@src/common/security/guards";
import { RedisTokenBucketService } from "@src/common/security/rate-limit/redis-token-bucket.service";
import { ConcurrencyModule } from "@src/common/concurrency";
import { TrafficLoadMiddleware } from "@src/common/http/middleware";
import { ObservabilityModule } from "@src/common/observability";
import {
  validateEnv,
  appConfig,
  jwtConfig,
  databaseConfig,
  redisConfig,
} from "@src/common/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [appConfig, jwtConfig, databaseConfig, redisConfig],
    }),
    ConcurrencyModule,
    ObservabilityModule,
    CacheModule,
    PrismaModule,
    OutboxModule,
    IdentityModule,
    AccountsModule,
    MoneyMovementModule,
    HealthModule,
  ],
  providers: [
    RedisTokenBucketService,
    { provide: APP_GUARD, useClass: RateLimiterGuard },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TrafficLoadMiddleware).forRoutes("*");
  }
}
