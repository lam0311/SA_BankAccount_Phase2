// src/modules/identity/identity.module.ts
import { Module } from "@nestjs/common";
import { TOKEN_SERVICE, type TokenServicePort } from "@src/common/security/ports";
import { AuthController } from "./presentation/http/auth.controller";
import { RegisterUserUseCase } from "./application/use-cases/register-user.use-case";
import { LoginUseCase } from "./application/use-cases/login.use-case";
import { USER_REPOSITORY, type UserRepositoryPort } from "./application/ports/user.repository.port";
import { PASSWORD_HASHER, type PasswordHasherPort } from "./application/ports/password-hasher.port";
import { PrismaUserRepository } from "./infrastructure/persistence/prisma-user.repository";
import { BcryptPasswordHasher } from "./infrastructure/security/bcrypt-password-hasher";
import { JwtTokenService } from "./infrastructure/security/jwt-token.service";
import {
  AUTH_SESSION_SERVICE,
  type AuthSessionPort,
  RedisAuthSessionService,
} from "./infrastructure/security/redis-auth-session.service";
@Module({
  // PrismaModule la @Global() nen khong can import lai o day.
  controllers: [AuthController],
  providers: [
    RedisAuthSessionService,                                                // Khởi tạo service Redis Session
    { provide: AUTH_SESSION_SERVICE, useExisting: RedisAuthSessionService }, // Gắn nhãn AUTH_SESSION_SERVICE
    {
      provide: RegisterUserUseCase,
      useFactory: (repository: UserRepositoryPort, hasher: PasswordHasherPort) =>
        new RegisterUserUseCase(repository, hasher),
      inject: [USER_REPOSITORY, PASSWORD_HASHER],
    },
    {
      provide: LoginUseCase,
      useFactory: (
        repository: UserRepositoryPort,
        hasher: PasswordHasherPort,
        tokens: TokenServicePort,
        authSession: AuthSessionPort, // Nhận authSession
      ) => new LoginUseCase(repository, hasher, tokens, authSession), // Truyền vào tham số thứ 4
      inject: [USER_REPOSITORY, PASSWORD_HASHER, TOKEN_SERVICE, AUTH_SESSION_SERVICE],
    },
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    BcryptPasswordHasher,
    { provide: PASSWORD_HASHER, useExisting: BcryptPasswordHasher },
    JwtTokenService,
    { provide: TOKEN_SERVICE, useExisting: JwtTokenService },
  ],
  // export TOKEN_SERVICE cho AccessTokenGuard, BcryptPasswordHasher cho HealthModule va AUTH_SESSION_SERVICE
  exports: [TOKEN_SERVICE, BcryptPasswordHasher, AUTH_SESSION_SERVICE],
})
export class IdentityModule { }
