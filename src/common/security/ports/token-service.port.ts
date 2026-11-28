export interface AccessTokenPayload {
  sub: string; // userId
  jti?: string;
  exp?: number;
}

export const TOKEN_SERVICE = Symbol("TOKEN_SERVICE");

export interface TokenServicePort {
  signAccessToken(userId: string): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenPayload>;
}
