import { AppError } from "@src/common/domain/errors";

export class EmailAlreadyExistsError extends AppError {
  readonly errorCode = "EMAIL_EXISTS";
  readonly httpStatus = 409;
  constructor() {
    super("Email is already registered");
  }
}
/**
 * Dung CHUNG cho ca 2 truong hop "email khong ton tai" va "sai password"
 * (BR-AUTH: tra cung mot loi 401, khong tiet lo email co ton tai hay khong).
 */
export class InvalidCredentialsError extends AppError {
  readonly errorCode = "INVALID_CREDENTIALS";
  readonly httpStatus = 401;
  constructor() {
    super("Email or password is incorrect");
  }
}

export class AccountLockedError extends AppError {
  readonly errorCode = "ACCOUNT_LOCKED";
  readonly httpStatus = 429;
  constructor(retryAfterSeconds = 300) {
    super(
      `Account is temporarily locked due to too many failed login attempts. Try again in ${retryAfterSeconds} seconds`,
    );
  }
}
