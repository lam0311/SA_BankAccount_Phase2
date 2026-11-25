import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import Redis from "ioredis";
import { jwtConfig, redisConfig } from "@src/common/config";
import { UnauthorizedError } from "@src/common/domain/errors";
import { AccountLockedError } from "@src/modules/identity/domain/errors";

export const AUTH_SESSION_SERVICE = Symbol("AUTH_SESSION_SERVICE"); // Nhãn DI để NestJS inject service này

export interface RotateRefreshResult {
    userId: string;
    refreshToken: string;
}

export interface AuthSessionPort {
    assertNotLocked(email: string): Promise<void>;
    recordLoginFailure(email: string): Promise<void>;
    clearLoginFailures(email: string): Promise<void>;
    issueRefreshToken(userId: string, existingFamilyId?: string): Promise<string>;
    rotateRefreshToken(rawRefreshToken: string): Promise<RotateRefreshResult>;
    revokeRefreshToken(rawRefreshToken: string): Promise<void>;
    revokeAccessToken(jti: string, ttlSeconds: number): Promise<void>;
    isAccessTokenRevoked(jti: string): Promise<boolean>;
}

const MAX_FAILED_ATTEMPTS = 5;     // Sai tối đa 5 lần
const FAIL_WINDOW_SECONDS = 900;   // Trong vòng 15 phút
const LOCK_DURATION_SECONDS = 300; // Khóa tài khoản 5 phút 

// Hàm băm giúp không lưu email thô hay refresh token thô vào Redis
function sha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

@Injectable()
export class RedisAuthSessionService implements AuthSessionPort, OnModuleDestroy {
    private readonly logger = new Logger(RedisAuthSessionService.name);
    private readonly redisClient?: Redis;
    private readonly refreshTtlSeconds: number;
    // Map dự phòng trên RAM khi tắt Docker Redis hoặc chạy Unit Test
    private readonly memStore = new Map<string, { value: string; expiresAtMs: number }>();

    constructor(
        @Optional() @Inject(redisConfig.KEY) private readonly redisCfg?: ConfigType<typeof redisConfig>,
        @Optional() @Inject(jwtConfig.KEY) private readonly jwtCfg?: ConfigType<typeof jwtConfig>,
    ) {
        this.refreshTtlSeconds = this.jwtCfg?.refreshTtl ?? 7200; // Mặc định 2 tiếng 
        if (this.redisCfg) {
            this.redisClient = new Redis({
                host: this.redisCfg.host,
                port: this.redisCfg.port,
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                connectTimeout: 2000,
                enableOfflineQueue: false,
            });
            this.redisClient.connect().catch((err) => {
                this.logger.warn(`Redis auth unavailable (${err.message}), using RAM fallback.`);
            });
        }
    }

    // hàm đọc key từ Redis hoặc Map dự phòng
    private async getKey(key: string): Promise<string | null> {
        if (this.redisClient?.status === "ready") return this.redisClient.get(key);
        const entry = this.memStore.get(key);
        if (!entry || entry.expiresAtMs <= Date.now()) {
            this.memStore.delete(key);
            return null;
        }
        return entry.value;
    }

    // hàm ghi key vào Redis hoặc Map dự phòng
    private async setKey(key: string, value: string, ttlSeconds: number): Promise<void> {
        const ttl = Math.max(1, Math.floor(ttlSeconds));
        if (this.redisClient?.status === "ready") {
            await this.redisClient.set(key, value, "EX", ttl);
            return;
        }
        this.memStore.set(key, { value, expiresAtMs: Date.now() + ttl * 1000 });
    }

    // hàm xóa key khỏi Redis hoặc Map dự phòng
    private async delKey(key: string): Promise<void> {
        if (this.redisClient?.status === "ready") {
            await this.redisClient.del(key);
            return;
        }
        this.memStore.delete(key);
    }

    // khóa vét cạn  => 5 lần sai trong 15 phút -> khóa 5 phút
    async assertNotLocked(email: string): Promise<void> {
        const locked = await this.getKey(`auth:lock:${sha256(email)}`); // Xem email này có đang bị treo biển khóa không
        if (locked) throw new AccountLockedError(LOCK_DURATION_SECONDS); // Có thì cấm ngay
    }

