import type { AccessTokenPayload, TokenServicePort } from "@src/common/security/ports";
import type {
  UserRepositoryPort,
  PasswordHasherPort,
} from "@src/modules/identity/application/ports";
import { InvalidCredentialsError } from "@src/modules/identity/domain/errors";
import { AuthSessionPort } from "../../infrastructure/security/redis-auth-session.service";

export interface LoginCommand {
  email: string;
  password: string;
}
// Hash bcrypt gia dung khi user khong ton tai, de bcrypt.compare van ton thoi gian
// tinh toan tuong duong truong hop user ton tai - giam kha nang do email qua timing.
const DUMMY_HASH =
  "$2b$12$CwTycUXWue0Thq9StjUM0uJ8i6ByfLwqOAn9d.Xz3.dK5xj5v5x5e";

export class LoginUseCase {
  constructor(
    private readonly userRepository: UserRepositoryPort,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly tokenService: TokenServicePort,
    private readonly authSession?: AuthSessionPort,
  ) { }

  async execute(dto: LoginCommand) {
    const normalizedEmail = dto.email.trim().toLowerCase();

    await this.authSession?.assertNotLocked(normalizedEmail);

    const user = await this.userRepository.findByEmail(normalizedEmail);

    // QUAN TRONG: du user co ton tai hay khong, van phai throw DUNG 1 loai loi
    // giong het nhau - khong re nhanh som de tranh tiet lo "email nay co ton tai
    // trong he thong khong" qua noi dung/hanh vi loi.
    const isPasswordValid = user
      ? await this.passwordHasher.compare(dto.password, user.passwordHash)
      : await this.passwordHasher.compare(dto.password, DUMMY_HASH);

    if (!user || !isPasswordValid) {
      await this.authSession?.recordLoginFailure(normalizedEmail);
      throw new InvalidCredentialsError();
    }

    await this.authSession?.clearLoginFailures(normalizedEmail);


    const accessToken = await this.tokenService.signAccessToken(user.id);
    const refreshToken = await this.authSession?.issueRefreshToken(user.id);

    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      user: user.toSafeObject(),
    };
  }

  // dùng refresh token để lấy access token mới đồng thời xóa refresh token cũ
  async refresh(rawRefreshToken: string) {
    if (!this.authSession) throw new InvalidCredentialsError();
    const { userId, refreshToken } = await this.authSession.rotateRefreshToken(rawRefreshToken);
    const accessToken = await this.tokenService.signAccessToken(userId);
    return { accessToken, refreshToken };
  }

  // logout: thu hồi access token và refresh token
  async logout(currentUser: AccessTokenPayload, rawRefreshToken?: string) {
    if (this.authSession && currentUser.jti) {
      const nowSec = Math.floor(Date.now() / 1000);
      const ttl = currentUser.exp && currentUser.exp > nowSec ? currentUser.exp - nowSec : 900;
      await this.authSession.revokeAccessToken(currentUser.jti, ttl);
    }
    if (this.authSession && rawRefreshToken) {
      await this.authSession.revokeRefreshToken(rawRefreshToken);
    }
    return { loggedOut: true };
  }

}
