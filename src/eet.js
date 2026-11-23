'use strict';
// Evidence tržeb EET 2.0 podle oficiální specifikace rozhraní v4.1 (docs/eet/: XSD, WSDL, příklad).
// SOAP 1.1 přes HTTPS, podpis WS-Security (jen soap:Body, exc-c14n, SHA-256, RSA-SHA256).
// Odesílá výhradně server – certifikát a klíč nikdy neopouštějí server.
//
//   sendRecord(platba, { prvniZaslani, overeni }) -> { vysledek, pok?, kod?, text?, varovani? }
//   vysledek: potvrzeno | overeno | chyba_docasna | chyba_trvala | chyba_nejasna | bez_odpovedi
// Funkce nikdy nevyhazuje – vždy vrátí výsledek.
const crypto = require('node:crypto');
const fs = require('node:fs');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const config = require('./config');
const { prahaIso } = require('./cas');

const NS_EET = 'http://fs.gov.cz/eet/schema/v4';
const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const NS_WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const X509V3 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

// Formáty přesně podle EETXMLSchema.xsd
const MASKY = {
  eic_popl: /^CZ[0-9]{8,10}$/,
  id_jednotky: /^[1-9][0-9]{0,8}$/,
  id_pokl: /^[0-9a-zA-Z.,:;/#\-_ ]{1,20}$/,
  porad_cis: /^[0-9a-zA-Z.,:;/#\-_ ]{1,25}$/,
  dat_trzby: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/,
  celk_trzba: /^((0|-?[1-9]\d{0,7})\.\d\d|-0\.(0[1-9]|[1-9]\d))$/,
  pok: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[0-9a-fA-F]{2}$/,
};
const TRVALE_CHYBY = [2, 3, 4, 6, 7]; // chyba XML/podpisu/EIČ/velikosti – opakování nepomůže

/** 350.5 Kč -> "350.50" */
const kcToEet = (kc) => kc.toFixed(2);

function datovaVeta(platba) {
  const d = {
    eic_popl: config.eet.eic,
    id_jednotky: String(config.eet.idJednotky),
    id_pokl: String(config.eet.idPokl),
    porad_cis: String(platba.id),
    dat_trzby: prahaIso(platba.cas_utc),
    celk_trzba: kcToEet(platba.castka),
  };
  const spatne = Object.keys(d).filter((k) => !MASKY[k].test(d[k]));
  if (spatne.length) throw new Error(`Údaje neodpovídají specifikaci: ${spatne.join(', ')} (zkontrolujte EET_* v .env)`);
  return d;
}

const attrs = (o) => Object.entries(o).filter(([, v]) => v !== undefined)
  .map(([k, v]) => `${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`).join(' ');

function sestavObalku({ uuidZpravy, prvniZaslani, overeni }, data) {
  const hlavicka = {
    uuid_zpravy: uuidZpravy,
    dat_odesl: prahaIso(new Date()),
    prvni_zaslani: String(!!prvniZaslani),
    overeni: overeni ? 'true' : undefined, // v produkčním módu se atribut neuvádí
  };
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + `<soapenv:Envelope xmlns:soapenv="${NS_SOAP}" xmlns:v4="${NS_EET}"><soapenv:Header>`
    + `<wsse:Security xmlns:wsse="${NS_WSSE}" xmlns:wsu="${NS_WSU}"></wsse:Security></soapenv:Header>`
    + `<soapenv:Body xmlns:wsu="${NS_WSU}" wsu:Id="id-${crypto.randomBytes(16).toString('hex')}">`
    + `<v4:Trzba><v4:Hlavicka ${attrs(hlavicka)}/><v4:Data ${attrs(data)}/></v4:Trzba>`
    + '</soapenv:Body></soapenv:Envelope>';
}

function podepis(xml, cert) {
  const tokenId = `X509-${crypto.randomBytes(16).toString('hex')}`;
  xml = xml.replace('</wsse:Security>', `<wsse:BinarySecurityToken EncodingType="${BASE64}" ValueType="${X509V3}" wsu:Id="${tokenId}">${cert.certBase64}</wsse:BinarySecurityToken></wsse:Security>`);
  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    idMode: 'wssecurity',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: EXC_C14N,
    getKeyInfoContent: () => `<wsse:SecurityTokenReference><wsse:Reference URI="#${tokenId}" ValueType="${X509V3}"/></wsse:SecurityTokenReference>`,
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Envelope']/*[local-name(.)='Body']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [EXC_C14N],
  });
  sig.computeSignature(xml, {
    prefix: 'ds',
    existingPrefixes: { wsse: NS_WSSE, wsu: NS_WSU },
    location: { reference: "//*[local-name(.)='Security']", action: 'append' },
  });
  return sig.getSignedXml();
}

