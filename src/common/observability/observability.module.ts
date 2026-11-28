import { Global, Module } from "@nestjs/common";
import { LoggerService } from "./logger.service";
import { EventLoopMonitorService } from "./event-loop-monitor.service";

@Global()
@Module({
  providers: [LoggerService, EventLoopMonitorService],
  exports: [LoggerService, EventLoopMonitorService],
})
export class ObservabilityModule {}
