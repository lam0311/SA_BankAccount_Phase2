import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import redisConfig from '@src/common/config/redis.config';
import { MultiLevelCacheService } from './multi-level-cache.service';

@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [MultiLevelCacheService],
  exports: [MultiLevelCacheService],
})
export class CacheModule {}
