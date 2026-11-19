# Reasignar profesional — lo que falta hacer

Todo el código está escrito y commiteado en la rama `feat/reasignar-profesional`
de los **dos** repos. Lo que queda necesita el deploy y el panel, así que va de
tu lado.

**No hay migración.** No se toca `schema.prisma`: ninguna tabla, ninguna
columna, ningún `db push`.

---

## 1. El orden del deploy importa ⚠️

**Backend primero, frontend después.** Al revés de lo que uno haría.

El panel nuevo le pega a un endpoint que hoy no existe
(`GET /api/admin/disponibilidad/:fecha/:servicio_id/:profesional_id`). Y el
frontend **se despliega solo** cuando se mergea a master, así que:

1. Mergear y pushear el **backend**, y desplegarlo en Railway a mano.
2. Recién entonces mergear el **frontend** a master (Vercel lo publica solo).

Si se hace al revés, el formulario de edición del panel se queda **sin
horarios** —la lista va a venir vacía siempre— hasta que el backend salga. No
se pierde ningún dato y se arregla solo cuando desplegás el backend, pero en el
medio no podés editar turnos.

## 2. Nada que cargar

A diferencia de las dos tandas anteriores, acá no hay datos que dar de alta: la
reasignación usa las profesionales que ya están en la pestaña Equipo.

---

## Checklist de prueba

| # | Prueba | Esperado |
|---|---|---|
| 1 | Editar un turno de Noemí y cambiar **solo** la profesional a Daniela | se guarda; **la clienta no recibe nada**; a Noemí le llega "este turno pasa a Daniela" y a Daniela no le llega nada (es ella la que lo hizo) |
| 2 | Lo mismo, pero reasignando entre dos profesionales que no son Daniela | las dos reciben: "pasa a X" y "te pasaron un turno de Y" |
| 3 | Reasignar a una hora en que la otra profesional ya tiene un turno | **bloquea**, nombrándola: "Ese horario ya está ocupado para Noemí." |
| 4 | Abrir la edición de un turno que es parte de una reserva de varios servicios | el select de Profesional aparece **deshabilitado**, con la línea que lo explica; el resto se sigue editando |
| 5 | Elegir una profesional y mirar el select de **Servicio** | tiene que listar los servicios de **las dos**, no solo los de ella |
| 6 | Elegir un servicio que no es de la profesional del turno | debajo del select dice "servicio de Daniela" (o quien sea la dueña) |
| 7 | Cambiar la profesional y mirar la lista de **Hora** | cambia: son los huecos de la agenda de ella. La hora original sigue ofrecida arriba |
| 8 | **El que más importa para la plata:** corregirle el apellido a una clienta de un turno viejo, sin tocar nada más. Antes y después, mirar la liquidación de ese mes en la pestaña Equipo | **el mismo número**. Antes de este cambio, editar cualquier cosa le re-congelaba el precio al turno |
| 9 | Editar un turno que tenga un extra con minutos adicionales | el `hora_fin` del turno incluye esos minutos (se ve en la agenda: el bloque ocupa lo que realmente dura) |
| 10 | Abrir un turno de un mes anterior | aparece el cartel de que reasignarlo cambia una liquidación ya calculada |

El 8 y el 9 son arreglos de bugs que ya existían en este camino, no funciones
nuevas: valen la pena aunque no los hayas pedido.

---

## Un efecto del arreglo del `hora_fin`

Los turnos **ya existentes** que tengan extras con minutos adicionales están
guardados más cortos de lo que duran: ése era el bug. Cuando los edites, aunque
sea para corregir un apellido, el turno se va a estirar a su duración real.

Si en ese hueco que estaba libre de mentira ya entró otra clienta, la edición va
a fallar con "Ese horario ya está ocupado para X". No es un bug nuevo: es la
verdad asomando. Si pasa, el camino es mover uno de los dos turnos.

## Lo que queda afuera a propósito

- **La etapa B**, que es que la clienta pueda cambiar el servicio de su turno
  desde `/mistura`. Tiene su propio plan, todavía sin escribir.
- **La validación del horario de trabajo en el motor.** `verificarYActualizar`
  mira los turnos, la camilla y los pagos en curso, pero no los rangos horarios
  ni los bloqueos: un request armado a mano podría dejar un turno fuera de
  agenda. Es un hueco que ya existía en todos los caminos de edición, y en la
  práctica el panel lo tapa porque las horas que ofrece salen del listado, que
  sí los mira.
- **Forzar un choque.** Si la otra profesional está ocupada, no hay forma de
  pisarla desde el panel. Si en la práctica hace falta, se le agrega una salida.
