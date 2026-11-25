'use strict';
// Testy bez databáze: formát částky a času, sestavení zprávy podle XSD, podpis, čtení odpovědí FS.
Object.assign(process.env, { NODE_ENV: 'test' });
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { kcToEet, datovaVeta, sestavObalku, podepis, zpracujOdpoved, MASKY } = require('../src/eet');
const { prahaIso, denUtc } = require('../src/cas');

const FIRMA = { cislo: 1, eic: 'CZ00000019', idJednotky: '243', idPokl: '1' };

describe('EET – formáty', () => {
  it('částka přesně podle XSD', () => {
    for (const [kc, ocek] of [[0.01, '0.01'], [350, '350.00'], [350.5, '350.50'], [-0.5, '-0.50'], [-187.2, '-187.20'], [0.1 + 0.2, '0.30']]) {
      assert.equal(kcToEet(kc), ocek);
      assert.match(ocek, MASKY.celk_trzba);
    }
  });

  it('čas v pražském pásmu s posunem, zimní i letní', () => {
    assert.equal(prahaIso(new Date('2027-01-09T03:25:28Z')), '2027-01-09T04:25:28+01:00');
    assert.equal(prahaIso(new Date('2027-06-09T03:25:28Z')), '2027-06-09T05:25:28+02:00');
  });

  it('hranice pražského dne i v den změny času', () => {
    const [od, do_] = denUtc('2027-03-28');
    assert.equal(od.toISOString(), '2027-03-27T23:00:00.000Z');
    assert.equal(do_.toISOString(), '2027-03-28T22:00:00.000Z');
    assert.equal(denUtc('2027-10-31')[1].toISOString(), '2027-10-31T23:00:00.000Z');
    assert.equal(denUtc('nesmysl'), null);
    assert.equal(denUtc('2027-02-31'), null);
  });

  it('datová věta a obálka mají všechny povinné údaje; overeni jen v ověřovacím módu', () => {
    const d = datovaVeta({ id: 135, cas: new Date('2027-01-09T15:45:36Z'), castka: 3264.5 }, FIRMA);
    assert.deepEqual(d, {
      eic_popl: 'CZ00000019', id_jednotky: '243', id_pokl: '1', porad_cis: '135',
      dat_trzby: '2027-01-09T16:45:36+01:00', celk_trzba: '3264.50',
    });
    const uuid = crypto.randomUUID();
    const xml = sestavObalku({ uuidZpravy: uuid, prvniZaslani: true }, d);
    assert.match(xml, new RegExp(`uuid_zpravy="${uuid}"`));
    assert.match(xml, /prvni_zaslani="true"/);
    assert.doesNotMatch(xml, /overeni=/);
    assert.match(sestavObalku({ uuidZpravy: uuid, overeni: true }, d), /overeni="true"/);
  });
});

describe('EET – podpis WS-Security', () => {
  it('podepíše soap:Body (RSA-SHA256, exc-c14n) a podpis jde ověřit', () => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: 'CZ00000019' }]);
    cert.setIssuer([{ name: 'commonName', value: 'CZ00000019' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    const c = {
      privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
      certBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()),
    };
    const d = datovaVeta({ id: 1, cas: new Date(), castka: 350 }, FIRMA);
    const signed = podepis(sestavObalku({ uuidZpravy: crypto.randomUUID(), prvniZaslani: true }, d), c);

    assert.match(signed, /rsa-sha256/);
    assert.match(signed, /xml-exc-c14n/);
    assert.match(signed, /BinarySecurityToken/);
    const doc = new DOMParser().parseFromString(signed, 'text/xml');
    const v = new SignedXml({ publicCert: certPem, idMode: 'wssecurity', getCertFromKeyInfo: () => null });
    v.loadSignature(doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0]);
    assert.ok(v.checkSignature(signed));
    assert.equal(v.getSignedReferences().length, 1);
    assert.ok(!v.checkSignature(signed.replace('celk_trzba="350.00"', 'celk_trzba="1.00"')));
  });
});

describe('EET – odpovědi FS', () => {
  const NS = 'xmlns:eet="http://fs.gov.cz/eet/schema/v4"';
  const obal = (x) => `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><eet:Odpoved ${NS}>${x}</eet:Odpoved></soapenv:Body></soapenv:Envelope>`;
  const uuid = crypto.randomUUID();
  const pok = `${crypto.randomUUID()}-ff`;

  it('potvrzení s POK a varováním', () => {
    const r = zpracujOdpoved(obal(`<eet:Hlavicka uuid_zpravy="${uuid}"/><eet:Potvrzeni pok="${pok}" test="true"/><eet:Varovani kod_varov="6">Spatny format</eet:Varovani>`), 200, uuid);
    assert.equal(r.vysledek, 'potvrzeno');
    assert.equal(r.pok, pok);
    assert.deepEqual(r.varovani, ['6 Spatny format']);
  });

  it('rozdělení chyb podle kódu', () => {
    const kat = (kod) => zpracujOdpoved(obal(`<eet:Hlavicka uuid_zpravy="${uuid}"/><eet:Chyba kod="${kod}">x</eet:Chyba>`), 200, uuid).vysledek;
    assert.equal(kat(-1), 'chyba_docasna');
    assert.equal(kat(0), 'overeno');
    for (const k of [2, 3, 4, 6, 7]) assert.equal(kat(k), 'chyba_trvala');
    assert.equal(kat(8), 'chyba_nejasna');
  });

  it('cizí UUID, nesmysl nebo chyba serveru se nepovažují za potvrzení', () => {
    assert.equal(zpracujOdpoved(obal(`<eet:Hlavicka uuid_zpravy="${crypto.randomUUID()}"/><eet:Potvrzeni pok="${pok}"/>`), 200, uuid).vysledek, 'chyba_nejasna');
    assert.equal(zpracujOdpoved('<html>Bad gateway', 502, uuid).vysledek, 'chyba_docasna');
    assert.equal(zpracujOdpoved('', 200, uuid).vysledek, 'chyba_nejasna');
  });
});
