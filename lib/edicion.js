// Las decisiones de editar un turno que ya existe.
//
// Viven acá y no dentro de la ruta porque son las que se equivocan en silencio:
// recongelar la plata de un turno que no cambió de manos altera una liquidación
// ya compartida, y avisarle a la clienta de un movimiento interno del estudio la
// confunde sin motivo. Puras, así se prueban sin base ni HTTP.

// Prisma devuelve `fecha` como Date (columna @db.Date) y del body viene como
// 'YYYY-MM-DD'. Para comparar hay que llevar las dos al mismo día.
function dia(fecha) {
  return fecha instanceof Date
    ? fecha.toISOString().split('T')[0]
    : String(fecha).split('T')[0];
}

// Qué cambió entre el turno que está en la base y lo que llega del panel, y qué
// consecuencias tiene cada cosa.
//
// - `recalcularPlata`: solo si cambió QUÉ se hace o QUIÉN lo hace. Una
//   corrección de datos de la clienta no puede re-congelar el precio a los
//   valores de hoy.
// - `avisarClienta`: lo de siempre — servicio, fecha u hora. Un cambio de
//   profesional es organización interna y no le llega.
// - `avisarProfesionales`: todo lo anterior más la reasignación, porque la que
//   pierde el turno y la que lo gana tienen que enterarse.
function cambiosDeTurno(turnoActual, datos) {
  const servicio = Number(datos.servicio_id) !== Number(turnoActual.servicio_id);
  const profesional = Number(datos.profesional_id) !== Number(turnoActual.profesional_id);
  const fecha = dia(datos.fecha) !== dia(turnoActual.fecha);
  const hora = datos.hora_inicio !== turnoActual.hora_inicio;

  return {
    servicio,
    fecha,
    hora,
    profesional,
    recalcularPlata: servicio || profesional,
    avisarClienta: servicio || fecha || hora,
    avisarProfesionales: servicio || fecha || hora || profesional
  };
}

// Cuánto dura realmente el turno.
//
// Los cinco caminos que crean turnos suman los minutos de los extras; los dos
// que editan no lo hacían, así que mover un turno con extras le acortaba el
// hora_fin y liberaba tiempo que en realidad estaba ocupado.
function duracionConExtras(servicio, extras) {
  const minutosExtra = (extras || []).reduce((s, e) => s + (e.minutos_adicionales || 0), 0);
  return servicio.duracion_minutos + minutosExtra;
}

// ¿Se le puede cambiar la profesional a este turno?
//
// No, si es una pata de una reserva múltiple: el bloque es continuo y la
// camilla y el encadenado de servicios están pensados para una sola agenda.
// Partirlo entre dos profesionales deja algo que el camino de alta no permite
// crear. El resto de la edición de ese turno sigue abierta.
function puedeReasignar(turnoActual, profesionalIdNuevo) {
  const cambia = Number(profesionalIdNuevo) !== Number(turnoActual.profesional_id);
  if (cambia && turnoActual.grupo_reserva) {
    return { ok: false, motivo: 'BLOQUE_NO_SE_REASIGNA' };
  }
  return { ok: true };
}

// ¿La clienta puede cambiarle el servicio a este turno?
//
// No, si ya pagó. La seña y el saldo no se pueden recalcular sin decidir quién
// pone la diferencia cuando el servicio nuevo sale más o menos, y eso es una
// conversación, no un formulario. Hoy no puede pasar porque el cobro online
// está apagado; el freno existe para que el día que se prenda no haya un bug de
// plata esperando.
function puedeCambiarServicio(turno) {
  if (turno.pago_realizado) {
    return { ok: false, motivo: 'PAGADO_NO_SE_CAMBIA' };
  }
  return { ok: true };
}

const MENSAJES_EDICION = {
  BLOQUE_NO_SE_REASIGNA: 'Este turno es parte de una reserva de varios servicios, así que no se puede pasar a otra profesional. Para repartirlo, cancelalo y cargá los turnos por separado.',
  PAGADO_NO_SE_CAMBIA: 'Este turno ya tiene un pago hecho, así que el servicio no se puede cambiar desde acá. Escribinos y lo arreglamos: según el servicio que quieras, puede quedar un saldo a favor o algo para abonar.'
};

module.exports = {
  cambiosDeTurno,
  duracionConExtras,
  puedeReasignar,
  puedeCambiarServicio,
  MENSAJES_EDICION
};
