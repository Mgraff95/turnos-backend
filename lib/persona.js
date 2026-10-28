// Identidad de una clienta, para impedir que la misma persona tenga dos turnos
// solapados aunque sean con profesionales distintas.
//
// El sistema no tiene cuentas de clienta, así que la identidad se arma con lo
// que hay: teléfono + nombre + apellido.
//
// Solo el teléfono NO alcanza. En un estudio de belleza una mamá reserva para
// ella y para su hija desde el mismo número, y que la hija se haga PRP mientras
// la mamá se hace las uñas es perfectamente posible. Bloquear eso sería romper
// un caso real para cubrir uno raro.
//
// La contracara: si la misma persona escribe "Mari" una vez y "María" la otra,
// el bloqueo se le escapa. Es el precio de no romper el caso de la familia, y
// el daño es menor — se da cuenta sola cuando no puede estar en los dos lados.

// Deja el nombre en una forma comparable: sin acentos, sin mayúsculas y sin
// espacios de más. Así "  MARÍA  josé " y "maria jose" son la misma.
function normalizarNombre(valor) {
  if (!valor) return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca los acentos
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Solo los dígitos: el mismo número escrito con guiones o espacios es el mismo.
function normalizarTelefono(valor) {
  return String(valor || '').replace(/\D/g, '');
}

// `a` y `b` son objetos con cliente_telefono / cliente_nombre / cliente_apellido,
// que es la forma que ya tienen los turnos y los datos de una reserva.
function esLaMismaPersona(a, b) {
  return (
    normalizarTelefono(a.cliente_telefono) === normalizarTelefono(b.cliente_telefono) &&
    normalizarNombre(a.cliente_nombre) === normalizarNombre(b.cliente_nombre) &&
    normalizarNombre(a.cliente_apellido) === normalizarNombre(b.cliente_apellido)
  );
}

module.exports = { esLaMismaPersona, normalizarNombre, normalizarTelefono };
