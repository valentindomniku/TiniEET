'use strict';
// Fronta odesílání do EET. Přežije výpadek internetu i restart – vše je v DB.
// Dvojímu odeslání brání krátký zámek (dalsi_pokus_utc) a stav 'odeslano'.
const { pool } = require('./db');
const { sendRecord } = require('./eet');

const ZAMEK_S = 120;
const MAX_NEJASNYCH = 10;

/** Exponenciální čekání: 30 s, 60 s, 120 s … max. 15 min, ±10 % náhodně. */
const odstupSekund = (pokus) => Math.round(Math.min(900, 30 * 2 ** (pokus - 1)) * (0.9 + Math.random() * 0.2));

/** Zkusí odeslat jednu platbu. Vrátí výsledek, nebo null, když ji právě odesílá někdo jiný. */
async function odeslat(id) {
  const [zamek] = await pool.query(
    `UPDATE eet SET dalsi_pokus_utc = UTC_TIMESTAMP() + INTERVAL ? SECOND
     WHERE id = ? AND stav = 'ceka' AND (dalsi_pokus_utc IS NULL OR dalsi_pokus_utc <= UTC_TIMESTAMP())`,
    [ZAMEK_S, id],
  );
  if (zamek.affectedRows !== 1) return null;

  const [[p]] = await pool.query('SELECT * FROM eet WHERE id = ?', [id]);
  const v = await sendRecord(p, { prvniZaslani: p.pokusy === 0 });
  const pokusy = p.pokusy + 1;

  if (v.vysledek === 'potvrzeno') {
    const varovani = v.varovani.length ? `Varování FS: ${v.varovani.join('; ')}`.slice(0, 500) : null;
    await pool.query(
      "UPDATE eet SET stav = 'odeslano', pok = ?, pokusy = ?, dalsi_pokus_utc = NULL, chyba = ? WHERE id = ?",
      [v.pok, pokusy, varovani, id],
    );
  } else {
    const vzdat = v.vysledek === 'chyba_trvala' || v.vysledek === 'overeno'
      || (v.vysledek === 'chyba_nejasna' && pokusy >= MAX_NEJASNYCH);
    const text = `${v.kod !== undefined ? `[${v.kod}] ` : ''}${v.text || v.vysledek}`.slice(0, 500);
    await pool.query(
      'UPDATE eet SET stav = ?, pokusy = ?, chyba = ?, dalsi_pokus_utc = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ?',
      [vzdat ? 'chyba' : 'ceka', pokusy, text, vzdat ? 0 : odstupSekund(pokusy), id],
    );
  }
  return v;
}

/** Projde čekající platby (nejstarší první). */
async function zpracujFrontu() {
  const [rows] = await pool.query(
    `SELECT id FROM eet WHERE stav = 'ceka' AND (dalsi_pokus_utc IS NULL OR dalsi_pokus_utc <= UTC_TIMESTAMP())
     ORDER BY id LIMIT 50`,
  );
  for (const { id } of rows) await odeslat(id);
}

/** Spustí opakované zpracování fronty. Vrací funkci pro zastavení. */
function spustWorker(ms) {
  let bezi = false;
  const tik = async () => {
    if (bezi) return;
    bezi = true;
    try { await zpracujFrontu(); } catch (err) { console.error('[fronta]', err.message); } finally { bezi = false; }
  };
  const t = setInterval(tik, ms);
  tik();
  return () => clearInterval(t);
}

module.exports = { odeslat, zpracujFrontu, spustWorker, odstupSekund };
