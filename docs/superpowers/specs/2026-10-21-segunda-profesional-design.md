# Segunda profesional en el tomador de turnos

**Fecha:** 2026-10-21
**Estado:** diseño aprobado, pendiente de plan de implementación
**Repos afectados:** `turnos-backend`, `turnos-frontend`

---

## 1. Objetivo

Elsa empieza a trabajar en el estudio junto a Daniela, con sus propios
servicios, sus propios días y horarios, y su propia plata. Sus turnos tienen
que poder darse **en paralelo** a los de Daniela: que una esté ocupada no
bloquea a la otra.

Hoy el sistema asume un solo recurso. Toda la disponibilidad se calcula sobre
una única línea de tiempo, y el único mecanismo de solapamiento que existe
(`intercalable` / `servicios_compatibles`) sirve para que una misma persona
haga dos de sus propios servicios a la vez — no para dos personas distintas.

El objetivo es introducir el concepto de **profesional** como dimensión de
primera clase, de forma genérica: sumar una tercera persona más adelante tiene
que ser cargar una fila, no tocar código.

## 2. Decisiones tomadas

Todas acordadas con Mauricio en la sesión de brainstorming del 2026-10-21.

| Decisión | Resuelto |
|---|---|
| Servicios de Elsa | PRP Facial, PRP Capilar, Vitamina C, Exosoma, Hydralips, Ácido Hialurónico, PDRN |
| PRP actual (id 16) | Se da de baja (`activo = false`). Se conserva para el histórico. Elsa arranca con 7 servicios nuevos |
| Granularidad de horarios | **Por profesional.** Los 7 servicios de Elsa se ofrecen en la agenda de Elsa |
| Cálculo de comisión | **% por servicio, con default por profesional.** `null` en el servicio = heredar el de la profesional |
| Base de la comisión | **Total del turno: servicio + extras** |
| Flujo de plata | **Elsa cobra a la clienta y le debe la comisión a Daniela.** El reporte dice "a cobrarle a Elsa" |
| Reservas mixtas (Daniela + Elsa en una operación) | **No por ahora.** Una reserva es de una sola profesional |
| Accesos | Un solo login, el de Daniela. Sin usuario ni rol para Elsa |
| Prioridad entre agendas | Ninguna. El primero que reserva se queda el horario |
| Facturación histórica | **No se recompone.** Importa de acá para adelante |

## 3. Fuera de alcance

- **Reservas mixtas.** Una clienta que quiera un servicio de cada una hace dos
  reservas. No hay garantía de que consiga horarios contiguos ni coincidentes.
  El diseño deja el camino abierto (ver §5.4) pero no se implementa.
- **Cobro online para Elsa.** Ver §6.3.
- **Los dos bugs de intercalación** detectados en el relevamiento previo
  (`max_simultaneos` que anula la intercalación, y el `count` sin tope
  superior en `verificarYReservar`). Son trabajo aparte: afectan al mecanismo
  `intercalable`, que este spec no modifica.
- **Limpieza de datos de prueba en producción** (extras "Ejemplo", precios con
  ceros faltantes). Trabajo aparte.
- **Backfill o recálculo del histórico de facturación.**

## 4. Modelo de datos

### 4.1 Tabla nueva

```prisma
model Profesional {
  id         Int      @id @default(autoincrement())
  nombre     String
  activo     Boolean  @default(true)
  orden      Int      @default(0)
  telefono   String?  // para mandarle la liquidación por WhatsApp

  // % que se queda Daniela de los turnos de esta profesional.
  // null = es la dueña del estudio: no hay comisión que liquidar.
  comision_pct_default Decimal? @db.Decimal(5, 2)

  created_at DateTime @default(now())
  updated_at DateTime @updatedAt

  servicios Servicio[]
  horarios  HorarioConfig[]
  bloqueos  BloqueCerrado[]
  turnos    Turno[]

  @@map("profesionales")
}
```

Filas iniciales:

| id | nombre | comision_pct_default |
|---|---|---|
| 1 | Daniela | `null` |
| 2 | Elsa | a definir (ej. `30.00`) |

El `null` de Daniela no es un dato faltante: es la señal de que esa profesional
es el estudio. Es lo que permite que `ingresoEstudio()` (§8.1) y el listado del
reporte de liquidación funcionen sin marcar nada a mano.

### 4.2 Columnas nuevas en modelos existentes

