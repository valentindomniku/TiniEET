'use strict';
// Sdílené pomůcky pro pokladnu i administraci.
const STAVY = { ceka: ['Čeká', 'pill-warn'], odeslano: ['Odesláno', 'pill-ok'], chyba: ['Chyba', 'pill-err'] };

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Server není dostupný, zkuste to znovu.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.chyba || `Chyba ${res.status}`), { status: res.status });
  return data;
}

/** "350" / "350,5" -> 350.5, při chybě null. */
function parseKc(text) {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  return m ? Number(`${m[1]}.${m[2] || 0}`) : null;
}

/** 1200 -> "1 200 Kč", 81.6 -> "81,60 Kč" */
const kc = (n) => `${n.toLocaleString('cs-CZ', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })} Kč`;

/** 350.5 -> "350,50" pro vstupní pole */
const kcPole = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','));

const cas = (iso) => new Date(iso).toLocaleTimeString('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' });

/** Vytvoří element bezpečně (text nikdy jako HTML). */
function el(tag, attrs = {}, ...deti) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...deti.flat().filter((d) => d != null));
  return n;
}

const stavPill = (p) => el('span', { class: `pill ${STAVY[p.stav][1]}`, title: p.chyba || p.pok || '', text: STAVY[p.stav][0] });

function toast(text, druh = 'ok') {
  const t = document.getElementById('toast') || document.body.appendChild(el('div', { id: 'toast', role: 'status' }));
  t.className = `toast toast-${druh}`;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); // http v místní síti nemusí mít randomUUID
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Dialogy: tlačítka s data-zavrit zavírají
document.addEventListener('click', (e) => { if (e.target.matches('[data-zavrit]')) e.target.closest('dialog').close(); });

// Verze aplikace (z package.json) vedle názvu v záhlaví
api('GET', '/api/verze').then((d) => { document.getElementById('verze').textContent = `v${d.verze}`; }, () => {});
