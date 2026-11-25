CREATE TABLE sluzby (
  id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nazev  VARCHAR(100)  NOT NULL,
  cena   DECIMAL(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;

CREATE TABLE eet (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  firma            TINYINT UNSIGNED NOT NULL,  -- číslo firmy (IČO) z .env: 1 = FIRMA1_*, 2 = FIRMA2_*
  id_pozadavku     CHAR(36)      NOT NULL,  -- z tabletu: dvojklik ani výpadek Wi-Fi neuloží tržbu dvakrát
  nazev            VARCHAR(100)  NOT NULL,  -- název služby
  castka           DECIMAL(10,2) NOT NULL,  -- v Kč, storno je záporné
  cas              DATETIME      NOT NULL,  -- čas tržby v UTC (v Praze +1 h, v létě +2 h)
  puvodni_id       INT UNSIGNED  NULL,      -- jen u storna: stornovaná tržba
  stav             ENUM('ceka','odeslano','chyba') NOT NULL DEFAULT 'ceka',
  pokusy           SMALLINT UNSIGNED NOT NULL DEFAULT 0,  -- kolikrát se odesílalo (pro prvni_zaslani)
  chyba            VARCHAR(500)  NULL,      -- poslední chyba nebo varování z EET
  pok              VARCHAR(64)   NULL,      -- potvrzovací kód od Finanční správy
  UNIQUE KEY uq_pozadavek (id_pozadavku),
  UNIQUE KEY uq_puvodni (puvodni_id),       -- tržbu lze stornovat jen jednou
  UNIQUE KEY uq_pok (pok),
  KEY ix_stav (stav),
  KEY ix_firma_cas (firma, cas),
  CONSTRAINT fk_puvodni FOREIGN KEY (puvodni_id) REFERENCES eet (id),
  CONSTRAINT chk_druh CHECK ((puvodni_id IS NULL AND castka > 0)
                          OR (puvodni_id IS NOT NULL AND castka < 0)),
  CONSTRAINT chk_odeslano CHECK (stav <> 'odeslano' OR pok IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;
