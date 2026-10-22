# Segunda profesional — lo que falta hacer

Todo el código está escrito y commiteado en la rama `feat/segunda-profesional`
de los **dos** repos. Lo que queda necesita la base de producción o el
navegador, así que va de tu lado.

**El orden importa.** Los pasos 1 a 4 se pueden hacer con el código viejo
corriendo; el 7 va obligatoriamente después del deploy.

---

## 1. Backup del Postgres

Desde Railway, servicio **Postgres**. Es el único resguardo antes de tocar
tablas con datos.

## 2. Crear la tabla `profesionales`

En la Console de `turnos-backend`, con el código de la rama ya pusheado:

```bash
npx prisma db push
```

Esperás: crea `profesionales`. Ninguna tabla existente se modifica.

> Para que este paso solo cree la tabla, el schema tiene que estar en el commit
> `c14cc30`. Si ya desplegaste la rama completa, este paso y el 4 se hacen
> juntos en un solo `db push` — funciona igual, pero perdés la posibilidad de
> verificar el backfill por separado.

## 3. Cargar Daniela y Elsa

```bash
node prisma/seed-profesionales.js
```

Esperás: `id 1 = Daniela`. **Verificá que Daniela quedó en el id 1**: el paso
siguiente le asigna a la profesional 1 todo lo que ya existe. El script falla
solo si el id 1 no existe.

Es idempotente: correrlo de nuevo no pisa nada que hayas cargado a mano.

## 4. Agregar las columnas y hacer el backfill

```bash
npx prisma db push
```

Esperás: sin pérdida de datos. Después, en la pestaña **Data** del Postgres,
comprobá que **los 18 servicios, todos los horarios y todos los turnos**
quedaron con `profesional_id = 1`. Eso lo hace el `@default(1)` temporal, sin
ningún UPDATE a mano.

## 5. Anotar la facturación actual

Antes de desplegar, entrá a **Métricas** en el panel y anotá la facturación de
los **últimos tres meses cerrados**. Después del deploy tienen que dar
exactamente lo mismo. Si alguno cambió, la fórmula `ingresoEstudio` está mal y
hay que avisar.

## 6. Deploy

Backend a Railway y frontend a Vercel, los dos desde `feat/segunda-profesional`.

Entre el paso 4 y este, la web sigue funcionando con el código viejo: no manda
`profesional_id` y el default se lo pone. No hay ventana de caída.

## 7. Quitar el `@default(1)`

**Solo después de confirmar que el código nuevo está andando.** En
`prisma/schema.prisma`, borrar `@default(1)` de `Servicio.profesional_id`,
`HorarioConfig.profesional_id` y `Turno.profesional_id`. Después:

```bash
npx prisma db push
```

No es cosmético: con el default puesto, el día que un camino se olvide de
setear `profesional_id` el turno **se le asigna a Daniela en silencio** y
ensucia la liquidación. Sin default, ese bug explota con un error.

Esta es la **Task 14** del plan y es la única que dejé sin hacer a propósito:
hacerla antes del deploy rompe el backfill del paso 4.

## 8. Cargar los datos de Elsa

Desde el panel, pestaña **Equipo** y **Servicios**:

1. Elsa → su **comisión por defecto** (el %) y su **teléfono**.
2. Sus 7 servicios con profesional = Elsa: PRP Facial, PRP Capilar, Vitamina C,
   Exosoma, Hydralips, Ácido Hialurónico, PDRN. Nombre, duración, precio, y la
   comisión solo si difiere del % general.
3. Sus **horarios** (pestaña Horarios, pastilla *Elsa*).
4. **PRP id 16 → desactivar.** Queda para el histórico y deja de aparecer en
   la web.

---

## Checklist de verificación

Correlo entero antes de cargar los datos reales. Los puntos 1, 2 y 6 son los
que más importan.

| # | Prueba | Esperado |
|---|---|---|
| 1 | Turno de Elsa 15:00 → disponibilidad de un servicio de Daniela ese día | 15:00 **aparece libre** |
| 2 | Turno de Elsa 15:00 → otro servicio de Elsa ese día | 15:00 **no aparece** |
| 3 | Reservar por API un segundo turno de Elsa a las 15:00 | `HORARIO_NO_DISPONIBLE` |
| 4 | Día sin horarios cargados para Elsa | sus servicios no ofrecen ningún slot |
| 5 | Bloqueo "Todo el estudio" | cierra las dos agendas |
| 6 | Bloqueo "Solo Elsa" | Daniela sigue disponible |
| 7 | Pro lifting (id 8) + Pies simples (id 3) en una reserva | se agendan en simultáneo, como antes |
| 8 | En la web, elegir un servicio de Elsa | los de Daniela quedan deshabilitados con el motivo |
| 9 | Reserva mixta forzada por API | 400 con mensaje claro |
| 10 | Métricas: los 3 meses del paso 5 | **los mismos números** |
| 11 | Liquidación con un turno marcado "no se liquida" | ese turno no aparece ni suma |
| 12 | Subir el precio de un servicio de Elsa y repedir la liquidación del mes anterior | los montos **no cambian** |
| 13 | Clienta en waitlist para un servicio de Daniela; cancelar un turno de Elsa de esa fecha y franja | **no** le llega el aviso |
| 14 | Hold de pago de Daniela activo → disponibilidad de Elsa a esa hora | **aparece libre** (pide prender `cobro_activo` un rato) |

El 12 es la razón de ser de los campos congelados. El 13 es un arreglo que no
estaba en el spec: la waitlist avisaba cruzado entre profesionales.

---

## Lo que quedó fuera, para agendar aparte

- **Los dos bugs de intercalación.** `max_simultaneos: 1` hace que
  `(1 || 2) - 1 = 0` y la condición `yaIntercalados < 0` nunca se cumpla, así
  que la intercalación entre clientas distintas está desactivada para PRP. Y el
  `count` de intercalados en `verificarYReservar` no tiene tope superior, así
  que sobre-cuenta cualquier turno posterior del día.
- **Datos de prueba en producción:** el extra "Ejemplo" a $20.000, "Diseño y
  perfilado de cejas" a $20, "Nails art total" duplicado a $4, y "Remoción de
  extensiones" a $150.000 por 30 min.
- **Código muerto:** `services/scheduler.js` (nadie lo requiere), la dependencia
  `twilio` sin usar, y `turnos-frontend/app/reservar/reservar-page.js`.
- **Reservas mixtas** (un servicio de cada profesional en una sola operación).
  El diseño deja el camino abierto; está documentado en §3 del spec.
- **Cobro online para Elsa.** Mientras su plata sea suya, sus servicios quedan
  fuera de Mercado Pago. Si algún día cobra por el MP del estudio, hay que
  revisar §6.3 del spec.
