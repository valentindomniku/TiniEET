'use strict';
// Fronta odesílání do EET. Přežije výpadek internetu i restart – neodeslané tržby čekají v DB
// a zkoušejí se znovu každou minutu. Dvojímu odeslání brání seznam právě odesílaných tržeb
// (server běží jen jeden) a stav 'odeslano'.
const { pool } = require('./db');
const { sendRecord } = require('./eet');

const MAX_NEJASNYCH = 10;
const odesilane = new Set(); // id tržeb, které se právě odesílají

/** Zkusí odeslat jednu tržbu. Vrátí výsledek, nebo null, když už je odeslaná nebo se právě odesílá. */
async function odeslat(id) {
  if (odesilane.has(id)) return null;
  odesilane.add(id);
  try {
    const [[p]] = await pool.query("SELECT * FROM eet WHERE id = ? AND stav = 'ceka'", [id]);
    if (!p) return null;
    const v = await sendRecord(p, { prvniZaslani: p.pokusy === 0 });
    const pokusy = p.pokusy + 1;

    if (v.vysledek === 'potvrzeno') {
      const varovani = v.varovani.length ? `Varování FS: ${v.varovani.join('; ')}`.slice(0, 500) : null;
      await pool.query("UPDATE eet SET stav = 'odeslano', pok = ?, pokusy = ?, chyba = ? WHERE id = ?", [v.pok, pokusy, varovani, id]);
    } else {
      const vzdat = v.vysledek === 'chyba_trvala' || v.vysledek === 'overeno'
        || (v.vysledek === 'chyba_nejasna' && pokusy >= MAX_NEJASNYCH);
      const text = `${v.kod !== undefined ? `[${v.kod}] ` : ''}${v.text || v.vysledek}`.slice(0, 500);
      await pool.query('UPDATE eet SET stav = ?, pokusy = ?, chyba = ? WHERE id = ?', [vzdat ? 'chyba' : 'ceka', pokusy, text, id]);
    }
    return v;
  } finally {
    odesilane.delete(id);
  }
}

/** Projde čekající tržby (nejstarší první). */
async function zpracujFrontu() {
  const [rows] = await pool.query("SELECT id FROM eet WHERE stav = 'ceka' ORDER BY id LIMIT 50");
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

module.exports = { odeslat, zpracujFrontu, spustWorker };
