-- Paso 1 de la migración a segunda profesional.
--
-- Crea la tabla `profesionales` y siembra las dos filas con ids FIJOS, ANTES de
-- correr `prisma db push`.
--
-- POR QUÉ VA SEPARADO
--
-- El SQL que genera `db push` (verificado con `prisma migrate diff`) hace, en
-- este orden:
--   1. ALTER TABLE servicios / horarios_config / turnos
--        ADD COLUMN profesional_id INTEGER NOT NULL DEFAULT 1
--   2. CREATE TABLE profesionales
--   3. ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (profesional_id)
--        REFERENCES profesionales(id)
--
-- Para cuando llega al paso 3, las 504 filas de `turnos` ya tienen
-- profesional_id = 1 por el DEFAULT, pero `profesionales` está recién creada y
-- vacía. Postgres valida la foreign key contra los datos existentes y la
-- rechaza: no hay ninguna fila con id = 1 a la que apuntar.
--
-- Sembrando la fila id 1 primero, la validación del paso 3 pasa y el backfill
-- queda hecho sin un solo UPDATE manual.
--
-- El DDL es idéntico al que emitió `prisma migrate diff`, copiado textual, para
-- que `db push` después no vea ninguna diferencia en esta tabla.
--
-- CÓMO CORRERLO
--
--   npx prisma db execute --file prisma/migracion-profesionales.sql --schema prisma/schema.prisma
--
-- Es idempotente: se puede correr dos veces sin romper nada.

BEGIN;

CREATE TABLE IF NOT EXISTS "profesionales" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "telefono" TEXT,
    "comision_pct_default" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profesionales_pkey" PRIMARY KEY ("id")
);

-- Daniela TIENE que quedar en el id 1: el DEFAULT 1 de las tres foreign keys le
-- asigna a ella todos los servicios, horarios y turnos que ya existen.
--
-- comision_pct_default queda en NULL en las dos:
--   - Daniela: definitivo. Es la dueña del estudio, su facturación ya es del
--     estudio y no hay nada que liquidarle.
--   - Elsa: provisorio. El porcentaje lo carga Daniela desde el panel; un número
--     inventado acá se liquidaría igual que uno decidido.
INSERT INTO "profesionales" ("id", "nombre", "orden", "telefono", "comision_pct_default", "updated_at")
VALUES (1, 'Daniela', 0, NULL, NULL, NOW()),
       (2, 'Elsa',    1, NULL, NULL, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Insertar ids explícitos NO avanza la secuencia del SERIAL. Sin esto, la
-- próxima profesional creada desde el panel intentaría el id 1 y chocaría con la
-- primary key.
SELECT setval(
  pg_get_serial_sequence('profesionales', 'id'),
  (SELECT MAX("id") FROM "profesionales"),
  true
);

COMMIT;