let certCache = null;
/** Načte pokladní certifikát (.p12). Klíč zůstává jen v paměti serveru. */
function nactiCert() {
  if (certCache) return certCache;
  const { cert, heslo } = config.eet;
  if (!cert || !fs.existsSync(cert)) throw new Error('Soubor certifikátu neexistuje (EET_CERT_PATH)');
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(fs.readFileSync(cert).toString('binary')), heslo);
  } catch {
    throw new Error('Certifikát nelze otevřít – špatné heslo nebo poškozený soubor');
  }
  const bags = (t) => p12.getBags({ bagType: t })[t] || [];
  const key = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)][0]?.key;
  const c = key && bags(forge.pki.oids.certBag).map((b) => b.cert).find((x) => x?.publicKey?.n?.equals(key.n));
  if (!c) throw new Error('V souboru .p12 chybí klíč nebo k němu patřící certifikát');
  certCache = {
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(c),
    certBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()),
    platnyDo: c.validity.notAfter,
  };
  return certCache;
}

/** Stav certifikátu pro administraci (bez klíče). */
function certInfo() {
  try {
    return { ok: true, platnyDo: nactiCert().platnyDo };
  } catch (err) {
    return { ok: false, chyba: err.message };
  }
}

/** Zpracuje XML odpověď FS (spec. kap. 3.4–3.5). */
function zpracujOdpoved(body, httpStatus, uuidZpravy) {
  let doc = null;
  try {
    const chyby = [];
    doc = new DOMParser({ onError: (lvl) => { if (lvl !== 'warning') chyby.push(lvl); } }).parseFromString(body || '<x/>', 'text/xml');
    if (chyby.length) doc = null;
  } catch { doc = null; }
  const prvni = (jmeno, ns = NS_EET) => doc && doc.getElementsByTagNameNS(ns, jmeno)[0];

  const odpoved = prvni('Odpoved');
  if (!odpoved) {
    if (prvni('Fault', NS_SOAP)) return { vysledek: 'chyba_nejasna', text: `SOAP Fault: ${prvni('Fault', NS_SOAP).textContent.trim().slice(0, 300)}` };
    if (!httpStatus || httpStatus >= 500 || httpStatus === 429) return { vysledek: 'chyba_docasna', text: `Neplatná odpověď serveru (HTTP ${httpStatus})` };
    return { vysledek: 'chyba_nejasna', text: `Neočekávaná odpověď serveru (HTTP ${httpStatus})` };
  }
  const varovani = Array.from(odpoved.getElementsByTagNameNS(NS_EET, 'Varovani'))
    .map((v) => `${v.getAttribute('kod_varov')} ${v.textContent.trim()}`);
  const potvrzeni = prvni('Potvrzeni');
  if (potvrzeni) {
    const pok = potvrzeni.getAttribute('pok');
    const uuid = prvni('Hlavicka')?.getAttribute('uuid_zpravy');
    if (!MASKY.pok.test(pok) || (uuid && uuid.toLowerCase() !== uuidZpravy.toLowerCase())) {
      return { vysledek: 'chyba_nejasna', text: 'Potvrzení s neplatným POK nebo cizím UUID', varovani };
    }
    return { vysledek: 'potvrzeno', pok, varovani };
  }
  const chyba = prvni('Chyba');
  const kod = Number(chyba?.getAttribute('kod'));
  const text = (chyba?.textContent || 'Odpověď bez potvrzení i chyby').trim().slice(0, 300);
  if (!Number.isInteger(kod)) return { vysledek: 'chyba_nejasna', text, varovani };
  const vysledek = kod === 0 ? 'overeno' : kod < 0 ? 'chyba_docasna' : TRVALE_CHYBY.includes(kod) ? 'chyba_trvala' : 'chyba_nejasna';
  return { vysledek, kod, text, varovani };
}

