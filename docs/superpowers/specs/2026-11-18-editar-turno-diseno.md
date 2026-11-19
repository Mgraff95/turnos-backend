# Reasignar profesional y cambio de servicio por la clienta — diseño

Fecha: 2026-11-18. Backend y frontend. Revisado contra el código real por un
constructor fresco antes de aprobarse; sus hallazgos están incorporados.

## Intención

Dos pedidos que comparten el mismo corazón —cambiarle a un turno que ya existe
quién lo atiende— y que por eso se diseñan juntos y se implementan en orden.

**Etapa A, el panel.** Daniela necesita poder decir "este turno lo hago yo" o
"pasáselo a Noemí" sin tocar el día, la hora ni el servicio. Es organización
interna del estudio: la clienta no tiene por qué enterarse.

Hoy el único camino es **cambiarle el servicio** a uno de la otra profesional,
porque la profesional del turno se deriva del servicio. Eso cambia lo que se le
va a hacer a la clienta y además le dispara un WhatsApp avisándole del cambio.
No hay forma de mover el turno de manos y dejar todo lo demás quieto.

**Etapa B, la clienta.** Hoy solo puede mover fecha y hora. Tiene que poder
cambiar también el servicio, para no depender de escribirle a Daniela por algo
que el sistema puede resolver.

## Objetivos

**Etapa A**

1. En el panel, al editar un turno, se elige la profesional, con independencia
   de quién sea el dueño del servicio.
2. Si la profesional elegida ya tiene algo en ese rango, el panel **bloquea** y
   dice que el horario ya está ocupado **para ella**, nombrándola.
3. Cambiar **solo** la profesional no le manda ningún mensaje a la clienta.
4. Las dos profesionales sí se enteran: a la que pierde el turno y a la que lo
   gana, con un texto que diga que el turno se reasignó.
5. La plata congelada del turno se recalcula para la profesional nueva.

**Etapa B**

6. La clienta puede cambiar el servicio de su turno, eligiendo día y hora como
   ya hace hoy.
7. Los extras que el servicio nuevo también ofrece se conservan; los demás se
   van, y ella ve la duración y el precio nuevos **antes** de confirmar.
8. Si el servicio nuevo es de otra profesional, el turno pasa a su agenda y se
   valida ahí.
9. La ventana de 24 horas sigue valiendo igual que hoy.

## No-objetivos

- **La antelación del panel no se toca:** Daniela sigue sin límite de horario y
  puede mover un turno a hoy, más temprano o incluso al pasado. Es a propósito.
- La clienta **no elige profesional**: elige servicio, y la profesional viene
  con él.
- Daniela **no** tiene una salida para forzar un choque (decisión 1).
- **No se agrega validación del horario de trabajo en el motor.** Ver "Lo que
  queda afuera".
- No se unifican las dos rutas de edición (ver Enfoques, opción B).

## Anti-objetivos

Esto fracasa, aunque ande, si:

- Una liquidación queda mintiendo porque el turno cambió de manos y la comisión
  congelada no.
- La clienta pierde un extra que había pedido sin verlo en pantalla.
- Un movimiento de organización interna le dispara un WhatsApp a la clienta.
- Dos turnos quedan pisados en la agenda de una profesional.
- Un bloque de varios servicios queda partido entre dos agendas.

## Restricciones

- `Servicio.profesional_id` es **la dueña del servicio**; `Turno.profesional_id`
  es **quien atendió**. La redundancia es a propósito y el schema lo dice:
  *"si un servicio cambia de dueña el histórico tiene que quedarse con quien lo
  hizo"*. Reasignar es exactamente el caso para el que existe.
- `verificarYActualizar` (`lib/availability.js:780`) valida, contra la
  profesional que se le pasa: los holds de pago, los choques con sus propios
  turnos, la camilla compartida con la otra agenda y que la clienta no quede con
  dos turnos solapados. **No valida el horario de trabajo ni los bloqueos**:
  `HorarioConfig` y `BloqueCerrado` solo los mira `obtenerHorariosDisponibles`,
  que es el camino del listado.
- `GET /api/turnos/disponibilidad/:fecha/:servicio_id` **deriva** la profesional
  del servicio, así que no sirve para preguntar por los huecos de Noemí para un
  servicio de Daniela. Y es público.
- `resolverProfesionalYPlata` también deriva la profesional de los servicios:
  hace falta un camino que acepte una profesional explícita.
- La plata del turno (`precio_base`, `comision_pct`, `comision_monto`) se
  congela al reservar. La liquidación es una consulta **en vivo** sobre esos
  campos: no hay mes cerrado, así que tocar un turno viejo cambia una
  liquidación ya mandada.
- `resolverComision` (`lib/comisiones.js:21`) le da prioridad al `comision_pct`
  del **servicio** sobre el default de la profesional.
- El cobro online está apagado (`cobro_activo = false`): hoy no existe un turno
  con `pago_realizado`.
