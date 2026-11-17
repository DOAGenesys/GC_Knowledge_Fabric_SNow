import type { LogLevel, LogRecord } from "@/server/log";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Log records captured by the test sink (see tests/setup/unit.ts). */
export const capturedLogs = {
  records: [] as LogRecord[],

  clear(): void {
    this.records = [];
  },

  push(record: LogRecord): void {
    this.records.push(record);
  },

  atLeast(level: LogLevel): LogRecord[] {
    return this.records.filter((record) => RANK[record.level] >= RANK[level]);
  },

  withMessage(message: string | RegExp): LogRecord[] {
    return this.records.filter((record) => (typeof message === "string" ? record.msg === message : message.test(record.msg)));
  },

  /** Every record serialized, for "this value must never be logged" assertions. */
  serialized(): string {
    return this.records.map((record) => JSON.stringify(record)).join("\n");
  },
};
