// Helpers compartidos entre las rutas que arman una reserva.
// Viven acá para que la cotización (/api/pagos) y la creación del turno
// (/api/turnos, /api/admin/turnos) resuelvan exactamente lo mismo: si divergen,
// se cobra un monto y se reserva otro.
const prisma = require('./prisma');

// ── Validar teléfono argentino (10 dígitos) ────
// Devuelve el teléfono normalizado, o null si no es válido.
function validarTelefono(tel) {
  if (!tel) return null;
  const limpio = String(tel).replace(/\D/g, '');
  return /^\d{10}$/.test(limpio) ? limpio : null;
}

// ── Resolver extras válidos para un servicio ───
// Devuelve solo los extras activos que efectivamente se ofrecen para ese servicio.
async function resolverExtras(extrasInput, servicioId) {
  if (!extrasInput) return [];
  const arr = Array.isArray(extrasInput)
    ? extrasInput
    : String(extrasInput).split(',');
  const ids = arr.map(n => parseInt(n)).filter(n => !isNaN(n));
  if (ids.length === 0) return [];
  return prisma.extra.findMany({
    where: {
      id: { in: ids },
      activo: true,
      servicios_ids: { has: servicioId }
    }
  });
}

module.exports = { validarTelefono, resolverExtras };