- El PATCH del panel y el público son rutas distintas con reglas distintas: el
  del panel no pasa por `puedeModificarse` y el público sí.

## Decisiones tuyas

1. **Choque al reasignar: bloquear**, con un mensaje que nombre a la profesional
   para la que el horario está ocupado.
2. **Extras al cambiar de servicio: se conservan los que el servicio nuevo
   ofrece**, y los demás se descartan a la vista.
3. **La comisión se recalcula con el porcentaje de la profesional nueva.** El %
   propio del servicio se ignora cuando el turno queda en manos de alguien que
   no es su dueña: ese % expresa el acuerdo con la dueña, no con quien lo toma.
4. **Un turno que es parte de una reserva múltiple no se puede reasignar.** Todo
   lo demás de ese turno se sigue editando como hoy; lo único que se bloquea es
   partir el bloque entre dos agendas.
5. **La clienta siempre elige día y hora**, también cuando cambia el servicio.
   No hay un camino de "solo cambiar el servicio".
6. **Reasignar un turno de un mes anterior se permite, avisando.** El panel le
   dice que eso cambia una liquidación ya calculada y ella decide.

## Enfoques

**A. Un campo más en cada PATCH, y el recálculo de la plata en un helper
compartido (elegido).** `profesional_id` opcional en el PATCH del panel,
`nuevo_servicio_id` opcional en el público, y un helper en `lib/reservas.js` que
las dos rutas usan para recongelar precio y comisión.
*A favor:* el recálculo queda en un solo lugar y cada ruta conserva sus reglas.
*En contra:* dos rutas siguen teniendo lógica de edición parecida pero no igual.

**B. Unificar las dos ediciones en un `editarTurno(turnoId, cambios, { comoAdmin })`.**
*En contra:* las reglas difieren en más de un punto (la antelación, qué campos
se pueden tocar, a quién se avisa, qué pasa con el pago). Unificarlas es
refactorizar los dos caminos críticos del sistema para habilitar dos campos. Es
el cambio que haría si las reglas convergieran; hoy divergen a propósito.

**C. Que la clienta cancele y vuelva a reservar.** Es lo que hace hoy y es lo
que pediste cambiar; además pierde el turno mientras rehace la reserva.

Voy con **A**: el riesgo real no es la forma de las rutas, es que la plata
congelada quede mal, y A pone ese cálculo en un solo lugar con tests propios.

## El cómo

Lo que sigue son mis llamadas, salvo lo que está arriba como decisión tuya.

### Etapa A — reasignar desde el panel

- `PATCH /api/admin/turnos/:id` acepta `profesional_id` **opcional**. Sin él, la
  profesional se sigue derivando del servicio.
- Si el turno tiene `grupo_reserva` y el `profesional_id` que llega es distinto
  del actual, se **rechaza** (decisión 4). El resto de la edición sigue abierta.
- Una profesional **inactiva** se rechaza, con el mismo criterio que ya usa
  `resolverProfesionalYPlata`. Para no copiarlo, se extrae de ahí un
  `cargarProfesionalActiva(id)`.
- **Endpoint nuevo:** `GET /api/admin/disponibilidad/:fecha/:servicio_id/:profesional_id`,
  **bajo `authAdmin`**, que acepta `excluir_turno_id`. Hace falta porque el
  endpoint público deriva la profesional del servicio. Va en el panel y no como
  un parámetro más del público: abrirle `profesional_id` al endpoint sin auth
  dejaría a cualquiera cruzar agendas. El `excluir_turno_id` además permite
  borrar el parche del frontend que hoy reinserta a mano la hora original.
- El mensaje de choque: `verificarYActualizar` ya tira `HORARIO_NO_DISPONIBLE`;
  la ruta lo traduce nombrando a la profesional.
- **La plata se recalcula solo si cambia el servicio o la profesional.** Hoy se
  recalcula en *toda* edición, así que corregir un apellido re-congela el precio
  a los valores de hoy (ver "Bugs preexistentes").
- El % de comisión, cuando la profesional del turno no es la dueña del servicio,
  es el `comision_pct_default` de la profesional nueva (decisión 3).
- `avisarModificacion` sale del `if (cambioServicio || cambioFecha ||
  cambioHora)` y pasa a tener su propia condición, que incluye
  `cambioProfesional`. El mensaje **a la clienta** se queda dentro del `if`
  actual, así que un cambio de sola profesional no le llega.
- **Textos nuevos de reasignación**, en vez de reusar cancelación + alta: hoy
  `avisarModificacion` le manda a la que pierde el turno un "⚠️ Se canceló un
  turno tuyo… El horario quedó libre", que es falso —el turno existe, lo toma
  otra— y a la que lo gana un "te agendaron un turno", que se lee como una
  reserva nueva. Van dos textos propios: "este turno pasa a <X>" y "te pasaron
  este turno". Siguen saliendo con `SOLO_LA_PROFESIONAL`, así que Daniela no se
  avisa a sí misma.
