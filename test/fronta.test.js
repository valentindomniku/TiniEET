'use strict';
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { odeslat, zpracujFrontu } = require('../src/fronta');

describe('Fronta odesílání do EET', () => {
  let app;
  before(() => { app = h.app(); });
  beforeEach(h.resetDb);
  after(h.teardown);

  const novaPlatba = async () => (await h.request(app).post('/api/platby').send(h.body())).body;

  it('při výpadku internetu platbu uloží a později odešle jako opakované zaslání', async () => {
    h.mock.chovani = () => ({ typ: 'vypadek' });
    const p = await novaPlatba();
    assert.equal(p.stav, 'ceka');
    assert.equal(p.pokusy, 1);
    assert.match(p.chyba, /výpadek/);

    await zpracujFrontu(); // internet pořád nejde – zůstává ve frontě
    assert.equal((await h.platba(p.id)).stav, 'ceka');

    h.mock.chovani = () => ({ typ: 'potvrzeni' });
    await zpracujFrontu();
    const po = await h.platba(p.id);
    assert.equal(po.stav, 'odeslano');
    assert.deepEqual(h.mock.log.map((l) => l.prvniZaslani), [true, false, false]);
    assert.notEqual(h.mock.log[0].uuid, h.mock.log[1].uuid); // nové UUID zprávy pro každý pokus
  });

  it('dočasná chyba FS (-1) se opakuje, trvalá chyba (4) skončí ve stavu chyba', async () => {
    h.mock.chovani = () => ({ typ: 'chyba', kod: -1 });
    const p = await novaPlatba();
    assert.equal(p.stav, 'ceka');

    h.mock.chovani = () => ({ typ: 'chyba', kod: 4 });
    await zpracujFrontu();
    const po = await h.platba(p.id);
    assert.equal(po.stav, 'chyba');
    assert.match(po.chyba, /^\[4\]/);
  });

  it('admin může platbu s chybou poslat znovu', async () => {
    h.mock.chovani = () => ({ typ: 'chyba', kod: 4 });
    const p = await novaPlatba();
    h.mock.chovani = () => ({ typ: 'potvrzeni' });
    const a = h.request(app);
    const stav = (await a.get('/api/admin/stav?firma=1').expect(200)).body;
    assert.equal(stav.neodeslane.length, 1);
    const res = await a.post(`/api/admin/platby/${p.id}/znovu`).send({}).expect(200);
    assert.equal(res.body.stav, 'odeslano');
  });

  it('souběžné pokusy o stejnou platbu ji odešlou jen jednou', async () => {
    h.mock.chovani = () => ({ typ: 'vypadek' });
    const p = await novaPlatba();
    h.mock.chovani = () => new Promise((r) => setTimeout(() => r({ typ: 'potvrzeni' }), 50));
    const vysledky = await Promise.all([odeslat(p.id), odeslat(p.id), zpracujFrontu()]);
    assert.equal(vysledky.filter((v) => v && v.vysledek === 'potvrzeno').length, 1);
    assert.equal(h.mock.log.length, 2);
    assert.equal(await odeslat(p.id), null); // odeslanou už znovu neposílá
  });
});
