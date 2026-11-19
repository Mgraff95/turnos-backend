# La clienta cambia el servicio — lo que falta hacer

Todo el código está escrito y commiteado en la rama `feat/clienta-cambia-servicio`
de los **dos** repos. Lo que queda necesita el deploy, así que va de tu lado.

**No hay migración.** No se toca `schema.prisma`.

---

## 1. El orden del deploy, otra vez al revés ⚠️

**Backend primero, frontend después.** `/mistura` ahora le pega a dos cosas que
todavía no existen en producción: el endpoint de previsualización y el parámetro
`excluir_turno_id` del listado de horarios.

1. Mergear y pushear el **backend**, y desplegarlo en Railway a mano.
2. Recién entonces mergear el **frontend** a master (Vercel lo publica solo).

Si se hace al revés, a la clienta que entre a cambiar su turno no le va a
aparecer la cuenta de lo que le queda, y la lista de horarios le va a esconder
su propia hora. No se rompe nada ni se pierde nada: se arregla solo en cuanto
salga el backend.

---

## Checklist de prueba

Todo desde `/mistura`, con un turno real a más de 24 horas:

| # | Prueba | Esperado |
|---|---|---|
| 1 | Cambiar a un servicio **más caro de la misma profesional** | antes de confirmar muestra la duración y el precio nuevos; después del cambio, el turno queda con el servicio y el precio nuevos |
| 2 | Cambiar a un servicio **de la otra profesional** | avisa "te va a atender X"; el turno pasa a la agenda de ella; **las dos profesionales** reciben el aviso de reasignación y la clienta su confirmación |
| 3 | **El caso que más importa:** cambiar el servicio dejando el **mismo día y la misma hora** | su hora actual tiene que aparecer en la lista. Si no aparece, el `excluir_turno_id` no está llegando |
| 4 | Un turno con un extra que el servicio nuevo **no ofrece** | antes de confirmar dice "con este servicio no van: <extra>"; después, el precio no incluye ese extra y el turno tampoco lo tiene |
| 5 | Un turno a **menos de 24 horas** | no se puede cambiar, con el mensaje de siempre |
| 6 | Cambiar a un servicio **más largo** que no entra en el hueco | esa hora no aparece en la lista; si la fuerza, "ese horario ya no está disponible" |
| 7 | Dejar el **mismo servicio** y solo mover fecha y hora | se comporta igual que antes de este cambio, incluido el precio congelado |

El 7 es el que protege lo de antes: el camino viejo tiene que seguir intacto.

---

## Lo que queda afuera a propósito

- **No hay tope de precio:** puede pasar a un servicio más caro o más barato. Ya
  podía lograr lo mismo cancelando y reservando de nuevo, y de ese modo el
  estudio además perdía el horario en el medio.
- **Un turno con pago hecho no cambia de servicio** desde la web: la seña y el
  saldo no se recalculan sin decidir quién pone la diferencia. Hoy no puede
  pasar porque el cobro online está apagado.
- **Una reserva de varios servicios** sigue sin poder editarse desde `/mistura`:
  para cambiarla hay que cancelar y reservar.
- **La validación del horario de trabajo en el motor**, igual que en la etapa A:
  la pantalla lo tapa porque las horas que ofrece salen del listado, que sí mira
  los rangos.
