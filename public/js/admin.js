'use strict';
const $ = (id) => document.getElementById(id);

function zobraz(prihlasen) {
  $('login').hidden = prihlasen;
  $('obsah').hidden = !prihlasen;
  $('odhlasit').hidden = !prihlasen;
  if (prihlasen) nacti();
  else $('heslo').focus();
}

/** Volání API s návratem na přihlášení, když vyprší. */
async function adminApi(method, url, body) {
  try {
    return await api(method, url, body);
  } catch (err) {
    if (err.status === 401) zobraz(false);
    throw err;
  }
}

/** Řádek tabulky plateb; pokud je zadáno onStorno, přidá tlačítko Storno. */
function radekPlatby(p, onStorno) {
  return el('tr', { class: p.puvodni_id ? 'storno' : p.stornovano_id ? 'stornovano' : null },
    el('td', { text: cas(p.cas_utc) }),
    el('td', { text: p.puvodni_id ? `Storno: ${p.nazev} (${p.duvod_storna})` : p.nazev }),
    el('td', { class: 'num', text: kc(p.castka) }),
    el('td', {}, stavPill(p)),
    el('td', {}, onStorno && !p.puvodni_id && !p.stornovano_id
      ? el('button', { type: 'button', class: 'btn-small', text: 'Storno', onclick: () => onStorno(p) }) : null));
}

/** Otevře dialog storna pro platbu p, po úspěchu zavolá hotovo(). */
function stornoDialog(p, hotovo) {
  const dlg = document.getElementById('dlg-storno');
  const form = document.getElementById('form-storno');
  const duvod = document.getElementById('ds-duvod');
  const err = document.getElementById('ds-err');
  const idPozadavku = uuid();
  document.getElementById('ds-popis').textContent = `${p.nazev} · ${kc(p.castka)}`;
  duvod.value = '';
  err.textContent = '';
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (duvod.value.trim().length < 3) { err.textContent = 'Napište důvod storna.'; return; }
    try {
      await adminApi('POST', `/api/admin/platby/${p.id}/storno`, { id_pozadavku: idPozadavku, duvod: duvod.value });
      dlg.close();
      toast('Platba stornována');
      hotovo();
    } catch (ex) { err.textContent = ex.message; }
  };
  dlg.showModal();
  duvod.focus();
}

async function nacti() {
  try {
    await Promise.all([nactiStav(), nactiPrehled(), nactiSluzby()]);
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'err');
  }
}

async function nactiStav() {
  const { eet, neodeslane } = await adminApi('GET', '/api/admin/stav');
  const upozorneni = [];
  if (eet.cert && !eet.cert.ok) upozorneni.push(['err', `Certifikát: ${eet.cert.chyba}`]);
  else if (eet.cert && new Date(eet.cert.platnyDo) - Date.now() < 30 * 86400000) {
    upozorneni.push(['warn', `Certifikát vyprší ${new Date(eet.cert.platnyDo).toLocaleDateString('cs-CZ')} – vyžádejte nový v DIS+`]);
  }
  $('eet').replaceChildren(
    el('p', { class: 'muted', text: `EET: ${eet.url} · DIČ ${eet.eic} · provozovna ${eet.idJednotky} · pokladna ${eet.idPokl}`
      + (eet.cert?.ok ? ` · certifikát do ${new Date(eet.cert.platnyDo).toLocaleDateString('cs-CZ')}` : '') }),
    ...upozorneni.map(([druh, text]) => el('div', { class: `alert alert-${druh}`, text })),
  );
  $('neodeslane').replaceChildren(...(neodeslane.length ? neodeslane.map((p) => el('tr', {},
    el('td', { text: p.id }),
    el('td', { text: new Date(p.cas_utc).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) }),
    el('td', { text: p.nazev }),
    el('td', { class: 'num', text: kc(p.castka) }),
    el('td', {}, stavPill(p)),
    el('td', { class: 'num', text: p.pokusy }),
    el('td', { text: p.chyba || '' }),
    el('td', {}, p.stav === 'chyba' ? el('button', { type: 'button', class: 'btn-small', text: 'Odeslat znovu', onclick: () => znovu(p.id) }) : null)))
    : [el('tr', {}, el('td', { colspan: 8, class: 'muted', text: 'Vše je odesláno.' }))]));
}

async function znovu(id) {
  try {
    const p = await adminApi('POST', `/api/admin/platby/${id}/znovu`, {});
    toast(p.stav === 'odeslano' ? 'Odesláno' : `Neodesláno: ${p.chyba}`, p.stav === 'odeslano' ? 'ok' : 'warn');
    nacti();
  } catch (err) { toast(err.message, 'err'); }
}

async function nactiPrehled() {
  const { souhrn, platby } = await adminApi('GET', `/api/admin/prehled?datum=${$('datum').value}`);
  $('trzba').textContent = kc(souhrn.castka);
  $('pocet').textContent = `(${souhrn.pocet} záznamů včetně storen)`;
  $('den-platby').replaceChildren(...platby.map((p) => radekPlatby(p, (x) => stornoDialog(x, nacti))));
}

async function nactiSluzby() {
  const { sluzby } = await api('GET', '/api/pokladna');
  $('sluzby').replaceChildren(...sluzby.map((s) => {
    const nazev = el('input', { value: s.nazev, maxlength: 100, 'aria-label': 'Název' });
    const cena = el('input', { value: kcPole(s.cena), inputmode: 'decimal', 'aria-label': 'Cena' });
    return el('tr', {},
      el('td', {}, nazev),
      el('td', {}, cena),
      el('td', { class: 'akce' },
        el('button', { type: 'button', class: 'btn-small', text: 'Uložit', onclick: () => ulozSluzbu('PUT', `/api/admin/sluzby/${s.id}`, nazev.value, cena.value) }),
        el('button', { type: 'button', class: 'btn-small', text: 'Smazat', onclick: () => smazSluzbu(s) })));
  }));
}

async function ulozSluzbu(method, url, nazev, cenaText) {
  const cena = parseKc(cenaText);
  if (!nazev.trim() || !cena) { toast('Vyplňte název a platnou cenu', 'err'); return false; }
  try {
    await adminApi(method, url, { nazev, cena });
    toast('Uloženo');
    nactiSluzby();
    return true;
  } catch (err) { toast(err.message, 'err'); return false; }
}

async function smazSluzbu(s) {
  if (!confirm(`Smazat službu „${s.nazev}“? Uložené platby zůstanou.`)) return;
  try {
    await adminApi('DELETE', `/api/admin/sluzby/${s.id}`, {});
    nactiSluzby();
  } catch (err) { toast(err.message, 'err'); }
}

$('nova-sluzba').onsubmit = async (e) => {
  e.preventDefault();
  if (await ulozSluzbu('POST', '/api/admin/sluzby', $('ns-nazev').value, $('ns-cena').value)) {
    $('ns-nazev').value = '';
    $('ns-cena').value = '';
  }
};

$('login').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/admin/login', { heslo: $('heslo').value });
    $('heslo').value = '';
    $('login-err').textContent = '';
    zobraz(true);
  } catch (err) { $('login-err').textContent = err.message; }
};

$('odhlasit').onclick = async () => {
  await api('POST', '/api/admin/logout', {}).catch(() => {});
  zobraz(false);
};

$('datum').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
$('datum').onchange = () => nactiPrehled().catch((err) => toast(err.message, 'err'));

// Přihlášen? (stav vrátí 401, když ne)
api('GET', '/api/admin/stav').then(() => zobraz(true), () => zobraz(false));
