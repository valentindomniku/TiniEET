'use strict';
// Hlavní stránka: výběr firmy (IČO), pak tlačítka služeb a potvrzení ceny.
const $ = (id) => document.getElementById(id);
const dlg = $('dlg-platba');
const cena = $('dp-cena');
const chyba = $('dp-err');
let firmy = [];
let firma = null; // vybraná firma { cislo, nazev, ico }
let vybrana = null; // { sluzba, idPozadavku }

/** Přepne mezi úvodním výběrem firmy a pokladnou. */
function ukaz(pokladna) {
  $('vyber').hidden = pokladna;
  for (const id of ['sluzby', 'firma-nazev', 'fronta', 'zmenit-firmu', 'admin-odkaz']) $(id).hidden = !pokladna;
}

function ukazVyber() {
  firma = null;
  ulozFirmu(null);
  $('firmy').replaceChildren(...firmy.map((f) => el('button', { type: 'button', class: 'firma-btn', onclick: () => zvol(f) },
    el('span', { class: 'name', text: f.nazev }), el('span', { class: 'ico', text: `IČO ${f.ico}` }))));
  ukaz(false);
}

function zvol(f) {
  firma = f;
  ulozFirmu(f.cislo);
  $('firma-nazev').textContent = `IČO ${f.ico}`;
  $('admin-odkaz').href = `/admin?firma=${f.cislo}`;
  ukaz(true);
  nacti();
}

async function nacti() {
  if (!firma) return;
  try {
    const d = await api('GET', `/api/pokladna?firma=${firma.cislo}`);
    ukazFrontu(d.neodeslano);
    $('sluzby').replaceChildren(...(d.sluzby.length ? d.sluzby.map((s) =>
      el('button', { type: 'button', class: 'service', onclick: () => otevri(s) },
        el('span', { class: 'name', text: s.nazev }), el('span', { class: 'price', text: kc(s.cena) })))
      : [el('p', { class: 'empty', text: 'Zatím žádné služby – přidejte je v administraci.' })]));
  } catch (err) {
    toast(err.message, 'err');
  }
}

function otevri(sluzba) {
  vybrana = { sluzba, idPozadavku: uuid() }; // nové id = nová platba; opakované odeslání stejného se neuloží dvakrát
  $('dp-nazev').textContent = sluzba.nazev;
  cena.value = kcPole(sluzba.cena);
  chyba.textContent = '';
  dlg.showModal();
}

$('form-platba').onsubmit = async (e) => {
  e.preventDefault();
  const castka = parseKc(cena.value);
  if (!castka) { chyba.textContent = 'Zadejte platnou cenu.'; return; }
  const tlacitko = e.submitter;
  tlacitko.disabled = true;
  try {
    const p = await api('POST', '/api/platby', {
      firma: firma.cislo, id_pozadavku: vybrana.idPozadavku, sluzba_id: vybrana.sluzba.id, castka,
    });
    dlg.close();
    toast(p.stav === 'odeslano' ? `Uloženo a odesláno do EET · ${kc(p.castka)}` : 'Uloženo – do EET se odešle automaticky', p.stav === 'odeslano' ? 'ok' : 'warn');
    nacti();
  } catch (err) {
    chyba.textContent = err.message; // při výpadku lze potvrdit znovu – stejné id zabrání dvojí platbě
  } finally {
    tlacitko.disabled = false;
  }
};

$('zmenit-firmu').onclick = ukazVyber;

(async () => {
  try {
    firmy = await api('GET', '/api/firmy');
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const ulozena = firmy.find((f) => f.cislo === nactiFirmu());
  if (ulozena) zvol(ulozena);
  else ukazVyber();
})();
setInterval(nacti, 30000);
