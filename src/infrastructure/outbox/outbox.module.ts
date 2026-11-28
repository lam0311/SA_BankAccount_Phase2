import { Global, Module } from '@nestjs/common';
import { EVENT_BUS } from '@src/common/events';
import { PrismaModule } from '@src/infrastructure/prisma/prisma.module';
import { InProcessEventBus } from './in-process-event-bus';
import { OutboxRelayWorker } from './outbox-relay.worker';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    InProcessEventBus,
    {
      provide: EVENT_BUS,
      useExisting: InProcessEventBus,
    },
    OutboxService,
    OutboxRelayWorker,
  ],
  exports: [EVENT_BUS, OutboxService, OutboxRelayWorker],
})
export class OutboxModule {}
