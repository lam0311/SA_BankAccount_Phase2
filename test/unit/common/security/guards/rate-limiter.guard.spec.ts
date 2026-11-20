import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { RateLimiterGuard } from "@src/common/security/guards/rate-limiter.guard";
import { RateLimitExceededError } from "@src/common/domain/errors";

describe("RateLimiterGuard", () => {
  const createContext = (ip = "127.0.0.1") => {
    const headers: Record<string, string> = {};
    const request = { ip, headers: {} };
    const response = {
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
    };
    return {
      headers,
      response,
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as any,
    };
  };

  it("cho qua khi route khong gan @RateLimit", async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const config = new ConfigService({ RATE_LIMIT_ENABLED: "true" });
    const bucket = { consume: jest.fn() } as any;
    const guard = new RateLimiterGuard(reflector, config, bucket);

    const { context } = createContext();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(bucket.consume).not.toHaveBeenCalled();
  });

  it("cho qua khi RATE_LIMIT_ENABLED=false", async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue({ tier: "auth", capacity: 5, windowMs: 60000 }),
    } as unknown as Reflector;
    const config = new ConfigService({ RATE_LIMIT_ENABLED: "false" });
    const bucket = { consume: jest.fn() } as any;
    const guard = new RateLimiterGuard(reflector, config, bucket);

    const { context } = createContext();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(bucket.consume).not.toHaveBeenCalled();
  });

  it("cho qua va gan header khi con token", async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue({ tier: "auth", capacity: 5, windowMs: 60000 }),
    } as unknown as Reflector;
    const config = new ConfigService({});
    const bucket = {
      consume: jest.fn().mockResolvedValue({
        allowed: true,
        remaining: 4,
        retryAfterSeconds: 0,
      }),
    } as any;
    const guard = new RateLimiterGuard(reflector, config, bucket);

    const { context, headers } = createContext("::ffff:10.0.0.1");
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(bucket.consume).toHaveBeenCalledWith("rl:auth:10.0.0.1", 5, 60000);
    expect(headers["X-RateLimit-Limit"]).toBe("5");
    expect(headers["X-RateLimit-Remaining"]).toBe("4");
  });

  it("nem RateLimitExceededError (429) va gan Retry-After khi het token", async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue({ tier: "auth", capacity: 5, windowMs: 60000 }),
    } as unknown as Reflector;
    const config = new ConfigService({});
    const bucket = {
      consume: jest.fn().mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 12,
      }),
    } as any;
    const guard = new RateLimiterGuard(reflector, config, bucket);

    const { context, headers } = createContext();
    await expect(guard.canActivate(context)).rejects.toThrow(
      RateLimitExceededError,
    );
    expect(headers["Retry-After"]).toBe("12");
  });
});
