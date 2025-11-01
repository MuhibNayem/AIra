const LEVELS = ['error', 'warn', 'info', 'debug'];

const normalizeLevel = (level) => {
  if (!level) {
    return 'info';
  }
  const lower = level.toLowerCase();
  return LEVELS.includes(lower) ? lower : 'info';
};

const resolveLogLevel = () => normalizeLevel(process.env.AIRA_LOG_LEVEL);

const shouldLog = (configuredLevel, level) =>
  LEVELS.indexOf(level) <= LEVELS.indexOf(configuredLevel);

const formatMessage = (scope, level, message, meta) => {
  const timestamp = new Date().toISOString();
  const namespace = scope ? `[${scope}]` : '';
  const metaString =
    meta && Object.keys(meta).length ? ` ${JSON.stringify(meta, null, 2)}` : '';
  return `${timestamp} ${namespace} ${level.toUpperCase()}: ${message}${metaString}`;
};

const baseLogger = (scope) => {
  const configuredLevel = resolveLogLevel();

  const log = (level, message, meta) => {
    if (!shouldLog(configuredLevel, level)) {
      return;
    }
    
    console[level === 'debug' ? 'log' : level](formatMessage(scope, level, message, meta));
  };

  return {
    error: (message, meta) => log('error', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    info: (message, meta) => log('info', message, meta),
    debug: (message, meta) => log('debug', message, meta),
  };
};

export const logger = baseLogger('AIra');

export const createLogger = (scope) => baseLogger(scope);
