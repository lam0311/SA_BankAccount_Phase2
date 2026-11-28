import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { TrafficLoadService } from "@src/common/concurrency";

const IGNORED_PATH_PATTERNS = [
  /^\/(?:api\/v1\/)?auth\/(?:login|register)\/?$/i,
  /^\/(?:api\/v1\/)?health(?:\/.*)?$/i,
  /^\/api\/docs(?:\/.*)?$/i,
];

function isNonAuthTraffic(request: Request): boolean {
  const rawUrl = request.originalUrl || request.url || request.path || "";
  const pathname = rawUrl.split("?")[0];
  return !IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * Đếm các request KHÔNG phải /auth/login hay /auth/register đang xử lý song song.
 * Dùng res.once('finish') và res.once('close') kèm cờ chống giải phóng 2 lần
 * để đảm bảo không rò rỉ bộ đếm ngay cả khi client ngắt kết nối đột ngột.
 */
@Injectable()
export class TrafficLoadMiddleware implements NestMiddleware {
  constructor(private readonly trafficLoad: TrafficLoadService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!isNonAuthTraffic(req)) {
      next();
      return;
    }

    this.trafficLoad.increment();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.trafficLoad.decrement();
    };

    res.once("finish", release);
    res.once("close", release);
    next();
  }
}
