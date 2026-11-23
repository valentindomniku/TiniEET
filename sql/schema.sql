-- TiniEET – tabulky. Jednou naimportovat do databáze tinieet (phpMyAdmin → Import). Částky v Kč, časy v UTC.

CREATE TABLE sluzby (
  id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nazev  VARCHAR(100)  NOT NULL,
  cena   DECIMAL(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;

-- Evidované tržby (prodeje i storna). Id je zároveň pořadové číslo tržby (porad_cis) pro EET.
CREATE TABLE eet (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_pozadavku     CHAR(36)      NOT NULL,  -- z tabletu: dvojklik ani výpadek Wi-Fi neuloží tržbu dvakrát
  nazev            VARCHAR(100)  NOT NULL,  -- název služby
  castka           DECIMAL(10,2) NOT NULL,  -- v Kč, storno je záporné
  cas_utc          DATETIME      NOT NULL,  -- čas tržby v UTC (v Praze +1 h, v létě +2 h)
  puvodni_id       INT UNSIGNED  NULL,      -- jen u storna: stornovaná tržba
  duvod_storna     VARCHAR(200)  NULL,
  stav             ENUM('ceka','odeslano','chyba') NOT NULL DEFAULT 'ceka',
  pokusy           SMALLINT UNSIGNED NOT NULL DEFAULT 0,  -- pro prvni_zaslani a prodlužování čekání
  dalsi_pokus_utc  DATETIME      NULL,      -- kdy zkusit znovu odeslat
  chyba            VARCHAR(500)  NULL,      -- poslední chyba nebo varování z EET
  pok              VARCHAR(64)   NULL,      -- potvrzovací kód od Finanční správy
  UNIQUE KEY uq_pozadavek (id_pozadavku),
  UNIQUE KEY uq_puvodni (puvodni_id),       -- tržbu lze stornovat jen jednou
  UNIQUE KEY uq_pok (pok),
  KEY ix_fronta (stav, dalsi_pokus_utc),
  KEY ix_cas (cas_utc),
  CONSTRAINT fk_puvodni FOREIGN KEY (puvodni_id) REFERENCES eet (id),
  CONSTRAINT chk_druh CHECK ((puvodni_id IS NULL AND castka > 0)
                          OR (puvodni_id IS NOT NULL AND castka < 0 AND duvod_storna IS NOT NULL)),
  CONSTRAINT chk_odeslano CHECK (stav <> 'odeslano' OR pok IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;
