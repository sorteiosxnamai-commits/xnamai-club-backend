-- XNaMai Club — PostgreSQL, schema public.
-- Executar no banco existente do Club antes de publicar a nova API.
-- Equivalente ao up de OperationalCorrections1793836800000.
-- Repetir o script não apaga registros nem duplica tabelas/colunas.

BEGIN;

-- Se o banco estiver ocupado, falhar sem manter a implantação bloqueada.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.site_content (
    screen varchar NOT NULL PRIMARY KEY,
    "valuesJson" text NOT NULL DEFAULT '{}',
    revision integer NOT NULL DEFAULT 0,
    "updatedBy" varchar NULL,
    "updatedAt" timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.priority_reservations (
    id varchar NOT NULL PRIMARY KEY,
    "userId" varchar NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL
);

ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS "billingAmountCents" integer NULL;

COMMIT;

-- Conferência: o resultado deve conter estas oito colunas das duas tabelas
-- novas, mais billingAmountCents em subscriptions (nove linhas no total).
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
      (table_name = 'site_content' AND column_name IN
          ('screen', 'valuesJson', 'revision', 'updatedBy', 'updatedAt'))
      OR (table_name = 'priority_reservations' AND column_name IN
          ('id', 'userId', 'expiresAt'))
      OR (table_name = 'subscriptions' AND column_name = 'billingAmountCents')
  )
ORDER BY table_name, ordinal_position;
