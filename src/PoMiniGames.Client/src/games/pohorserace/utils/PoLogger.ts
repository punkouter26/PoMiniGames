/**
 * PoLogger.ts — Structured log emitter.
 * SOLID S: no formatting logic here; raw record passed to console.debug.
 * Silenced entirely in production builds.
 * Constitution Principle VI: zero-waste — no log retention, no side-effects.
 */

export type PoLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PoLogRecord {
  timestamp: string;         // ISO 8601
  level: PoLogLevel;
  service: string;           // e.g. 'PoSeedService', 'PoAudioService'
  action: string;            // e.g. 'seedLanes', 'playRimClack'
  durationMs?: number;       // optional — set for timed operations
  status: 'ok' | 'error';
  detail?: unknown;          // optional structured payload; MUST NOT contain PII
}

class PoLoggerSingleton {
  private readonly isProd = import.meta.env.PROD;

  log(record: PoLogRecord): void {
    if (this.isProd) return;
    console.debug('[PoLogger]', record);
  }
}

/** Exported singleton — import and call PoLogger.log(...) anywhere. */
export const PoLogger = new PoLoggerSingleton();
