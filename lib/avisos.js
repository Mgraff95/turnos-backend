// Quién recibe cada aviso.
//
// Antes esta pregunta no existía: todo salía a DANIELA_TELEFONO y los mensajes
// se armaban y se mandaban en services/whatsapp.js. Con más de una profesional
// hay dos destinatarios posibles por hecho —el estudio y la profesional del
// turno— y la regla de quién recibe qué es justo lo que se puede equivocar en
// silencio. Vive acá, en un solo lugar, para poder testearla sin base ni red:
// services/whatsapp.js arma los textos y los manda, y este módulo decide a
// quién.
//
// Daniela es la profesional 1 Y es el estudio. Por eso la deduplicación no es
// un detalle: sin ella recibiría dos mensajes iguales por cada turno suyo.

// Los teléfonos vienen de dos lados (la env del estudio y la tabla de
// profesionales) y nadie garantiza que estén escritos igual. Para comparar hay
// que mirar solo los dígitos.
function normalizarTelefono(tel) {
  if (!tel) return null;
  const digitos = String(tel).replace(/\D/g, '');
  return digitos === '' ? null : digitos;
}

// Devuelve a quién mandarle un aviso de turno, en orden.
//
// - `telefonoEstudio`: el número del estudio (DANIELA_TELEFONO), o null.
// - `profesional`: { nombre, telefono } de la dueña del turno, o null si la
//   fila ya no existe. Sin teléfono cargado, no recibe nada: el aviso al
//   estudio sale igual.
// - `incluirEstudio`: false cuando el movimiento lo hizo Daniela desde el panel
//   (no tiene sentido que se lo avise a sí misma).
//
// El estudio va primero y gana el desempate: si la profesional del turno es
// Daniela, el único mensaje que sale es el del estudio, que es el completo.
function destinatarios({ telefonoEstudio, profesional, incluirEstudio = true }) {
  const lista = [];
  const vistos = new Set();

  const agregar = (telefono, tipo) => {
    const clave = normalizarTelefono(telefono);
    if (!clave || vistos.has(clave)) return;
    vistos.add(clave);
    lista.push({
      telefono,
      tipo,
      profesionalNombre: profesional ? profesional.nombre : null
    });
  };

  // El número del estudio queda tomado incluso cuando no se le manda: Daniela
  // recibe la versión del estudio o nada. Si se la dejara caer acá, un turno
  // suyo cargado desde el panel le llegaría como "te agendaron un turno",
  // avisándole de algo que acaba de hacer ella.
  if (incluirEstudio) agregar(telefonoEstudio, 'estudio');
  else vistos.add(normalizarTelefono(telefonoEstudio));

  if (profesional) agregar(profesional.telefono, 'profesional');

  return lista;
}

module.exports = { normalizarTelefono, destinatarios };
