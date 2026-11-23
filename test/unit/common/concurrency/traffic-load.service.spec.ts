import { TrafficLoadService } from "@src/common/concurrency/traffic-load.service";

describe("TrafficLoadService", () => {
  let service: TrafficLoadService;

  beforeEach(() => {
    service = new TrafficLoadService();
  });

  it("trả về full maxThreads (N-1) khi không có non-auth request nào", () => {
    expect(service.getActiveOtherRequests()).toBe(0);
    expect(service.getBcryptConcurrencyLimit(7, 10)).toBe(7);
    expect(service.getBcryptConcurrencyLimit(3, 10)).toBe(3);
  });

  it("giảm xuống floor((N-1)/2) khi có ít nhất 1 non-auth request", () => {
    service.increment();
    expect(service.getActiveOtherRequests()).toBe(1);
    expect(service.getBcryptConcurrencyLimit(7, 10)).toBe(3);
    expect(service.getBcryptConcurrencyLimit(4, 10)).toBe(2);
    expect(service.getBcryptConcurrencyLimit(3, 10)).toBe(1);
  });

  it("giảm tiếp xuống 1 khi lượng non-auth request đạt ngưỡng tải cao", () => {
    for (let i = 0; i < 10; i++) {
      service.increment();
    }
    expect(service.getActiveOtherRequests()).toBe(10);
    expect(service.getBcryptConcurrencyLimit(7, 10)).toBe(1);
  });

  it("thông báo listener khi decrement để đánh thức hàng đợi Bcrypt", () => {
    const listener = jest.fn();
    const unsubscribe = service.onCapacityChange(listener);

    service.increment();
    expect(listener).not.toHaveBeenCalled();

    service.decrement();
    expect(listener).toHaveBeenCalledTimes(1);

    // Không cho activeOtherRequests âm và không notify thừa khi đã bằng 0
    service.decrement();
    expect(service.getActiveOtherRequests()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    service.increment();
    service.decrement();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
