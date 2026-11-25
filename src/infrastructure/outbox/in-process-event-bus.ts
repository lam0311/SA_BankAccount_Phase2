import { Injectable } from '@nestjs/common';
import type {
  EventBusPort,
  EventHandler,
  IntegrationEvent,
} from '@src/common/events';

@Injectable()
export class InProcessEventBus implements EventBusPort {
  private readonly handlers = new Map<string, Set<EventHandler<any>>>();

  subscribe<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): () => void {
    let bucket = this.handlers.get(eventType);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(eventType, bucket);
    }
    bucket.add(handler);

    return () => {
      const current = this.handlers.get(eventType);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(eventType);
      }
    };
  }

  async publish<TPayload = unknown>(
    event: IntegrationEvent<TPayload>,
  ): Promise<void> {
    const bucket = this.handlers.get(event.eventType);
    if (!bucket || bucket.size === 0) {
      return;
    }

    const tasks = Array.from(bucket).map((handler) => handler(event));
    await Promise.all(tasks);
  }
}
