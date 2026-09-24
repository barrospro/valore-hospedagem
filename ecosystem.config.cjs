// PM2 — alternativa ao Docker em VPS.
//   npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'valore',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,              // o store é um JSON local: mantenha 1 instância
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 6000,        // tempo para o SIGTERM gravar o store
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        ACCESS_LOG: '1',
      },
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      time: true,
    },
  ],
};