| Modelo | Columna | Nulabilidad | Semántica |
|---|---|---|---|
| `Servicio` | `profesional_id Int` | obligatoria | De quién es el servicio |
| `Servicio` | `comision_pct Decimal?` | nullable | `null` = heredar de la profesional |
| `HorarioConfig` | `profesional_id Int` | obligatoria | De quién es el rango horario |
| `BloqueCerrado` | `profesional_id Int?` | nullable | **`null` = cierra el estudio entero** (comportamiento actual) |
| `ReservaPendiente` | `profesional_id Int?` | nullable | `null` = el hold bloquea a todas (conservador). **El checkout debe setearlo** — ver §5.5 |
| `Turno` | `profesional_id Int` | obligatoria | Quién atendió. Denormalizado a propósito (§4.3) |
| `Turno` | `precio_base Decimal?` | nullable | Foto del precio al reservar |
| `Turno` | `comision_pct Decimal?` | nullable | Foto del % aplicado |
| `Turno` | `comision_monto Decimal?` | nullable | Foto de la comisión calculada |
| `Turno` | `liquidable Boolean @default(true)` | — | `false` = no entra en la liquidación (§8.3) |

Los `Decimal` de plata van `@db.Decimal(10, 2)` y los de porcentaje
`@db.Decimal(5, 2)`, siguiendo lo que ya usa el schema.

`Waitlist` no necesita columna: `servicio_id` ya determina la profesional.

### 4.3 Por qué `profesional_id` también en `Turno`

Es redundante — se puede deducir vía `servicio_id` hacia
`Servicio.profesional_id`. Se denormaliza por dos razones:

1. El reporte de liquidación y la agenda filtran por profesional
   constantemente. Sin la columna, cada consulta de disponibilidad necesitaría
   un join contra `servicios`.
2. Si algún día un servicio cambia de dueña, el histórico tiene que quedarse
   con quien **efectivamente** lo hizo, no con quien lo ofrece hoy.

### 4.4 Por qué los tres campos congelados

Hoy el panel calcula el precio de un turno en vivo desde
`servicio.precio_pesos` más los extras
(`turnos-frontend/app/admin/page.js:349`). Eso implica que subir un precio
**cambia retroactivamente el valor de los turnos pasados**.

Para la agenda es una molestia. Para una liquidación que ya se le compartió a
Elsa es inaceptable: se le pasa un número y al mes siguiente el reporte dice
otro.

`precio_base`, `comision_pct` y `comision_monto` se escriben al crear el turno
y no se vuelven a tocar. El reporte lee de ahí, nunca del precio actual del
servicio. Son nullable para no tocar las filas existentes; los turnos viejos
caen al cálculo en vivo de siempre, y como Elsa arranca de cero, todos sus
turnos tienen la foto completa desde el primer día.

## 5. Disponibilidad

Todo el trabajo está en `lib/availability.js`. Es el único archivo con lógica
de conflictos: no hay detección de solapamiento desparramada en las rutas.

### 5.1 El paralelismo es un filtro, no lógica nueva

No se escribe ninguna regla de "¿estos dos turnos pueden convivir?". Las
consultas de conflicto pasan de preguntar *"¿hay un turno confirmado que se
solape?"* a *"¿hay un turno **de esta profesional** que se solape?"*:

```js
const conflicto = await tx.turno.findFirst({
  where: {
    fecha: datos.fecha,
    estado: 'confirmado',
    profesional_id: datos.profesional_id,   // <-- el cambio
    OR: [ /* condición de solapamiento, sin tocar */ ]
  }
});
```

Un turno de Elsa deja de existir para el cálculo de Daniela y al revés. Dos
líneas de tiempo independientes sobre el mismo código.

**Corolario:** los turnos de Elsa tampoco se solapan entre sí, porque para ella
la consulta sigue siendo la de siempre. Esa restricción no se programa: viene
incluida.

### 5.2 Filtros a agregar

| Consulta | Ubicación | Filtro |
|---|---|---|
| `bloqueCerrado.findMany` | `availability.js:71`, `:192` | `OR: [{ profesional_id: null }, { profesional_id: profId }]` |
| `horarioConfig.findMany` | `availability.js:82`, `:203` | `profesional_id: profId` |
| `turno.findMany` | `availability.js:90`, `:210` | `profesional_id: profId` |
| `turno.findFirst` (conflicto) | `availability.js:357`, `:433`, `:473` | `profesional_id` del turno a crear |
| `reservaPendiente` (holds) | `availability.js:17`, `:34`, `:59` | `OR: [{ profesional_id: null }, { profesional_id: profId }]` |

