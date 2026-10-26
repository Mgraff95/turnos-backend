// Antelación mínima para reservar desde la web.
//
// Una clienta no puede tomar un turno que arranque dentro de las próximas
// ANTELACION_MINIMA_HORAS. Es una ventana rodante contra el reloj, no una regla
// de calendario: a las 18:00 del lunes, el martes al mediodía ya no se puede.
//
// Daniela NO está sujeta a esto: las rutas del panel van con authAdmin y no
// llaman a estas funciones, así que conserva el walk-in y el relleno de huecos
// que se liberan hoy.

const ANTELACION_MINIMA_HORAS = 24;

// Offset fijo de Argentina. Fijo y no calculado porque el país no tiene horario
// de verano, así que -03:00 vale todo el año.
const OFFSET_ARG = '-03:00';

// Convierte (fecha, "HH:MM") en el instante real del turno.
//
// El server corre en UTC y `hora_inicio` está en hora argentina, así que hay que
// forzar el offset. Construir la fecha sin él corre el cálculo tres horas, que
// para una ventana de 24 es la diferencia entre aceptar y rechazar. Es el mismo
// patrón de lib/scheduler.js:182, y el comentario de services/mercadopago.js
// avisa que este bug ya rompió algo antes.
//
// `fecha` puede venir como 'YYYY-MM-DD', como el ISO completo que devuelve
// Prisma para una columna @db.Date, o como Date.
function instanteDelTurno(fecha, horaInicio) {
  const soloFecha = fecha instanceof Date
    ? fecha.toISOString().split('T')[0]
    : String(fecha).split('T')[0];

  return new Date(`${soloFecha}T${horaInicio}:00${OFFSET_ARG}`);
}

// ¿El turno arranca dentro de las próximas `horas`?
//
// true significa que está demasiado cerca (o ya pasó) y hay que rechazarlo.
// El borde exacto queda AFUERA: a 24 horas justas se puede reservar.
//
// `ahora` es inyectable para poder testear el borde sin depender del reloj.
function faltanMenosDe(horas, fecha, horaInicio, ahora = new Date()) {
  const inicio = instanteDelTurno(fecha, horaInicio);
  const limite = ahora.getTime() + horas * 60 * 60 * 1000;
  return inicio.getTime() < limite;
}

// Atajo con la constante del proyecto, para no repetir el 24 en cada llamador.
function demasiadoCerca(fecha, horaInicio, ahora = new Date()) {
  return faltanMenosDe(ANTELACION_MINIMA_HORAS, fecha, horaInicio, ahora);
}

// El error que ven las rutas públicas.
function errorAntelacion() {
  return Object.assign(new Error('ANTELACION_INSUFICIENTE'), {
    status: 400,
    publico: `Los turnos se reservan con al menos ${ANTELACION_MINIMA_HORAS} horas de anticipación. Para un turno más próximo, escribinos.`
  });
}

module.exports = {
  ANTELACION_MINIMA_HORAS,
  instanteDelTurno,
  faltanMenosDe,
  demasiadoCerca,
  errorAntelacion
};
