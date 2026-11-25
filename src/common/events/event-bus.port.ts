export const EVENT_BUS = Symbol('EVENT_BUS');

export interface IntegrationEvent<TPayload = unknown> {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly occurredAt: string;
}

export type EventHandler<TPayload = unknown> = (
  event: IntegrationEvent<TPayload>,
) => Promise<void>;

export interface EventBusPort {
  publish<TPayload = unknown>(event: IntegrationEvent<TPayload>): Promise<void>;
  subscribe<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): () => void;
}
