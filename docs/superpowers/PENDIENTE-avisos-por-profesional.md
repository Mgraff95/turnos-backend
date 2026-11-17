# Avisos por profesional — lo que falta hacer

Todo el código está escrito y commiteado en la rama `feat/avisos-por-profesional`
del repo del **backend**. El frontend **no se toca**. Lo que queda necesita el
panel y el deploy, así que va de tu lado.

**No hay migración.** No se toca `schema.prisma`: ninguna tabla, ninguna
columna. Así que el orden no importa, no hay ventana de caída y no hay nada que
pueda quedar a medias en la base.

---

## 1. Cargar el teléfono de cada profesional

En el panel → **Equipo** → Editar, el campo **Teléfono** (igual que los de las
clientas: `1123456789`).

Espacios y guiones no molestan: se ignoran tanto para comparar como para
mandar. Lo que **sí** rompe es el `0` de area y el `15`: el sistema le agrega
`+549` adelante, así que `011 15 1234-5678` sale como un número inexistente y
el mensaje no llega. Va el código de área sin `0` y el número sin `15`.

**Es lo único que habilita todo lo nuevo para ella.** Sin teléfono cargado, la
profesional no recibe nada: ni los avisos de sus turnos ni su agenda de mañana.
Queda anotado en el log del servidor y el aviso a Daniela sale igual, así que
no se rompe nada — simplemente ella no se entera.

Verificá el de **Noemí**: puede estar vacío desde que se la cargó.

## 2. Verificar `DANIELA_TELEFONO` en Railway

Es de donde sale el aviso del estudio y la agenda completa. Ya estaba
configurada (la usaban los avisos de antes), pero conviene mirarla: si falta, la
agenda del estudio no sale y el log lo dice.

Que sea **el mismo número** que el teléfono de Daniela en la pestaña Equipo, o
la deduplicación no la reconoce y recibe cada cosa dos veces: una como estudio y
otra como profesional. Da igual cómo esté escrito (espacios y guiones se
ignoran), pero tienen que ser los mismos dígitos.

> **No le pongas `TZ` al servicio en Railway.** Railway corre en UTC y la fecha
> del resumen diario se arma con los getters locales del proceso: si alguien
> setea `TZ=America/Argentina/Buenos_Aires`, la "Agenda de mañana" va a decir el
> día anterior. Es de antes de este cambio y no lo empeora, pero es la clase de
> variable que se agrega sin pensar.

## 3. Deploy

Backend a Railway, a mano, como siempre.

---

## Checklist de prueba

Después del deploy y con el teléfono de Noemí cargado:

| # | Prueba | Esperado |
|---|---|---|
| 1 | Reservar desde la web un servicio de Noemí | **dos** mensajes: a Daniela con `👩 Noemí` y el teléfono de la clienta, y a Noemí sin el teléfono |
| 2 | Reservar desde la web un servicio de Daniela | **un** solo mensaje, el del estudio |
| 3 | Cargar un turno de Noemí desde el panel **destildando** "Avisar por WhatsApp a la clienta" | la clienta no recibe nada, **Noemí sí**, Daniela no |
| 4 | Cargar un turno de Daniela desde el panel | ningún aviso interno |
| 5 | Cancelar un turno de Noemí desde el link de la clienta | a Daniela y a Noemí |
| 6 | Editar un turno de Noemí desde el panel cambiándole el servicio a uno de Daniela | a Noemí le llega una cancelación y a Daniela un turno nuevo |
| 7 | Esperar las 19:00 | Daniela recibe la agenda del estudio con el horario arriba y una sección por profesional; Noemí recibe solo sus bloques |
| 8 | Un día en que Noemí no tiene turnos | Daniela recibe su agenda igual; Noemí no recibe nada |

El 3 es el que más importa: es el camino por el que más turnos le entran a
Noemí, y hasta ahora no avisaba a nadie más que a la clienta.

---

## Lo que quedó afuera a propósito

- **La waitlist.** Cuando se libera un lugar, el aviso sigue saliendo solo a la
  clienta en espera y a Daniela. Avisarle también a la profesional es gestión del
  estudio, no información que ella necesite.
- **La liquidación** se sigue copiando a mano desde el panel (pestaña Equipo). El
  teléfono que cargás en el paso 1 es el mismo que usa ese botón, pero no se
  manda nada automático.
- **El staff sigue sin acceso** al panel ni al backend. Esto es solo WhatsApp
  saliente: no hay login por profesional ni roles.
- **El horario del estudio sale de los turnos**, no de los horarios cargados en
  el panel: dice de qué hora a qué hora hay actividad mañana, en un solo tramo
  (los huecos se ven en el detalle). Si alguna vez querés que diga el horario de
  atención aunque no haya turnos, hay que cambiar `horarioDelEstudio` en
  `lib/agenda.js` para que lea `horarios_config`.
