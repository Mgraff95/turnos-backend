-- Seed de la fila única de configuración de cobros.
-- Correr UNA VEZ desde la Railway Console, después de `npx prisma db push`.
--
--   railway connect   (o la consola de Postgres del proyecto)
--
-- Arranca con cobro_activo = false a propósito: deploya todo el código de pagos
-- sin cambiar el comportamiento de producción. El switch se prende desde el panel
-- admin recién cuando la integración está probada de punta a punta.

INSERT INTO config_pago (id, cobro_activo, sena_monto, hold_minutos, updated_at)
VALUES (1, false, 5000, 12, NOW())
ON CONFLICT (id) DO NOTHING;

-- Verificación
SELECT * FROM config_pago;
