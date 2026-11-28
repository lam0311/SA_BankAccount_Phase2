import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import {
  AccessTokenPayload,
  TokenServicePort,
} from "@src/common/security/ports";
import { UnauthorizedError } from "@src/common/domain/errors";
import { jwtConfig } from "@src/common/config";
import {
  AUTH_SESSION_SERVICE,
  type AuthSessionPort,
} from "./redis-auth-session.service";

/**
 * Implementation THAT cua TokenServicePort (interface o common/).
 * Day la file bat buoc xong SOM NHAT trong ca du an - AccessTokenGuard (dung cho
 * MOI route protected cua ca 3 module) phu thuoc vao no qua DI token TOKEN_SERVICE.
 */
@Injectable()
export class JwtTokenService implements TokenServicePort {
  constructor(
    @Inject(jwtConfig.KEY)
    private readonly config: ConfigType<typeof jwtConfig>,
    @Optional()
    @Inject(AUTH_SESSION_SERVICE)
    private readonly authSession?: AuthSessionPort, // Nhận service Redis Session vào để tra sổ đen
  ) { }

  async signAccessToken(userId: string): Promise<string> {
    return jwt.sign(
      { sub: userId, jti: randomUUID() }, // Gắn thêm mã số seri jti duy nhất cho mỗi tờ Access Token
      this.config.accessSecret as string,
      {
        expiresIn: this.config.accessTtl,
        algorithm: "HS256",
      } as jwt.SignOptions,
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = jwt.verify(token, this.config.accessSecret as string) as {
        sub: string;
        jti?: string;
        exp?: number;
      };
      // Nếu token có mã jti, kiểm tra xem nó có bị đưa vào sổ đen chưa
      if (payload.jti && this.authSession) {
        const isRevoked = await this.authSession.isAccessTokenRevoked(payload.jti);
        if (isRevoked) throw new UnauthorizedError("INVALID_TOKEN");
      }
      return {
        sub: payload.sub,
        ...(payload.jti ? { jti: payload.jti } : {}),
        ...(payload.exp ? { exp: payload.exp } : {}),
      };
    } catch {
      throw new UnauthorizedError("INVALID_TOKEN");
    }
  }
}
