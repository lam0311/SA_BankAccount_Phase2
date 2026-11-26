import { plainToInstance, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from "class-validator";

/**
 * env.schema.ts - validate TOÀN BỘ biến môi trường bắt buộc lúc app khởi động
 * (dùng với ConfigModule.forRoot({ validate: validateEnv }) trong app.module.ts).
 *
 * Nguyên tắc: app phải fail-fast lúc `docker compose up` nếu thiếu/sai biến môi
 * trường, KHÔNG được start "ngầm" với secret rỗng hoặc giá trị placeholder.
 */

export enum NodeEnv {
  DEVELOPMENT = "development",
  TEST = "test",
  PRODUCTION = "production",
}

class EnvironmentVariables {
  @IsIn([NodeEnv.DEVELOPMENT, NodeEnv.TEST, NodeEnv.PRODUCTION])
  NODE_ENV: NodeEnv = NodeEnv.DEVELOPMENT;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  // "hạn dùng ngắn-vừa (ví dụ 60 phút — không cần refresh rotation ở Pha 1)" - BR-AUTH #5 bản rút gọn.
  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL = "60m";

  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(15)
  BCRYPT_ROUNDS: number = 12;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  BCRYPT_MAX_THREADS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  BCRYPT_MAX_QUEUE: number = 100;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(10000)
  BCRYPT_HIGH_TRAFFIC_THRESHOLD: number = 10;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60000)
  EVENT_LOOP_MONITOR_INTERVAL_MS: number = 0;

  @IsString()
  REDIS_HOST: string = 'localhost';

  @Type(() => Number)
  @IsInt()
  REDIS_PORT: number = 6379;

  @IsOptional()
  @IsIn(["true", "false"])
  RATE_LIMIT_ENABLED: string = "true";

  @IsOptional()
  @IsIn(["true", "false"])
  RISK_CONTROL_ENABLED: string = "true";

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  DAILY_OUTFLOW_LIMIT_VND: string = "500000000";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  VELOCITY_MAX_TX: number = 10;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(86400)
  VELOCITY_WINDOW_SECONDS: number = 60;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const message = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(", ")}`,
      )
      .join("\n");
    throw new Error(`Invalid environment variables:\n${message}`);
  }

  return validated;
}
