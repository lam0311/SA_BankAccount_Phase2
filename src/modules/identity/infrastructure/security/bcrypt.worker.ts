import * as bcrypt from "bcrypt";

export type BcryptWorkerTask =
  | { op: "hash"; plainPassword: string; rounds: number }
  | { op: "compare"; plainPassword: string; passwordHash: string };

/**
 * Dedicated Piscina worker cho Bcrypt.
 *
 * Dùng bản đồng bộ (hashSync / compareSync) để tính toán trực tiếp trên chính
 * Worker Thread chuyên dụng này, KHÔNG đẩy ngược lại vào libuv thread pool dùng chung
 * của Main Thread.
 */
export default function runBcryptTask(
  task: BcryptWorkerTask,
): string | boolean {
  if (task.op === "hash") {
    return bcrypt.hashSync(task.plainPassword, task.rounds);
  }
  return bcrypt.compareSync(task.plainPassword, task.passwordHash);
}