El `null` de bloqueos y holds es lo que conserva el comportamiento actual: un
feriado sigue cerrando el estudio para todas.

**Elsa no trabaja los miércoles** no necesita código: si no tiene filas de
`horarioConfig` para ese día, `rangos.length === 0` y la función devuelve lista
vacía.

### 5.3 Firmas

- `verificarYReservar`, `verificarYReservarBloque`, `verificarYActualizar`:
  **sin cambios de firma.** Ya reciben el objeto del turno; `profesional_id`
  viaja adentro como un campo más.
- `obtenerHorariosDisponibles`, `obtenerHorariosDisponiblesBloque`: suman un
  parámetro `profesionalId`. Los endpoints que las llaman
  (`routes/turnos.js:423` y `:452`) ya cargan el `servicio` de la base, así que
  tienen `servicio.profesional_id` disponible sin consultas extra.
- **La API pública no cambia.** Ningún endpoint modifica su contrato.

`resolverBloqueConIntercalados` queda **igual**. La intercalación sigue
significando "una profesional haciéndose cargo de dos de sus propios servicios
a la vez" y opera dentro de una agenda; `profesional_id` opera entre agendas.
Los dos mecanismos conviven sin pisarse.

### 5.4 El guard de reserva única

`lib/reservas.js` tiene una propiedad clave: `construirTurnosDeReserva` es el
**único** punto donde se arman turnos. Lo usan la web (`/api/turnos`), el panel
(`/api/admin/turnos`) y el flujo de pago (`/api/pagos/checkout`), justamente
para que lo cobrado y lo reservado no puedan divergir.

Ahí se valida que todos los servicios de una reserva sean de la misma
profesional, con un error nuevo:

```
SERVICIOS_DE_DISTINTAS_PROFESIONALES  ->  400
"No se pueden combinar servicios de distintas profesionales en una misma reserva"
```

Un solo guard cubre los tres flujos. El día que se quieran habilitar reservas
mixtas, está claro cuál es la línea a cambiar.

### 5.5 Los holds de pago tienen que declarar la profesional

`ReservaPendiente.profesional_id` es nullable por compatibilidad, y `null`
significa "este hold bloquea a todas". Eso es seguro pero **no es lo que
corresponde** para un hold real.

Si `/api/pagos/checkout` crea el hold sin `profesional_id`, un pago en curso de
una clienta de Daniela congela también el horario de Elsa. El paralelismo se
rompe justo en el flujo de pago.

**Requisito:** el checkout setea `profesional_id` en el hold, tomándolo del
resultado de `construirTurnosDeReserva` (que ya validó que es una sola
profesional). El `null` queda reservado para filas viejas y como
comportamiento defensivo, no como caso normal.

Esto aplica aunque §6.3 deje a Elsa fuera del cobro online: los holds de
Daniela existen igual y no deben tocar la agenda de Elsa.

## 6. Comisión

### 6.1 El helper

Archivo nuevo, `lib/comisiones.js`:

```js
// Resuelve la comisión de un turno. precioBase = servicio + extras.
// Devuelve { comision_pct, comision_monto }; ambos null si no se liquida.
function resolverComision(servicio, profesional, precioBase) {
  const pct = servicio.comision_pct ?? profesional.comision_pct_default;
  if (pct == null) return { comision_pct: null, comision_monto: null };
  return {
    comision_pct: pct,
    comision_monto: redondear(precioBase * (pct / 100))
  };
}
```

Se invoca desde `construirTurnosDeReserva` al armar cada turno, y escribe los
tres campos congelados. Un solo lugar que decide la plata, igual que hay un
solo lugar que decide el horario.

`redondear` es la que ya existe en `lib/pagos.js`: se reutiliza, no se
reescribe, para que la comisión redondee igual que los montos de cobro.

El `??` es deliberado: distingue "el servicio no tiene excepción" (`null`, hay
que heredar) de "el servicio tiene 0% de comisión" (`0`, válido y no se
hereda).

### 6.2 Dirección de la deuda

Elsa le cobra a la clienta. El estudio no ve esa plata. Por lo tanto:

