'use strict';
// Hlavní stránka: tlačítka služeb a potvrzení ceny.
const dlg = document.getElementById('dlg-platba');
const cena = document.getElementById('dp-cena');
const chyba = document.getElementById('dp-err');
let vybrana = null; // { sluzba, idPozadavku }

async function nacti() {
  try {
    const d = await api('GET', '/api/pokladna');
    const f = document.getElementById('fronta');
    f.textContent = d.neodeslano ? `Neodesláno do EET: ${d.neodeslano}` : 'EET v pořádku';
    f.className = `pill ${d.neodeslano ? 'pill-warn' : 'pill-ok'}`;
    document.getElementById('sluzby').replaceChildren(...(d.sluzby.length ? d.sluzby.map((s) =>
      el('button', { type: 'button', class: 'service', onclick: () => otevri(s) },
        el('span', { class: 'name', text: s.nazev }), el('span', { class: 'price', text: kc(s.cena) })))
      : [el('p', { class: 'empty', text: 'Zatím žádné služby – přidejte je v administraci.' })]));
  } catch (err) {
    toast(err.message, 'err');
  }
}

function otevri(sluzba) {
  vybrana = { sluzba, idPozadavku: uuid() }; // nové id = nová platba; opakované odeslání stejného se neuloží dvakrát
  document.getElementById('dp-nazev').textContent = sluzba.nazev;
  cena.value = kcPole(sluzba.cena);
  chyba.textContent = '';
  dlg.showModal();
}

document.getElementById('form-platba').onsubmit = async (e) => {
  e.preventDefault();
  const castka = parseKc(cena.value);
  if (!castka) { chyba.textContent = 'Zadejte platnou cenu.'; return; }
  const tlacitko = e.submitter;
  tlacitko.disabled = true;
  try {
    const p = await api('POST', '/api/platby', {
      id_pozadavku: vybrana.idPozadavku, sluzba_id: vybrana.sluzba.id, castka,
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

nacti();
setInterval(nacti, 30000);
