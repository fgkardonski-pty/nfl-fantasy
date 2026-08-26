/** Minimal structured logger. No dependencies, colour-aware, level-filtered. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

const threshold = LEVELS[process.env.ORACLE_LOG_LEVEL] ?? LEVELS.info;
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const t = new Date().toISOString().slice(11, 19);
  const tag = `[${scope}]`;
  const head = useColor ? `${COLOR[level]}${t} ${level.toUpperCase().padEnd(5)}${RESET} ${tag}` : `${t} ${level.toUpperCase().padEnd(5)} ${tag}`;
  const line = `${head} ${msg}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(extra !== undefined ? `${line} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}\n` : `${line}\n`);
}

export function logger(scope = 'oracle') {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

export const log = logger('oracle');
