/**
 * Structured JSON-lines logger. Non-blocking file sink (WriteStream) with size-based
 * rotation, optional console sink. Child loggers carry bound fields (e.g. syncId, conn).
 */
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  close(): Promise<void>;
}

export interface LoggerOptions {
  level?: LogLevel;
  file?: string;
  /** rotate when the file exceeds this many bytes (keeps one `.1` backup) */
  maxFileBytes?: number;
  console?: boolean;
  /** custom sink (tests, AE panel UI) */
  sink?: (line: string, level: LogLevel) => void;
}

interface Sink {
  write(line: string, level: LogLevel): void;
  close(): Promise<void>;
}

class FileSink implements Sink {
  private stream: WriteStream;
  private bytes: number;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.bytes = statSync(path).size;
    } catch {
      this.bytes = 0;
    }
    this.stream = this.open();
  }

  private open(): WriteStream {
    const s = createWriteStream(this.path, { flags: 'a' });
    s.on('error', () => {
      /* logging must never crash the host */
    });
    return s;
  }

  write(line: string): void {
    this.bytes += line.length + 1;
    if (this.bytes > this.maxBytes) {
      this.stream.end();
      try {
        renameSync(this.path, `${this.path}.1`);
      } catch {
        /* ignore */
      }
      this.bytes = line.length + 1;
      this.stream = this.open();
    }
    this.stream.write(`${line}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o, (_k, v: unknown) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
  } catch {
    return '{"msg":"<unserialisable log record>"}';
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = LEVELS[opts.level ?? 'info'];
  const sinks: Sink[] = [];
  if (opts.file) sinks.push(new FileSink(opts.file, opts.maxFileBytes ?? 10 * 1024 * 1024));
  if (opts.console) {
    sinks.push({
      write: (line, level) => (level === 'error' || level === 'warn' ? console.error(line) : console.log(line)),
      close: async () => undefined,
    });
  }
  if (opts.sink) {
    const fn = opts.sink;
    sinks.push({ write: fn, close: async () => undefined });
  }

  const make = (bound: LogFields): Logger => {
    const log = (level: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVELS[level] < min || sinks.length === 0) return;
      const line = safeStringify({ ts: new Date().toISOString(), level, msg, ...bound, ...fields });
      for (const s of sinks) s.write(line, level);
    };
    return {
      debug: (m, f) => log('debug', m, f),
      info: (m, f) => log('info', m, f),
      warn: (m, f) => log('warn', m, f),
      error: (m, f) => log('error', m, f),
      child: (f) => make({ ...bound, ...f }),
      close: async () => {
        await Promise.all(sinks.map((s) => s.close()));
      },
    };
  };
  return make({});
}

export const nullLogger: Logger = createLogger({});