    // Ghi nhận 1 lần đăng nhập thất bại
    async recordLoginFailure(email: string): Promise<void> {
        const hash = sha256(email);
        const failKey = `auth:fail:${hash}`;
        const current = Number((await this.getKey(failKey)) ?? "0") + 1; // tăng số lần sai lên 1
        if (current >= MAX_FAILED_ATTEMPTS) {
            await this.setKey(`auth:lock:${hash}`, "1", LOCK_DURATION_SECONDS); // đủ 5 lần thì Khóa 5 phút
            await this.delKey(failKey);                                         // xóa biến đếm
        } else {
            await this.setKey(failKey, String(current), FAIL_WINDOW_SECONDS);   // Chưa đủ 5 thì Lưu số lần sai 
        }
    }

    // Xóa lịch sử đăng nhập thất bại khi đăng nhập đúng
    async clearLoginFailures(email: string): Promise<void> {
        await this.delKey(`auth:fail:${sha256(email)}`);
    }

    // blacklist thu hồi access token khi logout hoặc refresh token bị xoay vòng
    async revokeAccessToken(jti: string, ttlSeconds: number): Promise<void> {
        await this.setKey(`auth:bl:jti:${jti}`, "1", ttlSeconds); // Ghi số seri jti vào sổ đen cho tới khi token hết hạn
    }

    // Kiểm tra xem access token có bị thu hồi hay không
    async isAccessTokenRevoked(jti: string): Promise<boolean> {
        return (await this.getKey(`auth:bl:jti:${jti}`)) === "1"; // Kiểm tra xem jti có nằm trong sổ đen không
    }

    // Cấp phát refresh token mới
    async issueRefreshToken(userId: string, existingFamilyId?: string): Promise<string> {
        const familyId = existingFamilyId ?? randomUUID(); // Mã phiên đăng nhập 
        const tokenId = randomUUID();                      // Mã của lần cấp vé này
        const rawValue = randomBytes(32).toString("hex");  // Chuỗi bí mật ngẫu nhiên
        // Lưu vé đang hoạt động của phiên này lên Redis trong 2 tiếng
        await this.setKey(
            `auth:family:${familyId}`,
            JSON.stringify({ userId, activeTokenId: tokenId, tokenHash: sha256(rawValue) }),
            this.refreshTtlSeconds,
        );
        return `${familyId}.${tokenId}.${rawValue}`;
    }

    // Xoay vòng refresh token: cấp vé mới trong cùng familyId, thu hồi vé cũ
    async rotateRefreshToken(rawRefreshToken: string): Promise<RotateRefreshResult> {
        const [familyId, tokenId, rawValue] = rawRefreshToken.trim().split(".");
        if (!familyId || !tokenId || !rawValue) {
            throw new UnauthorizedError("INVALID_TOKEN"); // Sai định dạng 3 phần
        }

        const rawJson = await this.getKey(`auth:family:${familyId}`);
        if (!rawJson) {
            throw new UnauthorizedError("INVALID_TOKEN"); // Phiên đã hết hạn hoặc đã bị hủy 
        }

        const session = JSON.parse(rawJson) as { userId: string; activeTokenId: string; tokenHash: string };

        // Nếu tokenId gửi lên khác với activeTokenId hiện tại thì vé cũ bị mang ra dùng lại!
        if (session.activeTokenId !== tokenId) {
            await this.delKey(`auth:family:${familyId}`); // Xóa sổ toàn bộ phiên đăng nhập này ngay lập tức!
            throw new UnauthorizedError("INVALID_TOKEN"); // Cảnh báo: token cũ bị mang ra dùng lại
        }

        if (session.tokenHash !== sha256(rawValue)) {
            throw new UnauthorizedError("INVALID_TOKEN"); // Sai chuỗi bí mật 
        }

        // Vé hợp lệ thì cấp vé mới trong cùng familyId 
        const newRefreshToken = await this.issueRefreshToken(session.userId, familyId);
        return { userId: session.userId, refreshToken: newRefreshToken };
    }

    async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
        const [familyId] = rawRefreshToken.trim().split(".");
        if (familyId) await this.delKey(`auth:family:${familyId}`); // Khi Logout: xóa luôn phiên familyId
    }

    async onModuleDestroy(): Promise<void> {
        if (this.redisClient?.status === "ready") await this.redisClient.quit();
    }
}