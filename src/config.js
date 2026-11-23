'use strict';
// Veškerá konfigurace z .env (popis v README). Žádné tajné údaje v kódu.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.loadEnvFile(path.join(root, '.env')); // vestavěné v Node.js, hodnoty už nastavené v prostředí mají přednost

const e = process.env;
const test = e.NODE_ENV === 'test';

if (!test && !/^https:\/\//.test(e.EET_URL || '')) throw new Error('EET_URL v .env musí být adresa https://');

/** Heslo certifikátu: buď přímo heslo, nebo cesta k souboru s heslem (např. secrets/heslo.txt). */
function hesloCertifikatu(hodnota) {
  const soubor = path.resolve(root, hodnota);
  return hodnota && fs.existsSync(soubor) && fs.statSync(soubor).isFile() ? fs.readFileSync(soubor, 'utf8').trim() : hodnota;
}

const adminHeslo = e.ADMIN_PASSWORD || '';
if (!adminHeslo) throw new Error('Chybí ADMIN_PASSWORD v .env'); // jinak by šlo do administrace s prázdným heslem

module.exports = {
  root,
  test,
  port: Number(e.PORT) || 3000,
  adminHeslo,
  db: {
    host: e.DB_HOST || '127.0.0.1',
    port: Number(e.DB_PORT) || 3306,
    user: e.DB_USER || 'root',
    password: e.DB_PASSWORD || '',
    database: `${e.DB_NAME || 'tinieet'}${test ? '_test' : ''}`, // testy používají dočasnou databázi
    timezone: 'Z', // JS Date <-> DATETIME vždy v UTC
    charset: 'utf8mb4',
    decimalNumbers: true, // DECIMAL (Kč) jako číslo
  },
  eet: {
    url: e.EET_URL || '',
    eic: e.EET_EIC,
    idJednotky: e.EET_ID_JEDNOTKY,
    idPokl: e.EET_ID_POKL,
    cert: e.EET_CERT_PATH ? path.resolve(root, e.EET_CERT_PATH) : null,
    heslo: hesloCertifikatu(e.EET_CERT_PASSWORD || ''),
    timeoutMs: Number(e.EET_TIMEOUT_MS) || 3000,
  },
  workerMs: Number(e.WORKER_INTERVAL_MS) || 10000,
};
