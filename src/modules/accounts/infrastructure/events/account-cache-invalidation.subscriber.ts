import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  ACCOUNT_EVENTS,
  type AccountBalanceChangedEventPayload,
  type AccountClosedEventPayload,
  type AccountOpenedEventPayload,
  EVENT_BUS,
  type EventBusPort,
} from '@src/common/events';
import {
  ACCOUNT_CACHE,
  type AccountCachePort,
} from '../../application/ports/account-cache.port';

@Injectable()
export class AccountCacheInvalidationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    @Inject(EVENT_BUS)
    private readonly eventBus: EventBusPort,
    @Inject(ACCOUNT_CACHE)
    private readonly accountCache: AccountCachePort,
  ) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.eventBus.subscribe<AccountOpenedEventPayload>(
        ACCOUNT_EVENTS.OPENED,
        async (event) => {
          await this.accountCache.invalidateUserLists(event.payload.userId, {
            throwOnError: true,
          });
        },
      ),
      this.eventBus.subscribe<AccountClosedEventPayload>(
        ACCOUNT_EVENTS.CLOSED,
        async (event) => {
          await this.accountCache.invalidateAccount(
            {
              id: event.payload.accountId,
              userId: event.payload.userId,
              accountNumber: event.payload.accountNumber,
            },
            { throwOnError: true },
          );
        },
      ),
      this.eventBus.subscribe<AccountBalanceChangedEventPayload>(
        ACCOUNT_EVENTS.BALANCE_CHANGED,
        async (event) => {
          await Promise.all(
            event.payload.accounts.map((account) =>
              this.accountCache.invalidateAccount(
                {
                  id: account.accountId,
                  userId: account.userId,
                  accountNumber: account.accountNumber,
                },
                { throwOnError: true },
              ),
            ),
          );
        },
      ),
    );
  }

  onModuleDestroy(): void {
    while (this.unsubscribers.length > 0) {
      const unsubscribe = this.unsubscribers.pop();
      unsubscribe?.();
    }
  }
}
