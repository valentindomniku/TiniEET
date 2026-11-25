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

// Firmy (IČO), za které pokladna eviduje tržby: FIRMA1_*, FIRMA2_*, … v .env.
const firmy = [];
for (let n = 1; e[`FIRMA${n}_EIC`]; n++) {
  firmy.push({
    cislo: n,
    nazev: e[`FIRMA${n}_NAZEV`] || `Firma ${n}`,
    ico: e[`FIRMA${n}_ICO`] || '',
    eic: e[`FIRMA${n}_EIC`],
    idJednotky: e[`FIRMA${n}_ID_JEDNOTKY`],
    idPokl: e[`FIRMA${n}_ID_POKL`],
    cert: e[`FIRMA${n}_CERT_PATH`] ? path.resolve(root, e[`FIRMA${n}_CERT_PATH`]) : null,
    heslo: hesloCertifikatu(e[`FIRMA${n}_CERT_PASSWORD`] || ''),
  });
}
if (!firmy.length) throw new Error('V .env chybí údaje firmy (FIRMA1_EIC, FIRMA1_CERT_PATH, …)');

module.exports = {
  root,
  test,
  port: Number(e.PORT) || 3000,
  firmy,
  /** Firma podle čísla (1, 2, …), nebo undefined. */
  firma: (cislo) => firmy.find((f) => f.cislo === Number(cislo)),
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
    timeoutMs: Number(e.EET_TIMEOUT_MS) || 3000,
  },
  workerMs: 60000, // neodeslané tržby se zkoušejí znovu každou minutu
};
