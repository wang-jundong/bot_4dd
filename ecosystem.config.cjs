const fs = require("node:fs");
const path = require("node:path");

const logDirectory = path.join(__dirname, "logs");
fs.mkdirSync(logDirectory, { recursive: true });

module.exports = {
  apps: [
    {
      name: "solana-tsr-bot",
      script: "dist/src/index.js",
      cwd: __dirname,
      // Pin the runtime because pump-sdk 1.36.0's Anchor dependency does not expose BN correctly on Node 20.
      interpreter: "/home/vibes/.nvm/versions/node/v24.16.0/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      merge_logs: true,
      out_file: path.join(logDirectory, "bot-output.txt"),
      error_file: path.join(logDirectory, "bot-error.txt"),
      max_memory_restart: "1G",
      kill_timeout: 10000,
      listen_timeout: 10000,
      time: true,
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
};
