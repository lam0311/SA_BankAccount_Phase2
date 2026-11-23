import * as os from "os";
import { registerAs } from "@nestjs/config";

function resolveDefaultBcryptMaxThreads(): number {
  const parallelism =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  // Luôn chừa ít nhất 1 core cho Main Event Loop của Node.js
  return Math.max(1, parallelism - 1);
}

/**
 * Dùng qua ConfigService: configService.get<number>('app.port')
 * (namespace 'app' tự động lấy từ tên tham số đầu tiên của registerAs).
 */
export default registerAs("app", () => ({
  port: parseInt(process.env.PORT ?? "3000", 10),
  globalPrefix: "api/v1",
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10),
  bcryptMaxThreads: process.env.BCRYPT_MAX_THREADS
    ? parseInt(process.env.BCRYPT_MAX_THREADS, 10)
    : resolveDefaultBcryptMaxThreads(),
  bcryptMaxQueue: parseInt(process.env.BCRYPT_MAX_QUEUE ?? "100", 10),
  bcryptHighTrafficThreshold: parseInt(
    process.env.BCRYPT_HIGH_TRAFFIC_THRESHOLD ?? "10",
    10,
  ),
  eventLoopMonitorIntervalMs: parseInt(
    process.env.EVENT_LOOP_MONITOR_INTERVAL_MS ?? "0",
    10,
  ),
}));
