'use strict';
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');

describe('Pokladna a administrace', () => {
  let app;
  before(async () => { app = h.app(); });
  beforeEach(h.resetDb);
  after(h.teardown);

  it('uloží platbu, hned ji odešle do EET a vrátí POK', async () => {
    const res = await h.request(app).post('/api/platby').send(h.body({ castka: 320.5 })).expect(200);
    assert.equal(res.body.stav, 'odeslano');
    assert.equal(res.body.nazev, 'Pánský střih');
    assert.equal(res.body.castka, 320.5);
    assert.match(res.body.pok, /-ff$/);
    assert.equal(h.mock.log.length, 1);
  });

  it('stejný požadavek dvakrát (dvojklik, výpadek Wi-Fi) uloží jen jednu platbu', async () => {
    const b = h.body();
    const [a, c] = await Promise.all([h.request(app).post('/api/platby').send(b), h.request(app).post('/api/platby').send(b)]);
    assert.equal(a.body.id, c.body.id);
    const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM eet');
    assert.equal(n, 1);
    assert.equal(h.mock.log.length, 1);
  });

  it('odmítne neplatné vstupy', async () => {
    for (const b of [h.body({ castka: 0 }), h.body({ castka: 10.555 }), h.body({ castka: '350' }), h.body({ castka: -5 }), h.body({ castka: 2_000_000 }),
      h.body({ id_pozadavku: 'x' }), h.body({ sluzba_id: 999 })]) {
      await h.request(app).post('/api/platby').send(b).expect(400);
    }
  });

  it('odmítne požadavek, který není JSON nebo je z cizí stránky (CSRF)', async () => {
    await h.request(app).post('/api/platby').type('form').send('castka=1').expect(403);
    await h.request(app).post('/api/platby').set('Origin', 'http://zlo.example').send(h.body()).expect(403);
  });

  it('storno vytvoří záporný záznam navázaný na původní, nic nemaže a nejde dvakrát', async () => {
    const p = (await h.request(app).post('/api/platby').send(h.body())).body;
    await h.request(app).post(`/api/admin/platby/${p.id}/storno`).send({ id_pozadavku: crypto.randomUUID(), duvod: 'Bez hesla' }).expect(401);
    const a = await h.admin(h.request.agent(app));
    const s = await a.post(`/api/admin/platby/${p.id}/storno`).send({ id_pozadavku: crypto.randomUUID(), duvod: 'Chybná cena' }).expect(200);
    assert.equal(s.body.castka, -350);
    assert.equal(s.body.puvodni_id, p.id);
    assert.equal(s.body.stav, 'odeslano');
    assert.equal((await h.platba(p.id)).castka, 350);

    await a.post(`/api/admin/platby/${p.id}/storno`).send({ id_pozadavku: crypto.randomUUID(), duvod: 'Znovu' }).expect(409);
    await a.post(`/api/admin/platby/${s.body.id}/storno`).send({ id_pozadavku: crypto.randomUUID(), duvod: 'Storno storna' }).expect(400);
    await a.post(`/api/admin/platby/${p.id}/storno`).send({ id_pozadavku: crypto.randomUUID(), duvod: '' }).expect(400);
  });

  it('administrace vyžaduje heslo a zkoušení hesel zablokuje', async () => {
    await h.request(app).get('/api/admin/stav').expect(401);
    await h.request(app).post('/api/admin/sluzby').send({ nazev: 'X', cena: 100 }).expect(401);
    const a = h.app();
    for (let i = 0; i < 5; i++) await h.request(a).post('/api/admin/login').send({ heslo: 'spatne' }).expect(401);
    await h.request(a).post('/api/admin/login').send({ heslo: 'admin-heslo-123' }).expect(429);
  });

  it('přihlášený admin spravuje služby a vidí přehled dne', async () => {
    const a = await h.admin(h.request.agent(app));
    const { id } = (await a.post('/api/admin/sluzby').send({ nazev: 'Melír', cena: 1500 }).expect(200)).body;
    await a.put(`/api/admin/sluzby/${id}`).send({ nazev: 'Melír celý', cena: 1600 }).expect(200);
    await a.post('/api/admin/sluzby').send({ nazev: '', cena: 100 }).expect(400);

    const p = (await h.request(app).post('/api/platby').send(h.body({ sluzba_id: id, castka: 1600 }))).body;
    await h.request(app).post('/api/platby').send(h.body({ castka: 350 }));
    await a.post(`/api/admin/platby/${p.id}/storno`).send({ id_pozadavku: crypto.randomUUID(), duvod: 'Vráceno' }).expect(200);
    await a.delete(`/api/admin/sluzby/${id}`).send({}).expect(200);

    const datum = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });
    const { souhrn, platby } = (await a.get(`/api/admin/prehled?datum=${datum}`).expect(200)).body;
    assert.equal(souhrn.castka, 350); // 1600 + 350 − 1600 (storno)
    assert.equal(souhrn.pocet, 3);
    assert.equal(platby.length, 3);
    assert.equal(platby.find((x) => x.id === p.id).nazev, 'Melír celý'); // název zůstal i po smazání služby

    await a.post('/api/admin/logout').send({}).expect(200);
    await a.get('/api/admin/stav').expect(401);
  });
});
