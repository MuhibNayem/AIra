import { EventEmitter } from 'events';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';

const NANOSECONDS_IN_MILLISECOND = 1_000_000n;

const now = () => process.hrtime.bigint();

const toMilliseconds = (startedAt) => {
  if (typeof startedAt !== 'bigint') {
    return 0;
  }
  const diff = process.hrtime.bigint() - startedAt;
  return Number(diff / NANOSECONDS_IN_MILLISECOND);
};

const safeStringify = (payload) => {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ error: 'Failed to serialize telemetry payload.' });
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));

export class Telemetry extends EventEmitter {
  constructor({ metricsPath = process.env.AIRA_METRICS_PATH, registerExitHandler = true } = {}) {
    super();
    this.metrics = {
      turns: { total: 0, failed: 0, totalDurationMs: 0 },
      tools: { total: 0, failed: 0, totalDurationMs: 0 },
      diagnostics: { total: 0, failed: 0, totalDurationMs: 0 },
    };
    this.pendingTools = new Map();
    this.stream = null;
    this._exitHandler = null;

    this.configureStream(metricsPath);

    if (registerExitHandler) {
      this._exitHandler = () => {
        try {
          this.close();
        } catch {
          // no-op
        }
      };
      process.on('exit', this._exitHandler);
    }
  }

  configureStream(metricsPath) {
    if (!metricsPath) {
      return;
    }

    try {
      mkdirSync(path.dirname(metricsPath), { recursive: true });
      this.stream = createWriteStream(metricsPath, { flags: 'a' });
    } catch (error) {
      console.error(`AIra telemetry: failed to open metrics stream at ${metricsPath}`, error.message);
      this.stream = null;
    }
  }

  write(event) {
    const payload = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    if (this.stream) {
      try {
        this.stream.write(`${safeStringify(payload)}\n`);
      } catch (error) {
        console.error('AIra telemetry: failed to write metrics event.', error.message);
      }
    }

    if (process.env.AIRA_DEBUG_TELEMETRY === '1') {
      // eslint-disable-next-line no-console
      console.debug('[telemetry]', payload);
    }

    this.emit('event', payload);
  }

  recordTurn({ sessionId, durationMs, success, inputTokens = 0, outputTokens = 0, error } = {}) {
    this.metrics.turns.total += 1;
    this.metrics.turns.totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0;
    if (!success) {
      this.metrics.turns.failed += 1;
    }
    this.write({
      type: 'turn',
      sessionId,
      durationMs,
      success,
      inputTokens,
      outputTokens,
      error,
    });
  }

  startToolInvocation({ id, name, sessionId } = {}) {
    const key = id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingTools.set(key, {
      metadata: { id, name, sessionId },
      startedAt: now(),
    });
    return key;
  }

  finishToolInvocation(key, { success = true, error } = {}) {
    const entry = key ? this.pendingTools.get(key) : null;
    if (!entry) {
      return;
    }

    this.pendingTools.delete(key);
    const durationMs = toMilliseconds(entry.startedAt);

    this.metrics.tools.total += 1;
    this.metrics.tools.totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0;
    if (!success) {
      this.metrics.tools.failed += 1;
    }

    this.write({
      type: 'tool',
      name: entry.metadata?.name,
      sessionId: entry.metadata?.sessionId,
      durationMs,
      success,
      error,
    });
  }

  recordDiagnosticsRun({ success, frictionCount = 0, durationMs, context = 'onboarding', error } = {}) {
    this.metrics.diagnostics.total += 1;
    this.metrics.diagnostics.totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0;
    if (!success) {
      this.metrics.diagnostics.failed += 1;
    }

    this.write({
      type: 'diagnostics',
      success,
      frictionCount,
      durationMs,
      context,
      error,
    });
  }

  getSummary() {
    return clone(this.metrics);
  }

  close() {
    if (this._exitHandler) {
      process.off('exit', this._exitHandler);
      this._exitHandler = null;
    }
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.pendingTools.clear();
  }
}

export const telemetry = new Telemetry();
