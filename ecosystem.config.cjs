// pm2 process definition. CommonJS on purpose: package.json sets "type": "module",
// so pm2 can only read this file if it carries the .cjs extension.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'kdb',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Rendering PDF pages for OCR is memory hungry, so leave real headroom before
      // pm2 decides to recycle the process.
      max_memory_restart: '1G',
      // A crash loop should not spin forever.
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,
      // OCR requests can run for minutes; give in-flight work time to drain on restart.
      kill_timeout: 30000,
      // Config comes from .env, which config.js loads relative to its own directory.
      env: {
        NODE_ENV: 'production'
      },
      out_file: path.join(__dirname, 'logs', 'kdb-out.log'),
      error_file: path.join(__dirname, 'logs', 'kdb-error.log'),
      merge_logs: true,
      time: true
    }
  ]
};
