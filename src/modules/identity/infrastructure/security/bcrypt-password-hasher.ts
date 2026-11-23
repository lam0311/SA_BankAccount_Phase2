import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import * as os from "os";
import * as path from "path";
import Piscina from "piscina";
import appConfig from "@src/common/config/app.config";
import { TrafficLoadService } from "@src/common/concurrency";
import { ServiceUnavailableError } from "@src/common/domain/errors";
import { PasswordHasherPort } from "../../application/ports/password-hasher.port";
import type { BcryptWorkerTask } from "./bcrypt.worker";

interface QueuedTask<T> {
  task: BcryptWorkerTask;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export interface BcryptPoolMetrics {
  inFlight: number;
  queued: number;
  maxThreads: number;
  currentLimit: number;
  activeOtherRequests: number;
}

@Injectable()
export class BcryptPasswordHasher
  implements PasswordHasherPort, OnModuleDestroy
{
  private readonly logger = new Logger(BcryptPasswordHasher.name);
  private readonly pool: Piscina;
  private readonly maxThreads: number;
  private readonly maxQueue: number;
  private readonly highTrafficThreshold: number;
  private readonly waitQueue: QueuedTask<any>[] = [];
  private readonly unsubscribeLoad: () => void;
  private inFlight = 0;
  private isDestroyed = false;

  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly trafficLoad: TrafficLoadService,
  ) {
    const defaultMaxThreads = Math.max(
      1,
      (typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length) - 1,
    );

    this.maxThreads = Math.max(
      1,
      this.config.bcryptMaxThreads ?? defaultMaxThreads,
    );
    this.maxQueue = Math.max(1, this.config.bcryptMaxQueue ?? 100);
    this.highTrafficThreshold = Math.max(
      2,
      this.config.bcryptHighTrafficThreshold ?? 10,
    );

    this.pool = new Piscina({
      filename: path.resolve(__dirname, "bcrypt.worker.js"),
      minThreads: 1,
      maxThreads: this.maxThreads,
      idleTimeout: 30_000,
    });

    // Khi các API khác xử lý xong, đánh thức ngay các tác vụ Bcrypt đang chờ
    this.unsubscribeLoad = this.trafficLoad.onCapacityChange(() => {
      this.drainQueue();
    });

    this.logger.log(
      `Initialized Piscina bcrypt worker pool (maxThreads=${this.maxThreads}, maxQueue=${this.maxQueue}, highTrafficThreshold=${this.highTrafficThreshold})`,
    );
  }

  async hash(plainPassword: string): Promise<string> {
    return this.enqueue<string>({
      op: "hash",
      plainPassword,
      rounds: this.config.bcryptRounds,
    });
  }

  async compare(plainPassword: string, passwordHash: string): Promise<boolean> {
    return this.enqueue<boolean>({
      op: "compare",
      plainPassword,
      passwordHash,
    });
  }

  getMetrics(): BcryptPoolMetrics {
    return {
      inFlight: this.inFlight,
      queued: this.waitQueue.length,
      maxThreads: this.maxThreads,
      currentLimit: this.getCurrentLimit(),
      activeOtherRequests: this.trafficLoad.getActiveOtherRequests(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.isDestroyed = true;
    this.unsubscribeLoad();

    while (this.waitQueue.length > 0) {
      const pending = this.waitQueue.shift()!;
      pending.reject(
        new ServiceUnavailableError("Authentication worker pool is shutting down"),
      );
    }

    await this.pool.destroy();
  }

  private getCurrentLimit(): number {
    return this.trafficLoad.getBcryptConcurrencyLimit(
      this.maxThreads,
      this.highTrafficThreshold,
    );
  }

  private enqueue<T>(task: BcryptWorkerTask): Promise<T> {
    if (this.isDestroyed) {
      return Promise.reject(
        new ServiceUnavailableError("Authentication worker pool is shutting down"),
      );
    }

    if (this.waitQueue.length === 0 && this.inFlight < this.getCurrentLimit()) {
      return this.dispatch<T>(task);
    }

    if (this.waitQueue.length >= this.maxQueue) {
      return Promise.reject(
        new ServiceUnavailableError(
          "Authentication service is temporarily overloaded, please try again later",
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.waitQueue.push({ task, resolve, reject });
    });
  }

  private async dispatch<T>(task: BcryptWorkerTask): Promise<T> {
    this.inFlight += 1;
    try {
      return (await this.pool.run(task)) as T;
    } finally {
      this.inFlight -= 1;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (
      !this.isDestroyed &&
      this.waitQueue.length > 0 &&
      this.inFlight < this.getCurrentLimit()
    ) {
      const next = this.waitQueue.shift()!;
      this.dispatch(next.task).then(next.resolve, next.reject);
    }
  }
}
