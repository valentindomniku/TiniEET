'use strict';
// V DB je UTC. EET a přehledy potřebují pražský čas.
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function casti(d) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(d)) p[type] = value;
  return p;
}

/** Posun Prahy vůči UTC v minutách (+60 / +120). */
function posun(d) {
  const p = casti(d);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d / 1000) * 1000) / 60000;
}

/** Date -> "2027-01-09T04:25:28+01:00" (formát EET). */
function prahaIso(d) {
  const p = casti(d);
  const h = String(posun(d) / 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+${h}:00`;
}

/** Dnešní pražské datum "RRRR-MM-DD". */
function dnes(d = new Date()) {
  const p = casti(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Pražský den "RRRR-MM-DD" -> [začátek, konec) v UTC. Letní čas se mění v 01:00 UTC, proto stačí posun o půlnoci UTC. */
function denUtc(den) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(den || '');
  if (!m || new Date(Date.UTC(m[1], m[2] - 1, m[3])).getUTCDate() !== +m[3]) return null; // i 31. 2. apod.
  const zacatek = (y, mo, d) => {
    const t = Date.UTC(y, mo, d);
    return new Date(t - posun(new Date(t)) * 60000);
  };
  return [zacatek(+m[1], m[2] - 1, +m[3]), zacatek(+m[1], m[2] - 1, +m[3] + 1)];
}

module.exports = { prahaIso, dnes, denUtc };
