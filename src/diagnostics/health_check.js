import { runDiagnostics } from './onboarding.js';
import { telemetry } from '../utils/telemetry.js';

export const runHealthCheck = async () => {
  const result = await runDiagnostics({
    autoFix: false,
    skipPull: true,
    skipSelfCheck: true,
    reportPath: null,
    silent: true,
    context: 'healthcheck',
  });

  return {
    status: result.success ? 'ok' : 'degraded',
    friction: result.friction,
    metrics: telemetry.getSummary(),
  };
};
