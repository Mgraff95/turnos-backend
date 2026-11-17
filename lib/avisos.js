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
      // Los dígitos, no lo que se escribió: el transporte arma `+549<telefono>`,
      // así que un número cargado en el panel como "11 9876-5432" se convierte
      // en "+54911 9876-5432", Wassenger lo rechaza y la profesional no recibe
      // nada sin que nadie se entere. Normalizar solo para comparar no alcanza.
      telefono: clave,
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

// ══ El fan-out ═════════════════════════════════════════
//
// Los turnos que llegan acá traen `servicio` pero no `profesional`: son el
// resultado de verificarYReservar y compañía, que incluyen solo el servicio.
// Por eso cada aviso resuelve la profesional con una consulta propia en vez de
// pedirle el include a los doce lugares que avisan.
//
// `deps` existe para los tests: inyectan un prisma y un transporte falsos y la
// regla se prueba sin base ni red. En producción no se pasa nunca.
function resolverDeps(deps = {}) {
  return {
    prisma: deps.prisma || require('./prisma'),
    enviar: deps.enviar || require('../services/whatsapp').enviarMensaje
  };
}

// Un turno cuya fila de `profesionales` ya no existe llega sin nombre. En los
// logs y en los mensajes, "Sin asignar" es peor que el nombre real y mucho
// mejor que imprimir "null".
function nombreDe(profesional) {
  return (profesional && profesional.nombre) || 'Sin asignar';
}

async function profesionalDe(prisma, profesionalId) {
  if (!profesionalId) return null;
  try {
    return await prisma.profesional.findUnique({
      where: { id: profesionalId },
      select: { nombre: true, telefono: true }
    });
  } catch (error) {
    // Una consulta que falla no puede tapar el aviso al estudio: sale sin el
    // nombre de quien atiende, que es peor que con nombre y mucho mejor que nada.
    console.error(`⚠️  No se pudo resolver la profesional ${profesionalId}:`, error.message);
    return null;
  }
}

// Un envío con su propio catch: que el aviso a la profesional falle (teléfono
// mal cargado, Wassenger caído) no puede llevarse puesto el del estudio, ni al
// revés. Tampoco puede tirar la operación que lo disparó.
async function mandar(enviar, telefono, texto, queEs) {
  try {
    return await enviar(telefono, texto);
  } catch (error) {
    console.error(`❌ ${queEs} no enviado:`, error.message);
    return false;
  }
}

// Manda un mensaje por destinatario. Devuelve cuántos salieron.
async function enviarTodos(lista, texto, enviar) {
  const envios = lista.map(destinatario => {
    let mensaje;
    try {
      mensaje = texto(destinatario);
    } catch (error) {
      console.error(`❌ Aviso a ${destinatario.tipo} no armado:`, error.message);
      return Promise.resolve(false);
    }
    return mandar(enviar, destinatario.telefono, mensaje, `aviso a ${destinatario.tipo}`);
  });
  const resultados = await Promise.all(envios);
  return resultados.filter(Boolean).length;
}

function paraElTurnoDe(profesional, incluirEstudio) {
  return destinatarios({
    telefonoEstudio: process.env.DANIELA_TELEFONO,
    profesional,
    incluirEstudio
  });
}

// Todos los avisos de turno comparten la misma forma: resolver la profesional,
// armar los destinatarios y mandar a cada uno su versión del texto.
// Sin teléfono cargado no hay a dónde mandarle, y el descarte tiene que quedar
// anotado: si no, la única forma de enterarse de que no se le está avisando es
// que ella se queje. El caso de Daniela no es un descarte —su número es el del
// estudio y ya recibió el mensaje completo—, así que se mira el teléfono, no si
// quedó en la lista.
function anotarSiNoTieneTelefono(profesional) {
  if (profesional && !normalizarTelefono(profesional.telefono)) {
    console.log(`⚠️  ${nombreDe(profesional)} no tiene teléfono cargado: no recibe el aviso`);
  }
}

async function avisar(turno, opciones, texto) {
  const { prisma, enviar } = resolverDeps(opciones.deps);
  const profesional = await profesionalDe(prisma, turno.profesional_id);
  anotarSiNoTieneTelefono(profesional);

  return enviarTodos(paraElTurnoDe(profesional, opciones.incluirEstudio !== false), texto, enviar);
}

const whatsapp = () => require('../services/whatsapp');

async function avisarNuevoTurno(turno, opciones = {}) {
  return avisar(turno, opciones, d => whatsapp().textoNuevoTurno(turno, d));
}

async function avisarNuevoTurnoGrupo(turnos, opciones = {}) {
  if (!turnos || turnos.length === 0) return 0;
  return avisar(turnos[0], opciones, d => whatsapp().textoNuevoTurnoGrupo(turnos, d));
}

