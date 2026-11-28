import { Injectable } from "@nestjs/common";

/**
 * Theo dõi số lượng HTTP request KHÔNG phải luồng auth (login/register)
 * đang được xử lý đồng thời để điều chỉnh động số luồng Bcrypt (Adaptive Bulkhead).
 *
 * Quy tắc phân bổ trên máy N cores (maxThreads mặc định = N - 1, chừa 1 core cho Event Loop):
 * - activeOtherRequests === 0                     -> maxThreads (N - 1)
 * - 1 <= activeOtherRequests < highTrafficThreshold -> Math.max(1, Math.floor(maxThreads / 2))
 * - activeOtherRequests >= highTrafficThreshold   -> 1 (tránh starvation cho login nhưng nhường tối đa CPU)
 */
@Injectable()
export class TrafficLoadService {
  private activeOtherRequests = 0;
  private readonly listeners = new Set<() => void>();

  increment(): void {
    this.activeOtherRequests += 1;
  }

  decrement(): void {
    if (this.activeOtherRequests <= 0) {
      this.activeOtherRequests = 0;
      return;
    }
    this.activeOtherRequests -= 1;
    this.notifyCapacityChange();
  }

  getActiveOtherRequests(): number {
    return this.activeOtherRequests;
  }

  getBcryptConcurrencyLimit(
    maxThreads: number,
    highTrafficThreshold = 10,
  ): number {
    const safeMax = Math.max(1, maxThreads);

    if (this.activeOtherRequests === 0) {
      return safeMax;
    }

    if (this.activeOtherRequests < highTrafficThreshold) {
      return Math.max(1, Math.floor(safeMax / 2));
    }

    return 1;
  }

  onCapacityChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyCapacityChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