- Los turnos de Elsa **no son facturación del estudio**.
- Lo único que es ingreso de Daniela es la **comisión**.
- El reporte dice **"a cobrarle a Elsa"**, no un neto a transferir.

### 6.3 Mercado Pago: decisión explícita

Hoy el cobro online está **apagado** en producción
(`config_pago.cobro_activo = false`), verificado contra la API el 2026-10-21.
No bloquea nada.

Pero si se activa, una seña de un turno de Elsa caería en la cuenta de Mercado
Pago de Daniela — contradiciendo que esa plata es de Elsa.

**Decisión:** mientras la plata de Elsa sea de Elsa, sus servicios quedan
**fuera del cobro online**. Cuando se active `cobro_activo`, los turnos de
profesionales con `comision_pct_default != null` no piden pago.

Se implementa en `lib/pagos.js:calcularMonto`, devolviendo
`{ requiere_pago: false, motivo: 'profesional_sin_cobro_online' }`.

## 7. Panel de admin

Todo lo administra Daniela con su acceso actual. No hay rol, usuario ni vista
para Elsa.

### 7.1 Pestaña nueva: Equipo

Dos bloques:

1. **Profesionales** — alta y edición: nombre, activa, orden, teléfono,
   comisión por defecto. Van a ser dos o tres filas; no necesita paginado ni
   búsqueda.
2. **Liquidación** — el reporte de §8.2.

Se evaluó ponerla dentro de Cobros y se descartó: esa pestaña ya tiene ~170
líneas, y Daniela va a buscar "la liquidación de Elsa" pensando en Elsa.

### 7.2 Cambios en pestañas existentes

**Servicios**
- Selector de profesional en alta y edición.
- Campo de comisión, visible solo si la profesional tiene
  `comision_pct_default != null` (no aparece para los servicios de Daniela).
- Lista agrupada por profesional.
- **Arreglo obligatorio:** `routes/servicios.js:22` destructura solo
  `nombre, duracion_minutos, precio_pesos, incluye_nota, nota` y descarta el
  resto del body. Hoy eso ya hace que `intercalable` y compañía se pierdan al
  crear. Con `profesional_id` en juego, dejarlo así haría que todo servicio
  nuevo de Elsa quede asignado a Daniela. Entra en este trabajo por necesidad.

**Horarios**
- Dos pastillas arriba (*Daniela* / *Elsa*) que filtran la pestaña entera.
- La grilla de días no cambia: solo cambia de quién son las filas que muestra y
  crea. Cada profesional se lleva su propio `espacio_entre_turnos_min`.

**Bloqueos**
- Selector de alcance al crear: *Todo el estudio* (`null`), *Solo Daniela*,
  *Solo Elsa*.
- Cada fila de la lista muestra a quién afecta. Un bloqueo sin alcance visible
  es una trampa.

**Turnos (agenda)**
- `layoutTurnosDia` (`app/admin/page.js:428`) **ya asigna carriles a turnos
  solapados** y los dibuja lado a lado — se construyó para los intercalados.
  Los turnos de Elsa aparecen en paralelo sin tocar el layout.
- Nombre de la profesional en la tarjeta del turno.
- Color por profesional en vez de solo por servicio. Hoy `colorServicioCal`
  tiñe por `servicio_id`; con dos agendas en paralelo lo que hay que distinguir
  de un vistazo es de quién es cada columna.
- Filtro para ver una agenda sola.
- En el alta manual: elegir profesional primero, y filtrar la lista de
  servicios por esa profesional. Si no, Daniela puede cargarle a Elsa un
  servicio ajeno.
- Toggle de `liquidable` en la tarjeta (§8.3).

### 7.3 Web pública de reservas

`turnos-frontend/app/reservar/page.js`. Hoy el STEP 1 lista todos los servicios
activos de `/api/servicios` y deja elegir varios. Con Elsa cargada, esa lista
pasa a tener 7 servicios suyos mezclados con los de Daniela.

El guard de §5.4 rechaza una reserva mixta con un 400, pero **la clienta no
tiene que poder llegar a ese error**: elegiría dos servicios, completaría sus
datos y recién al final vería "no se pueden combinar". Eso es una mala
experiencia y una pérdida de reserva.

Requisitos:

- **STEP 1:** los servicios se agrupan por profesional, con el nombre visible.
  La clienta tiene que entender que son dos personas distintas, no dos
  categorías.
