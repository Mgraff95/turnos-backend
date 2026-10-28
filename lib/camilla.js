// Conflictos que CRUZAN agendas.
//
// Las agendas de Daniela y Elsa corren en paralelo a propósito: que una tenga
// un turno a las 10 no le ocupa las 10 a la otra. Pero hay dos cosas del mundo
// real que no se duplican cuando se duplica la agenda:
//
//  1. LA CAMILLA. Hay una sola en el estudio. Dos servicios que la usan no
//     pueden solaparse, aunque sean de profesionales distintas. Las uñas no la
//     usan, así que ésas sí siguen corriendo en paralelo — era exactamente el
//     pedido: el turno de Elsa bloquea la camilla de Daniela, no sus uñas.
//
//  2. LA CLIENTA. Una persona no puede estar en dos sillas a la vez, así que
//     no puede tener dos turnos solapados con profesionales distintas.
//
// Nada de esto aplica DENTRO de una agenda. Ahí el solapamiento ya lo decide la
// intercalación, y que la misma clienta se haga PRP y pies a la vez con Daniela
// es justamente para lo que la intercalación existe.
//
// Este módulo es puro: recibe los turnos ajenos ya leídos y no toca la base.
// Quien consulta la base es lib/availability.js.
const { esLaMismaPersona } = require('./persona');

// `turnosAjenos` son los turnos confirmados de OTRAS profesionales que se
// solapan con el rango que se quiere reservar. Devuelve el conflicto
// ({ codigo, turno }) o null si no hay ninguno.
function evaluarConflictoCruzado({ turnosAjenos = [], usaCamilla = false, cliente } = {}) {
  // La persona primero. Cuando el turno que choca es de ella, decírselo así
  // ("ya tenés X con Elsa a las 10") es mucho más útil que hablarle de una
  // camilla que nunca vio: sabe cuál de los dos turnos mover.
  if (cliente) {
    const propio = turnosAjenos.find(t => esLaMismaPersona(t, cliente));
    if (propio) return { codigo: 'MISMA_PERSONA', turno: propio };
  }

  if (usaCamilla) {
    const camilla = turnosAjenos.find(t => t.servicio && t.servicio.usa_camilla);
    if (camilla) return { codigo: 'CAMILLA_OCUPADA', turno: camilla };
  }

  return null;
}

// El texto que ve la clienta. Tiene que explicarle qué mover, no solo que no
// se puede.
function mensajeDeConflicto(conflicto) {
  if (!conflicto) return null;
  const t = conflicto.turno || {};
  const rango = t.hora_inicio && t.hora_fin ? `de ${t.hora_inicio} a ${t.hora_fin}` : '';

  if (conflicto.codigo === 'MISMA_PERSONA') {
    // El turno es suyo, así que nombrarlo no revela nada de nadie. Si falta
    // algún dato se degrada a "un turno" en vez de dejar el cabo suelto.
    const servicio = t.servicio && t.servicio.nombre;
    const profesional = t.profesional && t.profesional.nombre;
    const queEs = [servicio, profesional && `con ${profesional}`].filter(Boolean).join(' ');
    const cual = [queEs || 'un turno', rango].filter(Boolean).join(' ');
    return `Ese horario se te cruza con otro turno tuyo: ya tenés ${cual}. ` +
      'No te podemos atender en los dos servicios al mismo tiempo, así que ' +
      'elegí otro horario para alguno de los dos y listo.';
  }

  // El turno de la camilla es de OTRA clienta: del lado de afuera solo se
  // cuenta que el horario está tomado, nunca de quién ni de qué.
  return `Ese horario no nos queda libre: la camilla del estudio ya está ocupada ${rango || 'en ese horario'}. ` +
    'Elegí otro horario para este servicio y lo tomamos sin problema.';
}

// Error listo para que la ruta lo devuelva. 409 porque es un choque con el
// estado actual de las agendas, igual que HORARIO_NO_DISPONIBLE.
function errorDeConflictoCruzado(conflicto) {
  return Object.assign(new Error(conflicto.codigo), {
    status: 409,
    publico: mensajeDeConflicto(conflicto)
  });
}

module.exports = { evaluarConflictoCruzado, mensajeDeConflicto, errorDeConflictoCruzado };
