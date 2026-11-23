import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import { monitorEventLoopDelay } from "perf_hooks";
import appConfig from "@src/common/config/app.config";
import { TrafficLoadService } from "@src/common/concurrency";

const NS_PER_MS = 1_000_000;
type EventLoopHistogram = ReturnType<typeof monitorEventLoopDelay>;

@Injectable()
export class EventLoopMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopMonitorService.name);
  private histogram: EventLoopHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly trafficLoad: TrafficLoadService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.eventLoopMonitorIntervalMs ?? 0;
    if (intervalMs <= 0) {
      return;
    }

    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();

    this.timer = setInterval(() => {
      if (!this.histogram) return;
      const toMs = (ns: number) => (ns / NS_PER_MS).toFixed(2);
      this.logger.log(
        `EventLoopDelay(ms) mean=${toMs(this.histogram.mean)} p50=${toMs(this.histogram.percentile(50))} p95=${toMs(this.histogram.percentile(95))} p99=${toMs(this.histogram.percentile(99))} max=${toMs(this.histogram.max)} activeOtherRequests=${this.trafficLoad.getActiveOtherRequests()}`,
      );
      this.histogram.reset();
    }, intervalMs);

    // Không giữ tiến trình Node.js sống khi shutdown
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
  }
}