/** Skutečné odeslání přes HTTPS. Certifikát serveru FS se ověřuje proti systémovým CA. */
async function odesliSoap(xml) {
  const res = await fetch(config.eet.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://fs.gov.cz/eet/OdeslaniTrzby"' },
    body: xml,
    signal: AbortSignal.timeout(config.eet.timeoutMs),
    redirect: 'error',
  });
  return { httpStatus: res.status, body: await res.text() };
}

// Simulace pro testy (mock.zapnuto = true): nic neodesílá, vrací odpověď ve formátu FS.
const mock = {
  zapnuto: false,
  chovani: () => ({ typ: 'potvrzeni' }), // 'potvrzeni' | 'chyba' (s kod) | 'vypadek'
  log: [],
  async odesli(xml) {
    const uuid = /uuid_zpravy="([^"]+)"/.exec(xml)[1];
    const c = await mock.chovani(xml);
    mock.log.push({ uuid, prvniZaslani: xml.includes('prvni_zaslani="true"'), typ: c.typ });
    if (c.typ === 'vypadek') throw new Error('Simulovaný výpadek spojení');
    const obsah = c.typ === 'chyba'
      ? `<eet:Chyba kod="${c.kod}" test="true">Chyba [mock]</eet:Chyba>`
      : `<eet:Potvrzeni pok="${crypto.randomUUID()}-ff" test="true"/>`;
    return {
      httpStatus: 200,
      body: `<soapenv:Envelope xmlns:soapenv="${NS_SOAP}"><soapenv:Body><eet:Odpoved xmlns:eet="${NS_EET}">`
        + `<eet:Hlavicka uuid_zpravy="${uuid}"/>${obsah}</eet:Odpoved></soapenv:Body></soapenv:Envelope>`,
    };
  },
};

async function sendRecord(platba, { prvniZaslani = true, overeni = false } = {}) {
  const uuidZpravy = crypto.randomUUID(); // nové UUID pro každý pokus (spec.)
  let xml;
  try {
    xml = sestavObalku({ uuidZpravy, prvniZaslani, overeni }, datovaVeta(platba));
  } catch (err) {
    return { vysledek: 'chyba_trvala', text: err.message };
  }
  if (!mock.zapnuto) {
    try {
      xml = podepis(xml, nactiCert());
    } catch (err) {
      // Problém s certifikátem – záznam zůstane ve frontě, admin uvidí chybu.
      return { vysledek: 'chyba_docasna', text: `Certifikát: ${err.message}` };
    }
  }
  if (Buffer.byteLength(xml) > 12 * 1024) return { vysledek: 'chyba_trvala', text: 'Zpráva přesahuje 12 kB' };
  try {
    const res = mock.zapnuto ? await mock.odesli(xml) : await odesliSoap(xml);
    return zpracujOdpoved(res.body, res.httpStatus, uuidZpravy);
  } catch (err) {
    // Nevíme, zda FS zprávu přijala – zkusí se znovu se stejnými daty a prvni_zaslani=false.
    const cause = err.cause ? ` ${err.cause.code || err.cause.message}` : '';
    return { vysledek: 'bez_odpovedi', text: `${err.name === 'TimeoutError' ? 'Překročena doba odezvy' : err.message}${cause}` };
  }
}

module.exports = { sendRecord, certInfo, mock, kcToEet, datovaVeta, sestavObalku, podepis, zpracujOdpoved, MASKY };
