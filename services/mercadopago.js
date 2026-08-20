const axios = require('axios');
const crypto = require('crypto');

// Se usa axios directo contra la API en vez del SDK oficial, para mantener el
// mismo patrón que services/whatsapp.js y no quedar atados a breaking changes
// del SDK.
const MP_API = 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
// Opcional: la clave del modo de prueba, para poder probar el circuito completo
// antes de tener las credenciales productivas.
const MP_WEBHOOK_SECRET_TEST = process.env.MP_WEBHOOK_SECRET_TEST;
const BACKEND_URL = process.env.BACKEND_URL || 'https://turnos-backend-production-149e.up.railway.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://turnos.danielayanetbeauty.com';

function estaConfigurado() {
  return !!MP_ACCESS_TOKEN;
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    ...extra
  };
}

// UUID sin depender de la librería: alcanza para la clave de idempotencia.
function nuevaClaveIdempotencia() {
  return crypto.randomUUID();
}

// Formatea una fecha en ISO 8601 CON offset explícito de Argentina (-03:00).
//
// Railway corre en UTC. Mercado Pago documenta el formato
// yyyy-MM-dd'T'HH:mm:ss.sss-03:00 y este bug (construir fechas sin offset) ya
// rompió los recordatorios del sistema una vez, así que acá se fuerza siempre.
function aISOArgentina(fecha) {
  const OFFSET_MIN = -180; // -03:00
  const local = new Date(fecha.getTime() + OFFSET_MIN * 60 * 1000);
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}` +
    `.${p(local.getUTCMilliseconds(), 3)}-03:00`
  );
}

// ── Crear preferencia de Checkout Pro ──────────────────
// Devuelve { id, init_point, sandbox_init_point }.
async function crearPreferencia({ externalRef, titulo, monto, expiraAt, clienteEmail }) {
  if (!estaConfigurado()) {
    throw Object.assign(new Error('MP_NO_CONFIGURADO'), { status: 503 });
  }

  const preferencia = {
    items: [{
      title: titulo,
      quantity: 1,
      unit_price: Number(monto),
      currency_id: 'ARS'
    }],
    external_reference: externalRef,
    notification_url: `${BACKEND_URL}/api/pagos/webhook`,
    back_urls: {
      success: `${FRONTEND_URL}/reserva/resultado?ref=${externalRef}`,
      pending: `${FRONTEND_URL}/reserva/resultado?ref=${externalRef}`,
      failure: `${FRONTEND_URL}/reserva/resultado?ref=${externalRef}`
    },
    auto_return: 'approved',
    // La preferencia vence junto con el hold: si la clienta la abre tarde, ya
    // no puede pagar un horario que volvió a estar libre.
    expires: true,
    expiration_date_to: aISOArgentina(expiraAt),
    statement_descriptor: 'DANIELA YANET BEAUTY',
    // Sin binary_mode el pago puede quedar en 'in_process' y habría que manejar
    // holds largos. Hoy solo se aceptan tarjeta y dinero en cuenta, así que
    // conviene que apruebe o rechace y listo.
    binary_mode: true
  };

  if (clienteEmail) {
    preferencia.payer = { email: clienteEmail };
  }

  const { data } = await axios.post(
    `${MP_API}/checkout/preferences`,
    preferencia,
    { headers: headers({ 'X-Idempotency-Key': nuevaClaveIdempotencia() }), timeout: 15000 }
  );

  return data;
}

// ── Consultar un pago ──────────────────────────────────
// Es la ÚNICA fuente confiable del estado y el monto: el body del webhook
// nunca se toma como verdad.
async function obtenerPago(paymentId) {
  if (!estaConfigurado()) {
    throw Object.assign(new Error('MP_NO_CONFIGURADO'), { status: 503 });
  }
  const { data } = await axios.get(
    `${MP_API}/v1/payments/${paymentId}`,
    { headers: headers(), timeout: 15000 }
  );
  return data;
}

// ── Buscar pagos por external_reference ────────────────
// Para el cron de reconciliación: detecta pagos aprobados cuyo webhook nunca llegó.
async function buscarPagosPorReferencia(externalRef) {
  if (!estaConfigurado()) return [];
  const { data } = await axios.get(
    `${MP_API}/v1/payments/search`,
    {
      headers: headers(),
      params: { external_reference: externalRef },
      timeout: 15000
    }
  );
  return data.results || [];
}

// ── Reembolsar ─────────────────────────────────────────
// Sin monto = reembolso total.
async function reembolsarPago(paymentId, monto) {
  if (!estaConfigurado()) {
    throw Object.assign(new Error('MP_NO_CONFIGURADO'), { status: 503 });
  }
  const body = monto ? { amount: Number(monto) } : {};
  const { data } = await axios.post(
    `${MP_API}/v1/payments/${paymentId}/refunds`,
    body,
    { headers: headers({ 'X-Idempotency-Key': nuevaClaveIdempotencia() }), timeout: 15000 }
  );
  return data;
}

// ── Validar la firma del webhook ───────────────────────
//
// Sin esto, cualquiera puede postear una notificación falsa de "aprobado" al
// endpoint público y llevarse un turno gratis.
//
// El manifest es literal: id, request-id y ts separados por ";", con ";" final.
// El data.id va SIEMPRE en minúsculas.
//
// Ojo: la clave secreta es distinta entre el entorno de prueba y el productivo.
// Mezclarlas hace que la validación falle sin ningún mensaje útil.
function validarFirmaWebhook(xSignature, xRequestId, dataId) {
  // Mercado Pago genera una clave secreta distinta para el modo de prueba y
  // para el productivo. Se aceptan las dos si están configuradas, así se puede
  // probar con credenciales de prueba sin tener que cambiar la variable de
  // entorno el día que se sale a producción (y sin riesgo de equivocarse en el
  // cambio). Ambas son claves propias: aceptar las dos no abre nada a terceros.
  const secretos = [MP_WEBHOOK_SECRET, MP_WEBHOOK_SECRET_TEST].filter(Boolean);
  if (secretos.length === 0) {
    console.error('❌ Ninguna clave secreta de webhook configurada: se rechaza');
    return false;
  }
  if (!xSignature || !xRequestId || dataId === undefined || dataId === null) return false;

  let ts, hash;
  String(xSignature).split(',').forEach(parte => {
    const [k, v] = parte.split('=').map(x => x && x.trim());
    if (k === 'ts') ts = v;
    if (k === 'v1') hash = v;
  });
  if (!ts || !hash) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${ts};`;
  const recibido = Buffer.from(hash, 'utf8');

  return secretos.some(secreto => {
    const calculado = Buffer.from(
      crypto.createHmac('sha256', secreto).update(manifest).digest('hex'),
      'utf8'
    );
    // timingSafeEqual explota si los buffers miden distinto: se compara el
    // largo primero.
    if (calculado.length !== recibido.length) return false;
    return crypto.timingSafeEqual(calculado, recibido);
  });
}

module.exports = {
  crearPreferencia,
  obtenerPago,
  buscarPagosPorReferencia,
  reembolsarPago,
  validarFirmaWebhook,
  estaConfigurado,
  aISOArgentina
};
