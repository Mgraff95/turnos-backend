// Resolución del horario de un día.
//
// Una fila de `horarios_config` con `fecha = null` es el horario semanal de
// siempre. Una fila con fecha es una excepción para ese día puntual, y
// REEMPLAZA al semanal: sirve para alargar (el sábado que se atiende 9 a 20 en
// vez de 10 a 15), para acortar sin necesitar un bloqueo, y para abrir un día
// que normalmente está cerrado.
//
// Para CERRAR un día o un rato sigue estando `bloques_cerrados`, que se aplica
// encima de lo que devuelva esta función.
//
// Vive separada de la consulta para poder testearla sola: la query trae los
// semanales del día de semana y las excepciones de la fecha, y acá se decide
// cuáles mandan.

function rangosQueAplican(filas) {
  if (!Array.isArray(filas) || filas.length === 0) return [];

  const excepciones = filas.filter(f => f.fecha != null);

  // Si hay aunque sea una excepción para esa fecha, el horario de siempre no
  // corre: ese día se atiende exactamente lo que dice la excepción.
  return excepciones.length > 0 ? excepciones : filas;
}

module.exports = { rangosQueAplican };
