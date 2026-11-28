import { AppError } from '@src/common/domain/errors/app.error';

export class AccountAlreadyClosedError extends AppError {
  readonly errorCode = 'ACCOUNT_NOT_ACTIVE';
  readonly httpStatus = 409;

  constructor(message = 'Account is closed') {
    super(message);
  }
}