- Frontend del panel: un select **Profesional** arriba del de Servicio,
  arrancando en la del turno. Cambiarlo vuelve a pedir los horarios al endpoint
  nuevo, porque la agenda contra la que se mide es otra. **Se borra el filtro de
  servicios por profesional** que hoy está muerto (ver "Bugs preexistentes"): el
  select tiene que seguir listando los servicios de las dos. Al lado del
  servicio, un "(servicio de Daniela)" cuando la dueña no coincide con la
  profesional del turno. Si el turno es de un mes anterior, un cartel con lo de
  la liquidación (decisión 6).

### Etapa B — la clienta cambia el servicio

- `PATCH /api/turnos/:id` acepta `nuevo_servicio_id` **opcional**, siempre junto
  con fecha y hora (decisión 5).
- Si el turno tiene `pago_realizado`, el cambio de servicio se **rechaza** con un
  mensaje que la invita a escribir: la seña y el saldo no se pueden recalcular
  sin decidir quién pone la diferencia, y eso es una conversación, no un
  formulario. Hoy no puede pasar porque el cobro está apagado; es un freno de
  tres líneas que evita un bug de plata el día que lo prendas.
- El servicio nuevo tiene que estar **activo** y ser de una profesional
  **activa**, con el mismo criterio que ya aplica `GET /disponibilidad`.
- **No hay tope de precio:** puede pasar a un servicio más caro o más barato.
  Mi llamada, porque hoy ya puede lograr lo mismo cancelando y reservando de
  nuevo, y de ese modo el estudio además pierde el horario en el medio.
- Los extras se filtran por `Extra.servicios_ids`: sobreviven los que el
  servicio nuevo ofrece. Con los que queden se recalculan la duración (y
  `hora_fin`), el precio base y la comisión.
- **Endpoint de previsualización:** `GET /api/turnos/:id/cambio-preview` (con
  `token` y `nuevo_servicio_id`), que devuelve los extras que se conservan y los
  que se descartan, la duración, el `hora_fin`, el precio y la profesional. La
  cuenta tiene que salir del backend y no del frontend: la regla de que los
  extras de precio variable no suman vive en `lib/reservas.js`, y duplicarla
  haría que el número que ve la clienta se separe del que se congela.
- La ventana de 24 horas se sigue chequeando con `puedeModificarse`, sin
  cambios.
- Frontend de la clienta (`/mistura`): el botón pasa de "Cambiar fecha y hora" a
  "Cambiar turno". Adentro, un select de servicio —los activos, con su precio y
  agrupados por profesional, como ya hace la página de reservar—, después la
  fecha y el horario como hoy, y la nota deja de decir *"El servicio y los
  extras quedan igual"* para mostrar qué se conserva y qué se descarta.

### Orden

**A primero**, que es lo que Daniela necesita ya. **B después**, reusando el
helper de plata que deja A.

## Bugs preexistentes que este cambio arregla de paso

Los tres están en los caminos que estas etapas tocan, y los tres atentan contra
los anti-objetivos de arriba. Verificados contra el código.

1. **Los dos PATCH calculan `hora_fin` ignorando los minutos de los extras**
   (`routes/admin.js:372`, `routes/turnos.js:633`), mientras los cinco caminos
   de alta sí los suman. Mover hoy un turno con extras le **acorta** el horario
   y libera tiempo que está ocupado.
2. **El panel no filtra los extras contra el servicio nuevo**
   (`routes/admin.js:378`): cambiar el servicio conserva extras que el servicio
   nuevo no ofrece y los suma al `precio_base`. La decisión 2 se aplica a los
   dos lados, no solo al de la clienta.
3. **La plata se re-congela en toda edición del panel**: corregir un apellido
   recalcula `precio_base` y la comisión a los precios de hoy, y eso cambia una
   liquidación vieja sin que nadie lo pida.

## Lo que queda afuera

- **La validación del horario de trabajo en el motor.** `verificarYActualizar`
  no mira `HorarioConfig` ni `BloqueCerrado`, así que un request armado a mano
  puede dejar un turno fuera de agenda. Es un hueco **preexistente de todos los
  caminos de edición**, y en la práctica la UI lo tapa: los horarios que se
  ofrecen salen del listado, que sí los mira, y el formulario obliga a elegir
  uno de esa lista. Cerrarlo de verdad es mover la resolución de rangos adentro
  de la transacción: es un cambio al motor y merece su propia tanda.
- La reserva múltiple sigue sin poder editarse de a un turno **desde el lado de
  la clienta**, como hoy.

## Lo que queda al constructor

- Los textos exactos, en el tono de los actuales.
- Si el cartel del mes anterior es un aviso al abrir la edición o al guardar.
- Cómo se ve "(servicio de Daniela)" en el renglón del select.
