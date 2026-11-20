import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import { RateLimitExceededError } from "@src/common/domain/errors";
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
} from "@src/common/security/decorators";
import { RedisTokenBucketService } from "../rate-limit/redis-token-bucket.service";

// Hàm tách địa chỉ IP thật của client gửi request
function extractClientIp(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : request.ip || request.socket?.remoteAddress || "unknown";

  // Chuẩn hóa IPv6
  return raw.replace(/^::ffff:/, "");
}

@Injectable()
export class RateLimiterGuard implements CanActivate {
  constructor(
    // Reflector là công cụ đọc
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly tokenBucket: RedisTokenBucketService,
  ) {}


  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Kiểm tra công tắc: Nếu cấu hình tắt Rate Limit thì cho qua luôn
    if (this.configService.get<string>("RATE_LIMIT_ENABLED") === "false") {
      return true;
    }

    // Đọc xem endpoint khách đang gọi có gắn @RateLimit hay không
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Route không gắn @RateLimit thì cho qua luôn
    if (!options) return true;

    // Lấy đối tượng request và response của Express từ bối cảnh HTTP hiện tại
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Tạo key riêng cho từng tầng
    const clientIp = extractClientIp(request);
    const key = `rl:${options.tier}:${clientIp}`;

    // Gọi Redis Lua Script kiểm tra và trừ 1 xu
    const result = await this.tokenBucket.consume(
      key,
      options.capacity,
      options.windowMs,
    );

    // Gắn header thông báo hạn mức cho client biết
    response.setHeader("X-RateLimit-Limit", String(options.capacity));
    response.setHeader("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      response.setHeader("Retry-After", String(result.retryAfterSeconds));
      throw new RateLimitExceededError();
    }

    // Còn xu thì cho phép đi tiếp
    return true;
  }
}
