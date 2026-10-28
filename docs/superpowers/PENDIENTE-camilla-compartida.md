# Camilla compartida — lo que falta hacer

Todo el código está escrito y commiteado en la rama `feat/camilla-compartida`
de los **dos** repos. Lo que queda necesita la base de producción o el panel,
así que va de tu lado.

**El orden importa, y acá más que la vez pasada.** Ver el paso 2.

---

## 1. Backup del Postgres

Desde Railway, servicio **Postgres**. Barato y es el único resguardo.

Este cambio agrega dos columnas booleanas con default y no toca ni una fila
existente, así que el riesgo real es bajo — pero el backup es gratis.

## 2. `prisma db push` ANTES del deploy ⚠️

En la Console de `turnos-backend`:

```bash
npx prisma db push
```

Esperás: agrega `servicios.usa_camilla` y `reservas_pendientes.usa_camilla`,
las dos en `false`. Ninguna fila se modifica, ninguna tabla se recrea.

**Si desplegás el código primero, el tomador se cae.** El cliente de Prisma
enumera las columnas al consultar, así que todo `findMany` de servicios
devuelve P2022 hasta que las columnas existan. Eso se lleva puestos
`/api/servicios`, los dos endpoints de disponibilidad, los cinco caminos que
crean turnos y el panel. Al revés no pasa nada: el código viejo ignora las
columnas nuevas.

No hay nada automático que lo haga: el `postinstall` del repo solo corre
`prisma generate`.

## 3. Deploy

Railway (`turnos-backend`) a mano, como siempre. Vercel se despliega solo con
el merge a `master`.

## 4. Tildar los servicios de camilla

**Hasta acá el cambio no bloquea nada.** Las dos columnas arrancan en `false`,
así que el estudio se comporta exactamente igual que antes del deploy. Esto es
a propósito: el deploy no cambia el comportamiento, vos decidís cuándo empieza
a aplicar.

En el panel → **Servicios** → Editar, tildar **"Usa la camilla"** en todos los
servicios que se hacen en la camilla, de las **dos** profesionales. Si solo se
tilda en una, la regla no tiene con qué cruzar y no bloquea nada.

Los de uñas quedan sin tildar: ésos siguen corriendo en paralelo, que es el
punto de todo esto.

> Ojo con **Pies** si es uno de los servicios intercalables de Daniela. Si lo
> tildás, dejará de poder intercalarse con PRP **para clientas distintas** (la
> cama es una). Para la misma clienta sigue funcionando, que es para lo que la
> intercalación existe. Si Pies en realidad no se hace en la camilla, no lo
> tildes.

## 5. Probar

En el sitio público, con los servicios ya tildados:

1. Reservar un servicio de camilla con una profesional.
2. Buscar el mismo horario para un servicio de camilla de la otra → **no
   aparece** en la lista de horarios.
3. Buscar el mismo horario para un servicio de uñas → **sí aparece**.
4. Con los datos de la clienta del punto 1, intentar un turno solapado con la
   otra profesional → llega al paso 4 y ahí lo rechaza, nombrando el turno que
   choca.

---

## Lo que queda sin resolver, a propósito

- **Dos reservas simultáneas de la misma camilla en agendas distintas** pueden
  pasar las dos validaciones y entrar. Es la misma carrera que ya existe dentro
  de una agenda (lectura y escritura no están serializadas), y con este volumen
  de turnos no vale la complejidad. Si alguna vez pasa, se arregla con una
  constraint de exclusión en Postgres.

- **Daniela no puede forzar un turno** desde el panel si la camilla está
  ocupada o si la clienta ya tiene otro turno solapado. Es un bloqueo duro: una
  cama es una cama. Si en la práctica necesita pisarlo, se le agrega una salida.

- **Al panel le llega el mensaje escrito para la clienta** ("elegí otro horario
  … y listo"). Funciona, pero suena raro leído por Daniela. Vale un texto propio
  si molesta.

- **El cobro online sigue apagado** (`cobro_activo = false`). El camino de pago
  quedó corregido igual: el hold del propio pago ya no se bloquea a sí mismo, y
  un choque de camilla durante el pago devuelve la plata y te avisa. Antes de
  prender el cobro, revisar también lo anotado en
  `PENDIENTE-segunda-profesional.md`.
