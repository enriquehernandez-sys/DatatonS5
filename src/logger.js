/** Bitácora JSON por línea (lista para enviarse a un SIEM). */
function write(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};

export const silentLogger = { info() {}, warn() {}, error() {} };
