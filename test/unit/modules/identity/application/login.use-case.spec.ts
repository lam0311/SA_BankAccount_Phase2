import { LoginUseCase } from '@src/modules/identity/application/use-cases/login.use-case';
import { UserRepositoryPort } from '@src/modules/identity/application/ports/user.repository.port';
import { PasswordHasherPort } from '@src/modules/identity/application/ports/password-hasher.port';
import { TokenServicePort } from '@src/common/security/ports/token-service.port';
import { User } from '@src/modules/identity/domain/entities/user.entity';
import {
  AccountLockedError,
  InvalidCredentialsError,
} from '@src/modules/identity/domain/errors/identity.errors';
import { UnauthorizedError } from '@src/common/domain/errors';
import { RedisAuthSessionService } from '@src/modules/identity/infrastructure/security/redis-auth-session.service';

describe('LoginUseCase', () => {
  let useCase: LoginUseCase;
  let mockUserRepo: jest.Mocked<UserRepositoryPort>;
  let mockPasswordHasher: jest.Mocked<PasswordHasherPort>;
  let mockTokenService: jest.Mocked<TokenServicePort>;

  beforeEach(() => {
    mockUserRepo = {
      findByEmail: jest.fn(),
      create: jest.fn(),
    };
    mockPasswordHasher = {
      hash: jest.fn(),
      compare: jest.fn(),
    };
    mockTokenService = {
      signAccessToken: jest.fn(),
      verifyAccessToken: jest.fn(),
    };
    useCase = new LoginUseCase(mockUserRepo, mockPasswordHasher, mockTokenService);
  });

  it('đăng nhập thành công khi email và password đúng', async () => {
    const command = {
      email: ' Test@Example.COM ',
      password: 'Password123!',
    };

    const user = new User(
      'user-123',
      'test@example.com',
      'Nguyen Van A',
      'hashed_password',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
    );

    mockUserRepo.findByEmail.mockResolvedValue(user);
    mockPasswordHasher.compare.mockResolvedValue(true);
    mockTokenService.signAccessToken.mockResolvedValue('jwt.token.here');

    const result = await useCase.execute(command);

    expect(mockUserRepo.findByEmail).toHaveBeenCalledWith('test@example.com');
    expect(mockPasswordHasher.compare).toHaveBeenCalledWith(
      'Password123!',
      'hashed_password',
    );
    expect(mockTokenService.signAccessToken).toHaveBeenCalledWith('user-123');
    expect(result).toEqual({
      accessToken: 'jwt.token.here',
      user: {
        id: 'user-123',
        email: 'test@example.com',
        fullName: 'Nguyen Van A',
        createAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('ném InvalidCredentialsError khi email không tồn tại (vẫn gọi compare với dummy hash để chống timing attack)', async () => {
    const command = {
      email: 'notfound@example.com',
      password: 'Password123!',
    };

    mockUserRepo.findByEmail.mockResolvedValue(null);
    mockPasswordHasher.compare.mockResolvedValue(false);

    await expect(useCase.execute(command)).rejects.toThrow(InvalidCredentialsError);
    expect(mockPasswordHasher.compare).toHaveBeenCalled();
    expect(mockTokenService.signAccessToken).not.toHaveBeenCalled();
  });

  it('ném InvalidCredentialsError khi email đúng nhưng password sai', async () => {
    const command = {
      email: 'test@example.com',
      password: 'WrongPassword!',
    };

    const user = new User(
      'user-123',
      'test@example.com',
      'Nguyen Van A',
      'hashed_password',
      new Date(),
      new Date(),
    );

    mockUserRepo.findByEmail.mockResolvedValue(user);
    mockPasswordHasher.compare.mockResolvedValue(false);

    await expect(useCase.execute(command)).rejects.toThrow(InvalidCredentialsError);
    expect(mockTokenService.signAccessToken).not.toHaveBeenCalled();
  });

  it('hai trường hợp lỗi (email không tồn tại vs sai password) phải ném CÙNG một loại error và errorCode', async () => {
    mockUserRepo.findByEmail.mockResolvedValue(null);
    mockPasswordHasher.compare.mockResolvedValue(false);

    let error1: InvalidCredentialsError | null = null;
    try {
      await useCase.execute({ email: 'none@example.com', password: 'pw' });
    } catch (err) {
      error1 = err as InvalidCredentialsError;
    }

    const user = new User('id', 'exists@example.com', 'A', 'hash', new Date(), new Date());
    mockUserRepo.findByEmail.mockResolvedValue(user);

    let error2: InvalidCredentialsError | null = null;
    try {
      await useCase.execute({ email: 'exists@example.com', password: 'wrong' });
    } catch (err) {
      error2 = err as InvalidCredentialsError;
    }

    expect(error1).toBeInstanceOf(InvalidCredentialsError);
    expect(error2).toBeInstanceOf(InvalidCredentialsError);
    expect(error1?.errorCode).toBe(error2?.errorCode);
    expect(error1?.httpStatus).toBe(error2?.httpStatus);
  });

  describe('TSK-20: Refresh Rotation, Reuse Detection, Logout & Email Lockout', () => {
    let authSession: RedisAuthSessionService;
    let securedUseCase: LoginUseCase;

    beforeEach(() => {
      authSession = new RedisAuthSessionService();
      securedUseCase = new LoginUseCase(
        mockUserRepo,
        mockPasswordHasher,
        mockTokenService,
        authSession,
      );
    });

    it('khóa email (429 AccountLockedError) sau 5 lần sai mật khẩu liên tiếp', async () => {
      mockUserRepo.findByEmail.mockResolvedValue(null);
      mockPasswordHasher.compare.mockResolvedValue(false);

      for (let i = 0; i < 5; i++) {
        await expect(
          securedUseCase.execute({ email: 'victim@bank.com', password: 'wrong' }),
        ).rejects.toThrow(InvalidCredentialsError);
      }

      mockPasswordHasher.compare.mockClear();
      await expect(
        securedUseCase.execute({ email: 'victim@bank.com', password: 'wrong' }),
      ).rejects.toThrow(AccountLockedError);
      expect(mockPasswordHasher.compare).not.toHaveBeenCalled();
    });

    it('xoay vòng Refresh Token (RT1 -> RT2) và hủy cả phiên khi dùng lại RT1 cũ (Reuse Detection)', async () => {
      const user = new User('user-1', 'u@bank.com', 'User 1', 'hash', new Date(), new Date());
      mockUserRepo.findByEmail.mockResolvedValue(user);
      mockPasswordHasher.compare.mockResolvedValue(true);
      mockTokenService.signAccessToken.mockResolvedValue('access-1');

      const loginRes = await securedUseCase.execute({ email: 'u@bank.com', password: 'ok' });
      expect(loginRes.refreshToken).toBeDefined();

      mockTokenService.signAccessToken.mockResolvedValue('access-2');
      const rotated = await securedUseCase.refresh(loginRes.refreshToken!);
      expect(rotated.accessToken).toBe('access-2');
      expect(rotated.refreshToken).not.toBe(loginRes.refreshToken);

      // Dùng lại RT1 cũ -> 401 và xóa luôn cả family (RT2 cũng bị 401 theo)
      await expect(securedUseCase.refresh(loginRes.refreshToken!)).rejects.toThrow(UnauthorizedError);
      await expect(securedUseCase.refresh(rotated.refreshToken)).rejects.toThrow(UnauthorizedError);
    });

    it('logout thu hồi ngay jti của Access Token và hủy luôn Refresh Token', async () => {
      const rt = await authSession.issueRefreshToken('user-1');
      await securedUseCase.logout(
        { sub: 'user-1', jti: 'jti-123', exp: Math.floor(Date.now() / 1000) + 600 },
        rt,
      );

      await expect(authSession.isAccessTokenRevoked('jti-123')).resolves.toBe(true);
      await expect(securedUseCase.refresh(rt)).rejects.toThrow(UnauthorizedError);
    });
  });
});
