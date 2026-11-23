import { EventEmitter } from "events";
import { TrafficLoadService } from "@src/common/concurrency/traffic-load.service";
import { TrafficLoadMiddleware } from "@src/common/http/middleware/traffic-load.middleware";

describe("TrafficLoadMiddleware", () => {
  let trafficLoad: TrafficLoadService;
  let middleware: TrafficLoadMiddleware;

  beforeEach(() => {
    trafficLoad = new TrafficLoadService();
    middleware = new TrafficLoadMiddleware(trafficLoad);
  });

  function createMockRes() {
    return new EventEmitter() as any;
  }

  it("tăng counter cho API non-auth và giảm khi response finish", () => {
    const req = { originalUrl: "/api/v1/accounts?page=1&limit=20" } as any;
    const res = createMockRes();
    const next = jest.fn();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(trafficLoad.getActiveOtherRequests()).toBe(1);

    res.emit("finish");
    expect(trafficLoad.getActiveOtherRequests()).toBe(0);

    // Nếu cả close cũng bắn sau finish -> không được trừ lần 2
    res.emit("close");
    expect(trafficLoad.getActiveOtherRequests()).toBe(0);
  });

  it("giảm counter nếu client ngắt kết nối đột ngột (close)", () => {
    const req = { originalUrl: "/api/v1/transfers" } as any;
    const res = createMockRes();
    const next = jest.fn();

    middleware.use(req, res, next);
    expect(trafficLoad.getActiveOtherRequests()).toBe(1);

    res.emit("close");
    expect(trafficLoad.getActiveOtherRequests()).toBe(0);
  });

  it("bỏ qua /auth/login, /auth/register và /api/docs", () => {
    for (const url of [
      "/api/v1/auth/login",
      "/api/v1/auth/register",
      "/auth/login?foo=1",
      "/api/docs/index.html",
    ]) {
      const req = { originalUrl: url } as any;
      const res = createMockRes();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(trafficLoad.getActiveOtherRequests()).toBe(0);
    }
  });
});
