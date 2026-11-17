# Avisos por profesional — diseño

Fecha: 2026-11-16. Rama: `feat/avisos-por-profesional`. Solo backend.

## Intención

Daniela quiere seguir enterándose de **todo** lo que pasa en el estudio ahora
que no es la única que atiende, y quiere que cada profesional se entere de **lo
suyo** sin que ella tenga que reenviarlo a mano.

Hoy los cinco avisos internos ya le llegan todos a Daniela, pero ninguno dice
de quién es el turno: no puede distinguir lo suyo de lo de Noemí. Y hacia el
staff no sale nada: Noemí no sabe que le agendaron un turno hasta que Daniela se
lo dice.

## Objetivos

1. Los avisos de turno nombran a la profesional y le siguen llegando a Daniela,
   sea de quien sea el turno.
2. Cada profesional recibe los avisos de **sus** turnos: alta, modificación y
   cancelación, **incluidos los que carga Daniela desde el panel** (hoy el panel
   no avisa a nadie más que a la clienta, y es el camino por el que más turnos
   le van a entrar a Noemí).
3. El resumen diario de Daniela abre con el horario del estudio y lista los
   turnos agrupados por profesional.
4. Cada profesional recibe su propia agenda del día siguiente.

## No-objetivos

- El frontend y el panel no se tocan.
- Lo que recibe la clienta queda igual: confirmación, recordatorio de 2 a 26 h,
  cancelación y modificación no cambian ni una coma.
- El staff sigue **sin** acceso al backend ni al panel. Esto es solo WhatsApp
  saliente.
- La liquidación sigue copiándose a mano desde el panel.
- Los movimientos de waitlist no se le avisan a la profesional: son gestión del
  estudio.

## Anti-objetivos

Esto fracasa, aunque ande, si:

- Daniela recibe dos mensajes por el mismo hecho.
- Un aviso que falla (teléfono mal cargado, Wassenger caído) se lleva puesta la
  reserva.
- Una profesional empieza a ver datos de clientas que hoy no ve.

## Restricciones

- El canal es Wassenger, ya configurado. `enviarWhatsApp(telefono, mensaje)`
  arma `+549<telefono>`, así que los teléfonos van sin prefijo.
- Daniela es la profesional id 1 y su número está en la env `DANIELA_TELEFONO`.
  El de las demás está en `profesionales.telefono`, **que puede estar vacío**.
- Los avisos se disparan desde 12 lugares: `routes/turnos.js` (web y links),
  `routes/webhook.js` (respuestas por WhatsApp), `lib/pagos-proceso.js`
  (Mercado Pago) y `routes/admin.js` (panel, hoy sin avisos internos).
- Todos los avisos se mandan *fire and forget*, con `.catch()` que solo loguea.
  Se mantiene: un aviso nunca puede tirar abajo la operación.
- Los turnos que llegan a los avisos traen `servicio` pero **no** `profesional`.

## Decisiones tuyas

1. **Un solo mensaje por teléfono.** Si el destinatario del aviso "de todo el
   estudio" y el de "tu turno" son el mismo número, se manda una sola vez. Vale
   para los avisos y para la agenda diaria: Daniela recibe la del estudio, donde
   sus turnos ya figuran bajo su nombre.
2. **El horario del estudio sale de los turnos agendados**, no de los horarios
   cargados en el panel.
3. **El aviso a la profesional no lleva el teléfono de la clienta.**

## Enfoques

**A. Capa de avisos nueva (`lib/avisos.js`) — elegido.** Un módulo que decide
*quién recibe qué*: resuelve la profesional del turno con una consulta, arma la
lista de destinatarios, saca los repetidos y delega el texto a
`services/whatsapp.js`, que sigue siendo la capa de mensajes. Los call sites
cambian el import y el nombre de la función.
*A favor:* un solo lugar donde leer la regla de destinatarios, y se puede
testear sin tocar la base. *En contra:* hay que pasar por los 12 call sites.

**B. Todo dentro de `services/whatsapp.js`.** Las funciones actuales resuelven
la profesional y mandan a los dos; los call sites no se tocan.
*En contra:* los nombres quedarían mintiendo (`notificarNuevoTurnoADaniela`
manda a dos personas), y el módulo de mensajes —hoy texto puro más axios, sin
base— pasaría a depender de Prisma. Igual hay que tocar `admin.js`, que no tiene
ningún aviso, así que lo de "no toca call sites" tampoco se cumple.

