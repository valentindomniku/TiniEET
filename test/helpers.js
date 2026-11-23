'use strict';
// Testy běží proti dočasné databázi <DB_NAME>_test – vytvoří se na začátku a po skončení smaže. EET se simuluje.
Object.assign(process.env, {
  NODE_ENV: 'test', ADMIN_PASSWORD: 'admin-heslo-123',
  EET_EIC: 'CZ00000019', EET_ID_JEDNOTKY: '11', EET_ID_POKL: '1',
});
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const request = require('supertest');
const config = require('../src/config');
const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const { mock } = require('../src/eet');

mock.zapnuto = true;

const { database, ...bezDb } = config.db;
async function naServeru(sql) {
  const c = await mysql.createConnection({ ...bezDb, multipleStatements: true });
  try { await c.query(sql); } finally { await c.end(); }
}

// Před každým testem čistá databáze s tabulkami z db/schema.sql.
async function resetDb() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await naServeru(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_czech_ci;
    USE \`${database}\`; DROP TABLE IF EXISTS eet, sluzby; ${schema}`);
  await pool.query("INSERT INTO sluzby (nazev, cena) VALUES ('Dámský střih', 550), ('Pánský střih', 350)");
  mock.chovani = () => ({ typ: 'potvrzeni' });
  mock.log.length = 0;
}

async function teardown() {
  await pool.end();
  await naServeru(`DROP DATABASE IF EXISTS \`${database}\``);
}

const app = () => createApp();
const body = (o = {}) => ({ id_pozadavku: crypto.randomUUID(), sluzba_id: 2, castka: 350, ...o });

async function admin(a = request.agent(app())) {
  await a.post('/api/admin/login').send({ heslo: 'admin-heslo-123' }).expect(200);
  return a;
}

async function platba(id) {
  const [[p]] = await pool.query('SELECT * FROM eet WHERE id = ?', [id]);
  return p;
}

module.exports = { resetDb, teardown, app, body, admin, platba, pool, mock, request };
