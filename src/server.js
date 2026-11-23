'use strict';
const config = require('./config');
const { pool } = require('./db');
const { spustWorker } = require('./fronta');
const { certInfo } = require('./eet');
const { createApp } = require('./app');

(async () => {
  await pool.query('SELECT 1 FROM eet LIMIT 1'); // ověří připojení k databázi a tabulky

  const c = certInfo();
  console.log(`[EET] ZAPNUTO, cert ${c.ok ? 'OK' : `CHYBA – ${c.chyba}`}, eic=${config.eet.eic}`);

  const zastavWorker = spustWorker(config.workerMs);
  const server = createApp().listen(config.port, () => {
    console.log(`TiniEET běží na http://localhost:${config.port}`);
  });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} je obsazený – neběží už TiniEET?` : err.message);
    process.exit(1);
  });

  const konec = () => {
    zastavWorker();
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGINT', konec);
  process.on('SIGTERM', konec);
})().catch((err) => {
  console.error(`Server nelze spustit: ${err.message}`);
  process.exit(1);
});