**C. Pasar la profesional desde cada call site** (`include: { profesional: true }`
en las consultas) y que `whatsapp.js` siga tonto.
*En contra:* son 12 consultas distintas y si una queda sin el include el aviso
sale sin nombre o sin destinatario, en silencio. Lo mismo de trabajo que A, con
el riesgo repartido en vez de concentrado.

Voy con **A** porque la pregunta que este cambio introduce —*¿quién tiene que
recibir esto?*— pasa a tener un solo lugar donde se contesta y se testea.

## El cómo

Lo que sigue son mis llamadas, salvo lo que ya está arriba como decisión tuya.

**`lib/avisos.js` (nuevo).** Expone `avisarNuevoTurno`, `avisarNuevoTurnoGrupo`,
`avisarCancelacion`, `avisarCancelacionGrupo` y `avisarModificacion`. Cada una:

1. Resuelve la profesional del turno (`select` de nombre y teléfono).
2. Arma los destinatarios: el estudio (`DANIELA_TELEFONO`, con el nombre de la
   profesional en el texto) y la profesional del turno (sin teléfono de la
   clienta). Normaliza los números a dígitos y saca repetidos, así los turnos de
   Daniela salen una sola vez.
3. Si la profesional no tiene teléfono cargado, no se le manda nada y se loguea;
   el aviso al estudio sale igual.

**`services/whatsapp.js`.** Las funciones `notificar*ADaniela` pasan a llamarse
`avisoNuevoTurno`, `avisoCancelacion`, etc., y reciben un segundo parámetro
`{ telefono, profesional, conTelefonoClienta }`. El texto es el de hoy más una
línea `👩 <profesional>`, y el teléfono de la clienta se incluye solo si se pide.
Nada de esto consulta la base.

**El panel (`routes/admin.js`).** `POST /turnos`, `POST /turnos/multi`,
`PATCH /turnos/:id` y `DELETE /turnos/:id` pasan a avisarle **a la profesional
del turno**, no al estudio: el movimiento lo hizo Daniela, no tiene sentido que
se lo avise a sí misma. Si el turno es de Daniela, no sale ningún mensaje.
El check **"📲 Avisar por WhatsApp a la clienta"** no afecta este aviso: dice *a
la clienta*, y si Daniela lo destilda porque la clienta ya sabe, Noemí tiene que
enterarse igual.

Caso con filo: en `PATCH /turnos/:id` Daniela puede cambiar el servicio y con eso
la profesional del turno. Si cambia, se avisa a las dos: a la que lo pierde como
cancelación y a la que lo gana como turno nuevo.

**Resumen diario (`lib/scheduler.js`).** Una sola consulta de los turnos
confirmados de mañana, con la profesional incluida. Con eso se arman:

- *El del estudio, para Daniela.* Encabezado con la fecha y el horario del
  estudio, que es el **primer inicio y el último fin** de los turnos de mañana,
  como un tramo único: el pedido es "desde qué hora a qué hora está abierto", y
  los huecos del día se ven en el detalle. Después una sección por profesional
  (ordenadas por `orden`), con sus bloques. Solo aparecen las profesionales que
  tienen turnos. Si mañana no hay ningún turno, se manda el mensaje de hoy
  ("aprovechá para descansar").
- *El de cada profesional.* Sus bloques, su primer turno y su hora de salida —el
  mensaje de hoy, pero solo con lo suyo. **Si no tiene turnos no se le manda
  nada:** un mensaje diario diciendo "no tenés nada" es ruido. Daniela sí recibe
  el suyo siempre.

Todas salen del mismo cron de las 19:00 ARG que ya existe. El resumen del
estudio y el de Daniela-profesional son el mismo mensaje (decisión 1).

**Tests.** `node:test` en `test/`, como `test/cruces.test.js`: destinatarios y
deduplicación con la consulta espiada, y armado de los textos (horario del
estudio, agrupación por profesional, profesional sin teléfono). El armado del
texto queda en funciones puras para poder testearlo sin base ni red.

## Lo que queda al constructor

- Los textos exactos, dentro del tono de los actuales (emojis incluidos).
- Cómo espiar Prisma en los tests; el repo ya tiene un patrón en
  `test/cruces.test.js`.
- Si conviene un helper compartido para agrupar turnos por `grupo_reserva`: hoy
  esa lógica está en `lib/scheduler.js` y la va a necesitar también el resumen
  por profesional.
