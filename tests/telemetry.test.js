import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Telemetry } from '../src/utils/telemetry.js';
import * as fsModule from 'fs';

const originalDebug = process.env.AIRA_DEBUG_TELEMETRY;

beforeEach(() => {
  delete process.env.AIRA_DEBUG_TELEMETRY;
});

afterEach(() => {
  if (originalDebug === undefined) {
    delete process.env.AIRA_DEBUG_TELEMETRY;
  } else {
    process.env.AIRA_DEBUG_TELEMETRY = originalDebug;
  }
  vi.restoreAllMocks();
});

describe('Telemetry', () => {
  it('records turns and tool invocations', () => {
    const telemetry = new Telemetry({ registerExitHandler: false });

    telemetry.recordTurn({
      sessionId: 'test-session',
      durationMs: 12,
      success: true,
      inputTokens: 10,
      outputTokens: 20,
    });

    const turnSummary = telemetry.getSummary();
    expect(turnSummary.turns.total).toBe(1);
    expect(turnSummary.turns.failed).toBe(0);
    expect(turnSummary.turns.totalDurationMs).toBeGreaterThan(0);

    const key = telemetry.startToolInvocation({
      name: 'testTool',
      sessionId: 'test-session',
    });
    telemetry.finishToolInvocation(key, { success: false, error: 'boom' });
    telemetry.finishToolInvocation('missing-key', { success: true });

    const updatedSummary = telemetry.getSummary();
    expect(updatedSummary.tools.total).toBe(1);
    expect(updatedSummary.tools.failed).toBe(1);

    telemetry.recordTurn({ sessionId: 'test', durationMs: 5, success: false, error: 'fail' });
    const failureSummary = telemetry.getSummary();
    expect(failureSummary.turns.failed).toBe(1);

    telemetry.close();
  });

  it('records diagnostics and writes to metrics sink', async () => {
    const metricsPath = path.join(os.tmpdir(), `telemetry-${process.pid}-${Date.now()}.log`);
    const telemetry = new Telemetry({ metricsPath, registerExitHandler: false });

    telemetry.recordDiagnosticsRun({
      success: false,
      frictionCount: 2,
      durationMs: 45,
      context: 'smoke',
      error: 'failed',
    });

    const summary = telemetry.getSummary();
    expect(summary.diagnostics.total).toBe(1);
    expect(summary.diagnostics.failed).toBe(1);

    const stream = telemetry.stream;
    telemetry.close();
    if (stream) {
      await new Promise((resolve) => stream.once('finish', resolve));
    }

    const payload = await fs.readFile(metricsPath, 'utf-8');
    expect(payload).toMatch(/"type":"diagnostics"/);
    await fs.rm(metricsPath, { force: true });
  });

  it('handles stream initialization failures gracefully', async () => {
    const blockingFile = path.join(os.tmpdir(), `telemetry-block-${process.pid}`);
    await fs.writeFile(blockingFile, 'content', 'utf-8');
    const obstructedPath = path.join(blockingFile, 'metrics.jsonl');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const telemetry = new Telemetry({ metricsPath: obstructedPath, registerExitHandler: false });
    expect(telemetry.stream).toBeNull();
    telemetry.close();
    consoleSpy.mockRestore();
    await fs.rm(blockingFile, { force: true });
  });

  it('emits debug output when enabled', () => {
    process.env.AIRA_DEBUG_TELEMETRY = '1';
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const telemetry = new Telemetry({ registerExitHandler: false });
    telemetry.write({ type: 'test', message: 'hello' });
    expect(consoleSpy).toHaveBeenCalled();
    telemetry.close();
    consoleSpy.mockRestore();
  });

  it('ignores unknown tool finish keys', () => {
    const telemetry = new Telemetry({ registerExitHandler: false });
    expect(() => telemetry.finishToolInvocation('missing', { success: true })).not.toThrow();
    telemetry.close();
  });

  it('closes registered exit handlers and drains streams', () => {
    const telemetry = new Telemetry({ registerExitHandler: true });
    telemetry.stream = { write: vi.fn(), end: vi.fn() };
    telemetry._exitHandler();
    expect(telemetry.stream).toBeNull();
  });

  it('reports stream write failures', () => {
    const telemetry = new Telemetry({ registerExitHandler: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    telemetry.stream = {
      write: () => {
        throw new Error('write boom');
      },
      end: vi.fn(),
    };
    telemetry.write({ type: 'test' });
    expect(errorSpy).toHaveBeenCalledWith(
      'AIra telemetry: failed to write metrics event.',
      expect.any(String),
    );
    telemetry.close();
    errorSpy.mockRestore();
  });
});