- **STEP 1:** en cuanto elige un servicio, los de la otra profesional quedan
  deshabilitados, con un texto que explique por qué (del estilo "para combinar
  con un servicio de Elsa, hacé una segunda reserva"). El guard del backend
  pasa a ser la red de seguridad, no el mecanismo.
- **STEP 6 ("Aprovechá el rato"):** solo ofrece servicios compatibles **de la
  misma profesional**. Hoy el filtro es por `servicios_compatibles`; se le suma
  el de profesional.
- El endpoint `/api/servicios` devuelve `profesional_id`, y conviene que
  incluya el nombre de la profesional para que el frontend no tenga que pedir
  la lista aparte.

## 8. Métricas y liquidación

### 8.1 Métricas

Una sola función resuelve el cambio:

```js
// Lo que entra al estudio por este turno.
ingresoEstudio(turno) =
  turno.profesional.comision_pct_default == null
    ? precioTurno(turno)           // turnos de Daniela: todo, como hoy
    : (turno.comision_monto ?? 0)  // turnos de Elsa: solo la comisión
```

El `?? 0` cubre el caso degenerado de un turno de una profesional con comisión
pero sin `comision_monto` escrito (una fila vieja, o un turno creado por un
camino que se olvidó del helper). Preferir 0 antes que `NaN`: un número de más
en la facturación es peor que un número de menos, y un `NaN` rompe el gráfico
entero de Métricas.

**El histórico no se mueve.** Los turnos existentes quedan con
`profesional_id = 1` (Daniela), y para Daniela la fórmula devuelve el precio
completo: exactamente lo que devuelve hoy. No hay recálculo ni backfill. La
exclusión ya existente de los turnos de prueba previos a julio 2026 sigue
funcionando igual.

Se suma una línea aparte, **"Facturado por Elsa"**: el volumen que pasó por el
estudio pero no es plata de Daniela. Dos números que no se mezclan.

### 8.2 Reporte de liquidación

```
GET /api/admin/liquidacion?profesional_id=2&desde=2026-10-01&hasta=2026-10-31
```

Devuelve el detalle turno por turno (fecha, clienta, servicio, precio cobrado,
% aplicado, comisión) más los totales del período.

Reglas:
- Solo turnos con `estado = 'confirmado'` **y** `liquidable = true`.
- Lee de los campos congelados del turno. Nunca del precio actual del servicio.
- Solo lista profesionales con `comision_pct_default != null`.
- El número destacado es **"A cobrarle a Elsa: $X"**.

Para compartirlo: un botón que arma el texto del resumen y lo deja listo, para
que Daniela lo mande con un click explícito reusando `enviarMensaje` de
`services/whatsapp.js` (Wassenger, ya en producción). Requiere
`Profesional.telefono`. No se manda nada automáticamente.

### 8.3 La clienta que no vino

Los turnos tienen solo dos estados: `confirmado` y `cancelado`. "Confirmar
asistencia" (`routes/turnos.js:267`) no cambia el estado — manda un WhatsApp y
loguea. **No existe la diferencia entre "vino" y "no vino".**

Consecuencia: si una clienta no se presenta, el turno queda `confirmado` y le
entra a Elsa en la liquidación un servicio que nunca hizo.

Se descartó agregar un estado `no_asistio`: hay 28 lugares que filtran por
`estado: 'confirmado'` y un tercer estado rompería disponibilidad y
recordatorios.

**Solución:** `Turno.liquidable Boolean @default(true)`. Daniela lo apaga desde
la tarjeta del turno. El reporte filtra por `liquidable: true` y **ningún
filtro de `estado` existente se entera**. El turno sigue confirmado para todo
lo demás: ocupó el horario, existió, cuenta en el histórico de la clienta —
simplemente no se liquida.

## 9. Migración

No hay carpeta `prisma/migrations`: el proyecto usa `npx prisma db push` desde
la Console de Railway. `db push` no puede agregar una columna obligatoria a una
tabla con filas, y `servicios` (18), `horarios_config` y `turnos` tienen datos.

**Antes de empezar: backup del Postgres desde Railway.** El paso 3 es el único
que toca tablas con datos.

| Paso | Acción |
|---|---|
| 1 | Agregar al schema **solo** `model Profesional`. `db push`. Tabla vacía, riesgo cero |
| 2 | Cargar Daniela (id 1) y Elsa (id 2) con `prisma/seed-profesionales.js`, ids explícitos. El script va en `/app`, no en `/tmp` |
| 3 | Agregar las FK **con `@default(1)`** + las columnas nullable + `liquidable`. `db push`. El default hace el backfill solo: todo lo existente queda en Daniela sin ningún UPDATE a mano |
| 4 | Quitar el `@default(1)` de `Servicio`, `HorarioConfig` y `Turno`. `db push` otra vez |

El paso 4 no es burocracia: si el default se queda, el día que un bug se olvide
de setear `profesional_id` el turno **se asigna a Daniela en silencio** — justo
el error que este diseño quiere evitar. Sin default, ese bug explota con un
error en vez de ensuciar la liquidación.

### 9.1 Orden del deploy

Los pasos 1 a 3 se pueden hacer **con el código viejo corriendo**: no manda
`profesional_id`, el default se lo pone, y como todo lo que existe hoy es de
Daniela, el resultado es correcto.

```
pasos 1-3  ->  deploy backend  ->  deploy frontend  ->  paso 4
```

Cero downtime. En ningún momento la web queda a medias.

### 9.2 Carga de datos posterior

Desde el panel, sin scripts:

1. PRP id 16 va a `activo = false`.
2. Los 7 servicios de Elsa: nombre, duración, precio, comisión (default o
   excepción).
3. Los días y horarios de Elsa.
4. El `comision_pct_default` y el teléfono de Elsa.

## 10. Testing

El proyecto no tiene tests: ni script `test`, ni framework, ni archivos, en
ninguno de los dos repos. Este spec **no** monta una infraestructura de testing
completa — sería un cambio no pedido. Pero tampoco toca la plata a ciegas.

### 10.1 Tests automáticos: lógica pura

Con `node:test`, incluido en Node 24. Cero dependencias nuevas, un script
`npm test`.

`lib/comisiones.js`:
- hereda el `%` de la profesional cuando el servicio no tiene
- la excepción del servicio le gana a la herencia
- `comision_pct_default = null` da como resultado que no se liquida
- `comision_pct = 0` en el servicio da 0%, **no** hereda
- los extras entran en la base del cálculo

`lib/reservas.js`:
- una reserva con servicios de dos profesionales se rechaza con
  `SERVICIOS_DE_DISTINTAS_PROFESIONALES`
- una reserva de una sola profesional pasa y escribe los tres campos congelados

### 10.2 Verificación manual

Requiere base de datos. Checklist a correr antes de cargar los datos reales:

1. Turno de Elsa a las 15:00, el horario de Daniela a las 15:00 **sigue libre**
2. Turno de Elsa a las 15:00, otro turno de Elsa a las 15:00 **se rechaza**
3. Bloqueo "todo el estudio" cierra las dos agendas
4. Bloqueo "solo Elsa", Daniela sigue disponible
5. Un día sin horarios de Elsa, sus servicios no ofrecen ningún slot
6. Intercalable de Daniela (Pro lifting + Pies) funciona igual que antes
7. Métricas: la facturación de los meses cerrados **no cambia** después de
   migrar. Anotar el número antes y comparar después
8. En la web pública, al elegir un servicio de Elsa los de Daniela quedan
   deshabilitados (y al revés): la reserva mixta **no se puede ni armar**
9. Reserva mixta forzada por API rechazada con mensaje claro
10. Liquidación de un período con un turno marcado `liquidable = false`: ese
    turno no aparece ni suma
11. Un hold de pago de Daniela en curso **no** bloquea el horario de Elsa
    (§5.5)

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| `db push` sobre producción sin historial de migraciones | Migración escalonada (§9) + backup antes del paso 3 |
| Un turno nuevo sin `profesional_id` cae en Daniela en silencio | Paso 4: quitar el `@default(1)` |
| La liquidación cambia retroactivamente al tocar precios | Campos congelados en `Turno` (§4.4) |
| Cobrarle comisión a Elsa por una clienta que no vino | `liquidable` (§8.3) |
| Activar Mercado Pago desvía plata de Elsa a Daniela | Exclusión explícita en `calcularMonto` (§6.3) |
| Daniela asigna a Elsa un servicio que no es suyo | Filtrado de servicios por profesional en el alta manual (§7.2) |
| Un hold de pago de Daniela congela la agenda de Elsa | El checkout setea `profesional_id` en el hold (§5.5) |
| La clienta arma una reserva mixta y recibe el error al final | Bloqueo en el STEP 1 de la web pública (§7.3) |
