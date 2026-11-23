import { Global, Module } from "@nestjs/common";
import { TrafficLoadService } from "./traffic-load.service";

@Global()
@Module({
  providers: [TrafficLoadService],
  exports: [TrafficLoadService],
})
export class ConcurrencyModule {}
