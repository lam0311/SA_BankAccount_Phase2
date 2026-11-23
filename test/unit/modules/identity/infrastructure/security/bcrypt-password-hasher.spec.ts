import { TrafficLoadService } from "@src/common/concurrency/traffic-load.service";
import { ServiceUnavailableError } from "@src/common/domain/errors";
import { BcryptPasswordHasher } from "@src/modules/identity/infrastructure/security/bcrypt-password-hasher";

const mockRun = jest.fn();
const mockDestroy = jest.fn().mockResolvedValue(undefined);
const mockPiscinaConstructor = jest.fn().mockImplementation(() => ({
  run: mockRun,
  destroy: mockDestroy,
}));

jest.mock("piscina", () => ({
  __esModule: true,
  default: function MockPiscina(...args: any[]) {
    return mockPiscinaConstructor(...args);
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BcryptPasswordHasher (Piscina + Adaptive Concurrency)", () => {
  let trafficLoad: TrafficLoadService;
  let hasher: BcryptPasswordHasher;

  const baseConfig = {
    port: 3000,
    globalPrefix: "api/v1",
    bcryptRounds: 10,
    bcryptMaxThreads: 4,
    bcryptMaxQueue: 2,
    bcryptHighTrafficThreshold: 5,
    eventLoopMonitorIntervalMs: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDestroy.mockResolvedValue(undefined);
    trafficLoad = new TrafficLoadService();
    hasher = new BcryptPasswordHasher(baseConfig as any, trafficLoad);
  });

  afterEach(async () => {
    await hasher.onModuleDestroy();
  });

  it("khởi tạo Piscina với bcrypt.worker.js và maxThreads từ config", () => {
    expect(mockPiscinaConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringMatching(/bcrypt\.worker\.js$/),
        minThreads: 1,
        maxThreads: 4,
      }),
    );
  });

  it("hash() đẩy đúng payload sang Piscina worker", async () => {
    mockRun.mockResolvedValue("hashed_output");

    const result = await hasher.hash("plainSecret123");

    expect(mockRun).toHaveBeenCalledWith({
      op: "hash",
      plainPassword: "plainSecret123",
      rounds: 10,
    });
    expect(result).toBe("hashed_output");
  });

  it("compare() đẩy đúng payload sang Piscina worker", async () => {
    mockRun.mockResolvedValue(true);

    const result = await hasher.compare("plainSecret123", "hashed_output");

    expect(mockRun).toHaveBeenCalledWith({
      op: "compare",
      plainPassword: "plainSecret123",
      passwordHash: "hashed_output",
    });
    expect(result).toBe(true);
  });

  it("cho phép chạy tối đa N-1 (4) tác vụ song song khi không có API khác", async () => {
    const deferreds = [0, 1, 2, 3, 4].map(() => createDeferred<boolean>());
    let callIdx = 0;
    mockRun.mockImplementation(() => deferreds[callIdx++].promise);

    const promises = deferreds.map((_, i) =>
      hasher.compare(`pw-${i}`, "hash"),
    );

    // 4 tác vụ đầu được chạy ngay, tác vụ thứ 5 xếp vào waitQueue
    expect(mockRun).toHaveBeenCalledTimes(4);
    expect(hasher.getMetrics()).toMatchObject({
      inFlight: 4,
      queued: 1,
      currentLimit: 4,
    });

    // Hoàn tất tác vụ 0 -> tác vụ 5 lập tức được kéo ra chạy
    deferreds[0].resolve(true);
    await promises[0];
    expect(mockRun).toHaveBeenCalledTimes(5);

    for (let i = 1; i < deferreds.length; i++) {
      deferreds[i].resolve(true);
    }
    await Promise.all(promises);
    expect(hasher.getMetrics().inFlight).toBe(0);
    expect(hasher.getMetrics().queued).toBe(0);
  });

  it("tự giảm concurrency xuống floor((N-1)/2) khi có non-auth request và mở rộng lại khi xong", async () => {
    trafficLoad.increment(); // activeOtherRequests = 1 -> limit = floor(4/2) = 2

    const deferreds = [0, 1, 2, 3].map(() => createDeferred<boolean>());
    let callIdx = 0;
    mockRun.mockImplementation(() => deferreds[callIdx++].promise);

    const promises = deferreds.map((_, i) =>
      hasher.compare(`pw-${i}`, "hash"),
    );

    // Chỉ có 2 tác vụ được chạy song song, 2 tác vụ còn lại nằm chờ trong queue
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(hasher.getMetrics()).toMatchObject({
      inFlight: 2,
      queued: 2,
      currentLimit: 2,
    });

    // Non-auth request hoàn thành -> limit tăng lại lên 4, đánh thức ngay 2 tác vụ đang chờ!
    trafficLoad.decrement();
    expect(mockRun).toHaveBeenCalledTimes(4);
    expect(hasher.getMetrics()).toMatchObject({
      inFlight: 4,
      queued: 0,
      currentLimit: 4,
    });

    deferreds.forEach((d) => d.resolve(true));
    await Promise.all(promises);
  });

  it("giảm tiếp concurrency xuống 1 khi non-auth request đạt ngưỡng tải cao", async () => {
    for (let i = 0; i < 5; i++) {
      trafficLoad.increment();
    }

    const deferreds = [0, 1].map(() => createDeferred<boolean>());
    let callIdx = 0;
    mockRun.mockImplementation(() => deferreds[callIdx++].promise);

    const p1 = hasher.compare("pw-1", "hash");
    const p2 = hasher.compare("pw-2", "hash");

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(hasher.getMetrics()).toMatchObject({
      inFlight: 1,
      queued: 1,
      currentLimit: 1,
    });

    deferreds[0].resolve(true);
    await p1;
    expect(mockRun).toHaveBeenCalledTimes(2);

    deferreds[1].resolve(true);
    await p2;
  });

  it("ném ServiceUnavailableError (503) khi hàng đợi vượt maxQueue", async () => {
    trafficLoad.increment(); // limit = 2, maxQueue = 2

    const d1 = createDeferred<boolean>();
    const d2 = createDeferred<boolean>();
    const d3 = createDeferred<boolean>();
    const d4 = createDeferred<boolean>();
    const deferreds = [d1, d2, d3, d4];
    let idx = 0;
    mockRun.mockImplementation(() => deferreds[idx++].promise);

    const p1 = hasher.compare("1", "h"); // inFlight 1
    const p2 = hasher.compare("2", "h"); // inFlight 2
    const p3 = hasher.compare("3", "h"); // queue 1
    const p4 = hasher.compare("4", "h"); // queue 2 (đầy)

    await expect(hasher.compare("5", "h")).rejects.toThrow(
      ServiceUnavailableError,
    );

    d1.resolve(true);
    d2.resolve(true);
    d3.resolve(true);
    d4.resolve(true);
    await Promise.all([p1, p2, p3, p4]);
  });

  it("dọn dẹp pool.destroy() và reject tác vụ chờ khi onModuleDestroy()", async () => {
    trafficLoad.increment(); // limit = 2
    const d1 = createDeferred<boolean>();
    const d2 = createDeferred<boolean>();
    let idx = 0;
    mockRun.mockImplementation(() => [d1, d2][idx++].promise);

    const p1 = hasher.compare("1", "h");
    const p2 = hasher.compare("2", "h");
    const queuedPromise = hasher.compare("3", "h");

    await hasher.onModuleDestroy();

    await expect(queuedPromise).rejects.toThrow(ServiceUnavailableError);
    expect(mockDestroy).toHaveBeenCalledTimes(1);

    d1.resolve(true);
    d2.resolve(true);
    await Promise.all([p1, p2]);
  });
});