async function avisarCancelacion(turno, opciones = {}) {
  return avisar(turno, opciones, d => whatsapp().textoCancelacion(turno, d));
}

async function avisarCancelacionGrupo(turnos, opciones = {}) {
  if (!turnos || turnos.length === 0) return 0;
  return avisar(turnos[0], opciones, d => whatsapp().textoCancelacionGrupo(turnos, d));
}

// Modificar un turno puede cambiarle la profesional: desde el panel se puede
// cambiar el servicio, y la profesional se recalcula con él. Cuando pasa, no es
// una modificación para las profesionales: una lo pierde y la otra lo gana.
async function avisarModificacion(turnoAnterior, turnoNuevo, opciones = {}) {
  const incluirEstudio = opciones.incluirEstudio !== false;

  if (turnoAnterior.profesional_id === turnoNuevo.profesional_id) {
    return avisar(turnoNuevo, opciones, d => whatsapp().textoModificacion(turnoAnterior, turnoNuevo, d));
  }

  const { prisma, enviar } = resolverDeps(opciones.deps);
  const [anterior, nueva] = await Promise.all([
    profesionalDe(prisma, turnoAnterior.profesional_id),
    profesionalDe(prisma, turnoNuevo.profesional_id)
  ]);

  anotarSiNoTieneTelefono(anterior);
  anotarSiNoTieneTelefono(nueva);

  // Al estudio, la modificación completa, con el nombre de la profesional que
  // se queda el turno. Las dos llamadas con incluirEstudio: false de abajo
  // dejan afuera el número del estudio, así que nadie recibe dos mensajes.
  const alEstudio = incluirEstudio
    ? await enviarTodos(
      paraElTurnoDe(nueva, true).filter(d => d.tipo === 'estudio'),
      d => whatsapp().textoModificacion(turnoAnterior, turnoNuevo, d),
      enviar
    )
    : 0;

  const aLaQuePierde = await enviarTodos(
    paraElTurnoDe(anterior, false),
    d => whatsapp().textoCancelacion(turnoAnterior, d),
    enviar
  );

  const aLaQueGana = await enviarTodos(
    paraElTurnoDe(nueva, false),
    d => whatsapp().textoNuevoTurno(turnoNuevo, d),
    enviar
  );

  return alEstudio + aLaQuePierde + aLaQueGana;
}

// ══ Las agendas de mañana ══════════════════════════════
//
// Las manda el cron de las 19:00 (lib/scheduler.js). Daniela recibe la del
// estudio, que es la única que ve el día completo, y nunca además la suya: sus
// turnos ya figuran ahí bajo su nombre. Cada profesional recibe la suya solo si
// tiene turnos — un mensaje diario diciendo "no tenés nada" es ruido.
async function enviarAgendasDeManana(fecha, opciones = {}) {
  const { prisma, enviar } = resolverDeps(opciones.deps);
  const { agruparPorReserva, horarioDelEstudio, agendaPorProfesional } = require('./agenda');

  const turnos = await prisma.turno.findMany({
    where: { fecha: new Date(fecha), estado: 'confirmado' },
    include: { servicio: true, profesional: true },
    orderBy: [{ hora_inicio: 'asc' }, { orden_en_grupo: 'asc' }]
  });

  const grupos = agruparPorReserva(turnos);
  const porProfesional = agendaPorProfesional(grupos);

  const telefonoEstudio = process.env.DANIELA_TELEFONO;
  const vistos = new Set();
  let enviados = 0;

  // Al estudio siempre, incluso un día sin turnos: Daniela cuenta con ese
  // mensaje todas las noches y su ausencia no se distingue de una falla.
  const claveEstudio = normalizarTelefono(telefonoEstudio);
  if (claveEstudio) {
    vistos.add(claveEstudio);
    const texto = whatsapp().textoAgendaEstudio(fecha, {
      horario: horarioDelEstudio(grupos),
      porProfesional
    });
    if (await mandar(enviar, claveEstudio, texto, 'agenda del estudio')) enviados++;
  } else {
    console.log('⚠️  DANIELA_TELEFONO no configurado: no sale la agenda del estudio');
  }

  for (const { profesional, grupos: suyos } of porProfesional) {
    const clave = normalizarTelefono(profesional.telefono);
    if (!clave) {
      console.log(`⚠️  ${nombreDe(profesional)} no tiene teléfono cargado: no recibe su agenda`);
      continue;
    }
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const texto = whatsapp().textoAgendaProfesional(fecha, suyos);
    if (await mandar(enviar, clave, texto, `agenda de ${nombreDe(profesional)}`)) enviados++;
  }

  return enviados;
}

module.exports = {
  normalizarTelefono,
  destinatarios,
  enviarAgendasDeManana,
  avisarNuevoTurno,
  avisarNuevoTurnoGrupo,
  avisarCancelacion,
  avisarCancelacionGrupo,
  avisarModificacion
};
