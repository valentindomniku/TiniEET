'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { pool } = require('./db');
const { odeslat } = require('./fronta');
const { certInfo } = require('./eet');
const { denUtc } = require('./cas');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELACE_MS = 12 * 3600 * 1000;

function chyba(status, zprava) {
  return Object.assign(new Error(zprava), { status, expose: true });
}
/** Kladná částka v Kč, nejvýš 1 000 000, nejvýš 2 desetinná místa. */
const castkaOk = (n) => typeof n === 'number' && n > 0 && n <= 1_000_000 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const textOk = (s, min, max) => typeof s === 'string' && s.trim().length >= min && s.trim().length <= max;
const cislo = (s) => (/^\d{1,10}$/.test(s) ? Number(s) : 0);

function createApp() {
  const app = express();
  const relace = new Map(); // token -> platnost do (admin přihlášení; restart serveru odhlásí)
  const neuspechy = new Map(); // ip -> { n, od } (ochrana proti zkoušení hesla)

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // API: jen JSON, jen ze stejného původu (ochrana proti CSRF), nic se necachuje.
  app.use('/api', express.json({ limit: '10kb' }), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (req.method !== 'GET' && (!req.is('application/json') || (origin && origin !== `${req.protocol}://${req.get('host')}`))) {
      throw chyba(403, 'Nepovolený požadavek');
    }
    next();
  });

  const jeAdmin = (req) => {
    const token = /(?:^|;\s*)admin=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];
    return !!token && (relace.get(token) || 0) > Date.now();
  };

  async function platbaSeStavem(id) {
    const [[p]] = await pool.query('SELECT * FROM eet WHERE id = ?', [id]);
    return p;
  }

  async function seznamPlateb(od, do_) {
    const [rows] = await pool.query(
      `SELECT p.*, s.id AS stornovano_id FROM eet p LEFT JOIN eet s ON s.puvodni_id = p.id
       WHERE p.cas_utc >= ? AND p.cas_utc < ? ORDER BY p.id DESC`,
      [od, do_],
    );
    return rows;
  }

  /** Uloží platbu (idempotentně podle id_pozadavku) a hned zkusí odeslat do EET. */
  async function ulozAOdesli(data) {
    const [[existujici]] = await pool.query('SELECT id FROM eet WHERE id_pozadavku = ?', [data.id_pozadavku]);
    let id = existujici?.id;
    if (!id) {
      try {
        const cas = new Date(Math.floor(Date.now() / 1000) * 1000);
        [{ insertId: id }] = await pool.query('INSERT INTO eet SET ?', [{ ...data, cas_utc: cas }]);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY' && err.message.includes('uq_puvodni')) throw chyba(409, 'Platba už byla stornována');
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        [[{ id }]] = await pool.query('SELECT id FROM eet WHERE id_pozadavku = ?', [data.id_pozadavku]);
      }
      await odeslat(id).catch((err) => console.error('[eet]', err.message)); // nepovede-li se, pošle to fronta
    }
    return platbaSeStavem(id);
  }

  // ---------- Pokladna (hlavní stránka) ----------

  const { version } = require('../package.json');
  app.get('/api/verze', (req, res) => res.json({ verze: version }));


  app.get('/api/pokladna', async (req, res) => {
    const [sluzby] = await pool.query('SELECT * FROM sluzby ORDER BY nazev');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM eet WHERE stav <> 'odeslano'");
    res.json({ sluzby, neodeslano: n });
  });

  app.post('/api/platby', async (req, res) => {
    const { id_pozadavku, sluzba_id, castka } = req.body || {};
    if (!UUID.test(id_pozadavku) || !castkaOk(castka)) throw chyba(400, 'Neplatné údaje platby');
    const [[sluzba]] = await pool.query('SELECT nazev FROM sluzby WHERE id = ?', [Number(sluzba_id) || 0]);
    if (!sluzba) throw chyba(400, 'Služba neexistuje');
    res.json(await ulozAOdesli({ id_pozadavku, nazev: sluzba.nazev, castka: Math.round(castka * 100) / 100 }));
  });

  // ---------- Administrace ----------

  app.post('/api/admin/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    const z = neuspechy.get(ip);
    const aktivni = z && Date.now() - z.od < 15 * 60 * 1000;
    if (aktivni && z.n >= 5) throw chyba(429, 'Příliš mnoho pokusů, zkuste to za 15 minut');
    const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
    if (!crypto.timingSafeEqual(hash(req.body?.heslo), hash(config.adminHeslo))) {
      neuspechy.set(ip, aktivni ? { n: z.n + 1, od: z.od } : { n: 1, od: Date.now() });
      throw chyba(401, 'Špatné heslo');
    }
    neuspechy.delete(ip);
    for (const [t, platnost] of relace) if (platnost < Date.now()) relace.delete(t); // úklid vypršelých
    const token = crypto.randomBytes(32).toString('hex');
    relace.set(token, Date.now() + RELACE_MS);
    res.cookie('admin', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: RELACE_MS, path: '/' });
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    relace.delete(/(?:^|;\s*)admin=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1]);
    res.clearCookie('admin', { path: '/' }).json({ ok: true });
  });

  app.use('/api/admin', (req, res, next) => {
    if (!jeAdmin(req)) throw chyba(401, 'Nejste přihlášeni');
    next();
  });

  // Storno = nový záporný záznam navázaný na původní platbu. Nic se nemaže.
  app.post('/api/admin/platby/:id/storno', async (req, res) => {
    const { id_pozadavku, duvod } = req.body || {};
    if (!UUID.test(id_pozadavku) || !textOk(duvod, 3, 200)) throw chyba(400, 'Uveďte důvod storna');
    const p = await platbaSeStavem(cislo(req.params.id));
    if (!p) throw chyba(404, 'Platba neexistuje');
    if (p.puvodni_id) throw chyba(400, 'Storno nelze stornovat');
    res.json(await ulozAOdesli({
      id_pozadavku, nazev: p.nazev, castka: -p.castka,
      puvodni_id: p.id, duvod_storna: duvod.trim(),
    }));
  });

  app.get('/api/admin/stav', async (req, res) => {
    const [neodeslane] = await pool.query("SELECT * FROM eet WHERE stav <> 'odeslano' ORDER BY id");
    const { url, eic, idJednotky, idPokl } = config.eet;
    res.json({ eet: { url, eic, idJednotky, idPokl, cert: certInfo() }, neodeslane });
  });

  app.get('/api/admin/prehled', async (req, res) => {
    const rozsah = denUtc(req.query.datum);
    if (!rozsah) throw chyba(400, 'Datum musí být RRRR-MM-DD');
    const [[souhrn]] = await pool.query(
      'SELECT COUNT(*) AS pocet, COALESCE(SUM(castka), 0) AS castka FROM eet WHERE cas_utc >= ? AND cas_utc < ?',
      rozsah,
    );
    res.json({ souhrn, platby: await seznamPlateb(...rozsah) });
  });

  app.post('/api/admin/platby/:id/znovu', async (req, res) => {
    const [r] = await pool.query("UPDATE eet SET stav = 'ceka', dalsi_pokus_utc = NULL WHERE id = ? AND stav = 'chyba'", [cislo(req.params.id)]);
    if (!r.affectedRows) throw chyba(404, 'Platba není ve stavu chyba');
    await odeslat(cislo(req.params.id));
    res.json(await platbaSeStavem(cislo(req.params.id)));
  });

  const sluzbaZTela = (b) => {
    if (!textOk(b?.nazev, 1, 100) || !castkaOk(b?.cena)) throw chyba(400, 'Vyplňte název a cenu');
    return [b.nazev.trim(), Math.round(b.cena * 100) / 100];
  };
  app.post('/api/admin/sluzby', async (req, res) => {
    const [r] = await pool.query('INSERT INTO sluzby (nazev, cena) VALUES (?, ?)', sluzbaZTela(req.body));
    res.json({ id: r.insertId });
  });
  app.put('/api/admin/sluzby/:id', async (req, res) => {
    await pool.query('UPDATE sluzby SET nazev = ?, cena = ? WHERE id = ?', [...sluzbaZTela(req.body), cislo(req.params.id)]);
    res.json({ ok: true });
  });
  // Smazání služby je bezpečné – tržby mají název uložený u sebe.
  app.delete('/api/admin/sluzby/:id', async (req, res) => {
    await pool.query('DELETE FROM sluzby WHERE id = ?', [cislo(req.params.id)]);
    res.json({ ok: true });
  });

  app.use('/api', () => { throw chyba(404, 'Nenalezeno'); });
  app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ chyba: err.expose ? err.message : 'Chyba serveru' });
  });
  return app;
}

module.exports = { createApp };
