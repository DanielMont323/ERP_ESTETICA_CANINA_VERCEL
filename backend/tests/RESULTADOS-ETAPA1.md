# Etapa 1 — Resultados de validación (2026-11-10)

Entorno: MongoDB 9.0 local, puerto 27018, replica set `rs-erp-test`, base `erp-jest-test`
(se borra y recrea en cada prueba; la guardia aborta si la URI no es esa).
Pruebas HTTP reales con supertest y JWT obtenido por `POST /api/auth/login`.
Ejecutar: `npx jest --forceExit` (desde `backend/`, con la instancia 27018 levantada).

Código probado: rama local `fifo-rentabilidad` + corrección mínima de sintaxis en
`routes/ventas.js` (llave faltante en el PUT). Sin otras correcciones.

Resultado: 32 pruebas — 5 pasan (infraestructura y F14-inicialización), 27 fallan.

| Id | Defecto | Estado |
|---|---|---|
| F1 | `POST /ventas` pasa la sesión como `operationId` | **Confirmado.** Toda venta falla (CastError) y la capa queda descontada aunque se aborte la transacción |
| F15 | `catch` externo de `POST /ventas` usa `session` fuera de alcance | **Confirmado.** El servidor nunca responde (la petición se cuelga) |
| F16 | `idempotencyKey: null` + índice único sparse (existe en producción) | **Confirmado.** La 2ª compra falla con E11000 |
| F17 | `movementId: null` por defecto + índice único sparse | **Confirmado** en base de pruebas. En producción el índice no existe todavía |
| F5 | Editar venta anterior a FIFO descuenta dos veces | **Confirmado** |
| F7 | Capa nueva de `PUT /compras` usa la fecha de hoy | **Confirmado** (esperado 2026-01-15, obtuvo la fecha de hoy) |
| F8 | `PUT /compras` usa `baseUnitCost` viejo; reversión sin IVA | **Confirmado** (capa 116 en vez de 232; reversión 200 en vez de 232) |
| F9 | `DELETE /compras` revierte también capas inactivas | **Confirmado** (2 reversiones en vez de 1) |
| F10 | Índice sobre `compra` en vez de `purchase` | **Confirmado** |
| F12 | `PATCH /productos/:id/stock` sin token y cambios de stock fuera de FIFO | **Confirmado** (sin token → 200; stock y capas desincronizados) |
| S1 | Usuario no admin puede cancelar compras | **Confirmado** |
| S2 | Costos, reportes, clientes, ventas y servicios sin token | **Confirmado** (6 de 6) |
| F2, F3, F4, F6 | Doble reversión, `originalMovement` vacío, cancelación sin capas, reparto con decimales | **No comprobado**: bloqueado porque ninguna venta se puede crear (F1/F15). Se re-ejecutan al corregir F1 |
| F14 | `fifoInitialized=true` sin capas (estado real de 10 productos en producción) | La inicialización SÍ crea la capa y es idempotente (pasa). Vender un producto sin capas: bloqueado por F1 |
| F13 | Lock de inicialización no se libera al fallar | No reproducido (solo revisión de código) |
| F11 | `autoIndex:false` en producción | Verificado con datos: en producción faltan los índices `movementId`, `operationId`, `operationBatchId` de movimientos |

Nota de aislamiento: las suites 10/20/30 eliminan los índices de F16/F17 en la base de pruebas
para medir cada defecto por separado. F16/F17 se prueban con índices completos en `05-indices-null.test.js`.

---

# Etapa 2 — Corrección de bloqueantes (2026-11-10)

Correcciones aplicadas (mínimas, comentadas en el código):

| Id | Archivo | Cambio |
|---|---|---|
| F1 | `routes/ventas.js` | `POST` pasa `uuidv4()` como `operationId` y la sesión en su lugar |
| F15 | `routes/ventas.js`, `helpers/consumoFifo.js` | El catch externo ya no usa `session`; errores FIFO llevan `httpStatus` (400 stock insuficiente, 409 inconsistencia, 404 producto) |
| F16 | `routes/compras.js` | No se guarda `idempotencyKey: null`; el campo se omite |
| F17 | `models/InventoryMovement.js` | `movementId` sin `default: null` |
| F18 (nuevo) | `routes/ventas.js` | `ventaDoc` declarado fuera del try: antes la venta se guardaba pero se respondía 500 |

Resultado tras las correcciones: 32 pruebas — **11 pasan, 21 fallan**.

Ahora pasan: F1 (costo FIFO $620 correcto y atomicidad), F15, F16, F17, F14 (venta sin capas → 409).

Defectos que antes estaban bloqueados y ahora quedan **confirmados**:

| Id | Evidencia |
|---|---|
| F2 | La 2ª edición de una venta responde 500: "Restauración excedería initialQuantity (12 > 10)". La guardia evita inventario fantasma, pero ninguna venta se puede editar dos veces |
| F3 | El movimiento de reversión tiene `originalMovement: null` |
| F4 | Cancelar venta: stock vuelve a 10 pero capas quedan en 6 (desincronizado → el producto queda bloqueado). En servicios no se devuelven los insumos |
| F6 | Una línea consume 0.99 unidades de una capa (reparto con redondeo) |

Siguen confirmados sin cambios: F5, F7, F8, F9, F10, F12, S1, S2.

---

# Etapa 2 — Ediciones y cancelaciones de ventas (2026-11-10)

| Id | Archivo | Cambio |
|---|---|---|
| F2/F3 | `helpers/revertirFifoVenta.js` | Una reversión por movimiento original, con `originalMovement`; se omiten los ya revertidos. Los originales no se modifican |
| F6 | `helpers/consumoFifo.js` | Las capas se asignan a cada línea en orden FIFO (sin prorrateo ni redondeo) |
| F4 | `routes/ventas.js` (DELETE) | Transacción; ventas FIFO restauran capas e insumos con movimientos `cancelacion_venta` |
| F5 | `routes/ventas.js` (PUT) | Venta sin `fifoTracked` → 409 al intentar modificar artículos |
| — | `models/Venta.js` | Campo nuevo opcional `fifoTracked` (solo ventas nuevas). Las 544 ventas existentes no lo tienen |

Decisión de negocio a confirmar: cancelar una venta **histórica** cuyo producto ya tiene capas FIFO
responde 409 (requiere ajuste de inventario). Si el producto no tiene capas, se conserva el comportamiento original.

Resultado: 34 pruebas — **19 pasan, 15 fallan**. Todas las de ventas (13) pasan.
Pendientes: F7, F8, F9, F10 (compras), F12 (stock fuera de FIFO), S1, S2 (permisos).

Riesgo detectado sin corregir (F19): `PUT /api/ventas/:id` permite a cualquier usuario autenticado
poner `status: 'cancelada'` sin devolver inventario (no pasa por la lógica de cancelación).

---

# Etapa 2 — Compras con FIFO (2026-11-10)

| Id | Archivo | Cambio |
|---|---|---|
| F8 | `routes/compras.js` | `normalizarItemCompra`: el PUT recalcula `baseUnitCost` desde `unitCost` con la misma regla de IVA que el POST. La reversión se valora al costo de la capa original |
| F7 | `routes/compras.js` | La capa nueva del PUT usa la fecha de la compra y guarda el proveedor; el movimiento lleva fecha y usuario |
| F9 | `routes/compras.js` (DELETE) | Solo se revierten las capas activas |
| F10 | `models/InventoryLayer.js`, `routes/compras.js` | Índice sobre `purchase`; `capaTieneConsumoVigente` busca por `layersConsumed.layer` y descuenta salidas ya revertidas |

Sin cambios: el PUT de compras anteriores a FIFO (sin capas) conserva su lógica original.

Resultado: 36 pruebas — **26 pasan, 10 fallan**. Todas las de ventas y compras pasan.
Pendientes: F12 (stock fuera de FIFO), S1, S2 (permisos), F19 (cancelar venta por PUT).

# Etapa 2 — Stock fuera de FIFO y permisos (2026-11-11)

| Defecto | Corrección | Estado |
|---|---|---|
| F12 PATCH /productos/:id/stock | Exige token + admin. En productos FIFO (inicializados o con capas activas) responde 409. Productos sin FIFO conservan el comportamiento original | Implementado y probado |
| F12 PUT /productos/:id | Si el producto es FIFO y el `stock` enviado difiere del actual → 409; si es igual, se ignora y los demás datos se guardan | Implementado y probado |
| F19 PUT /ventas/:id con `status` | Cambiar el estado por PUT → 409 (cancelar va por DELETE, que devuelve inventario). Enviar el mismo estado sigue funcionando | Implementado y probado |
| S1 DELETE /compras/:id | `requireAdmin` | Implementado y probado |
| S2 endpoints abiertos | `authenticateToken` al montar todas las rutas de `/api` excepto `/api/auth` y `/api/health`. `authenticateToken` no revalida si `req.user` ya existe | Implementado y probado (backend). No comprobado en la interfaz real |

Nota: los 10 productos de producción con `fifoInitialized:true` y sin capas quedan bajo la regla F12 (stock no editable) hasta repararlos.
Decisión pendiente: los permisos por rol (p. ej. si un usuario no admin puede ver costos y reportes) no se cambiaron; S2 solo exige sesión.

Resultado: 49 pruebas — **49 pasan, 0 fallan**.

# Prueba en la interfaz real (2026-11-11)

Frontend local (3055) + backend local (5055) contra la copia `estetica-canica-test`. Usuarios de prueba en `backend/.env.ui-test`.
Recorrido con producto nuevo "PRUEBA FIFO Shampoo UI" (SKU PRUEBA-FIFO-UI), verificando base de datos tras cada paso.

| Paso | Resultado |
|---|---|
| Compra 2 × $116 IVA incluido | OK: stock 2, capa a $116 con proveedor, entrada $232 |
| Editar compra a 3 piezas | OK: capa vieja inactiva, reversión $232, capa nueva 3 × $116 |
| Venta de 1 | OK: stock 2 |
| Cancelar compra con mercancía vendida | OK: bloqueada con mensaje claro |
| Editar venta a 2 piezas | OK en inventario (reversión 1, salida 2) |
| Cancelar venta | OK: stock 3, capa completa |
| Producto FIFO: cambiar stock a 10 | OK: rechazado, mensaje claro en pantalla |
| Producto FIFO: cambiar solo precio | OK: guardado, stock intacto |
| Cancelar compra sin ventas vigentes | OK: una sola reversión de 3, stock 0 |
| Venta histórica: cambiar cantidad | OK: rechazada |
| Venta histórica: editar solo notas | **Fallaba (regresión de F5)**: la pantalla siempre reenvía los artículos. Corregido: si productos y cantidades no cambian se permite editar precios, pagos y notas sin mover inventario. Prueba agregada |
| Usuario normal | No ve editar/cancelar en ventas ni compras. Sí puede crear compras y ve Costos, Reportes y Cuentas por pagar |
| Vender producto con stock y sin capas FIFO | Rechazado: "Inconsistencia… Stock: 1, Capas: 0" |

**Bloqueante para desplegar:** en producción casi ningún producto tiene capas FIFO (la inicialización falló). Con este código, esos productos no se podrían vender. Antes de desplegar hay que ejecutar y validar la inicialización FIFO.

Hallazgos previos (no causados por estos cambios), pendientes:
- Fechas en UTC: una compra registrada después de las 5 pm aparece con el día siguiente y **no se puede editar** sin corregir la fecha (el formulario la rechaza como fecha futura). Afecta también la agrupación por día de los reportes.
- Editar una venta: al cambiar la cantidad la pantalla no recalcula total ni pagos; el servidor guarda total $400 con pagos $200 sin validar que cuadren.
- Lista de compras: columna IVA muestra $0.00 en compras con IVA incluido.
- Nuevo producto: dice que el SKU se genera solo, pero lo exige.
- Catálogo de vacunas: usuario normal recibe 403 (ruta solo admin desde antes).
- Falta `frontend/public/portada.jpg` (fondo del login).
- "Costo" del producto ($100 capturado) difiere del costo FIFO real ($116): la rentabilidad no debe usar `Producto.cost`.

Resultado automático: 50 pruebas — **50 pasan**.

# Fechas de compras (2026-11-11)

Causa: `getCurrentDateGMT7()` **suma** 7 horas al instante UTC en lugar de restarlas. A partir de las 10:00 de Tepic (17:00 UTC) devuelve el día siguiente. Las compras sin fecha elegida tomaban ese valor; la pantalla muestra la fecha con componentes UTC y la fecha máxima del formulario se calculaba en UTC (`toISOString`), así que al editar la compra el formulario la rechazaba como fecha futura.

Corrección (solo compras; ventas, reportes, recordatorios y carnets siguen usando `getCurrentDateGMT7`):
- Nuevo `hoyCalendarioTepic()`: el día de hoy en America/Mazatlan con la convención de fechas de calendario (12:00 UTC). Lo usan el POST de compras (fecha, vencimiento de crédito, capa FIFO y movimiento) y el default del modelo `Compra`.
- Frontend: la fecha máxima del formulario de compras usa el día de Tepic (`hoyTepicISO`).
- Pruebas: `25-fechas-compras.test.js` (horas límite del día, compra sin fecha, edición conservando la fecha).
- Verificado en pantalla a las 10:3x de Tepic: compra sin fecha → 11/11; edición carga 11/11 y guarda sin error.

Datos existentes (no modificados): 1 de 44 compras históricas aparece un día después (`6a87e0208bd8e5b7c0574a11`: muestra 21/08, registrada el 20/08 22:20 Tepic).
Pendiente: `getCurrentDateGMT7` afecta igual a ventas (default de `Venta.date`) y a reportes; revisar antes de la Etapa 4.

Resultado automático: 57 pruebas — **57 pasan**.

# Fechas en todos los módulos (2026-11-11)

Queja del cliente: ventas hechas después de cierta hora aparecían al día siguiente. Confirmado.

**Causa:** `getCurrentDateGMT7()` sumaba 7 h en vez de restarlas (cambio introducido a inicios de septiembre; en agosto se guardaba bien). Además cada módulo leía las fechas con una convención distinta:

| Dónde | Antes | Efecto |
|---|---|---|
| Lista de ventas (pantalla) | hora del navegador sobre fecha +7 h | ventas después de las **17:00** se mostraban al día siguiente |
| Filtro por día de ventas | día UTC del servidor | ventas después de las **10:00** caían en el día siguiente |
| Reportes (estado de resultados, resumen, detalle, comportamiento, exportar) | rango 07:00Z–06:59Z sobre fecha +7 h; periodos con la zona del servidor | ventas después de las **17:00** contaban en el día (o mes) siguiente |
| Dashboard | meses con la zona del servidor; "mes anterior" terminaba el último día a las 00:00 | dejaba fuera las ventas del último día del mes anterior |
| Reporte de clientes | periodos con la zona del servidor | desfase según el servidor |
| Recordatorios, cuentas por pagar, mascotas | "hoy" con la zona del servidor o en UTC | ventanas de "hoy/próximos días" desplazadas hasta 7 h |
| Formularios (gastos, recordatorios, reportes, ventas, caducidad de productos) | "hoy" = día UTC (`toISOString`) | después de las 17:00 proponían o permitían el día siguiente |

**Convención única** (documentada en `helpers/timezone.js`): la hora de Tepic se guarda en los componentes UTC; fechas sin hora a las 12:00 UTC; un día = 00:00Z–23:59:59.999Z; se muestra con componentes UTC. Nuevo `rangoPeriodoTepic()` reemplaza los 6 bloques duplicados de periodos en reportes y el de clientes.

**Datos existentes (medido en la copia):** 427 ventas completadas con el defecto; **98 ventas ($47,173.24) se mostraban en el día siguiente** (sep 21, oct 57, nov 20). A nivel mes solo cambia una: venta `6ae6872d…` del 31/10 17:26 ($473), que contaba en noviembre.

**Script de corrección** `backend/migraciones/2026-11-corregir-fechas-tepic.js`: solo toca registros con la firma exacta del defecto (fecha − creación = +7 h ±2 s, o −1 h ±2 s del código de agosto). Simulación por defecto; respaldo EJSON antes de escribir; idempotente; fuera de la copia local exige `--autorizado-por-el-usuario`.
- Aplicado **solo en la copia local**: 458 ventas (436 +7 h, 22 −1 h) y 422 entradas de historial médico. Segunda pasada: 0.
- Totales por mes (copia): agosto y septiembre sin cambio; octubre +$473.00; noviembre −$473.00. Estado de resultados vía API: octubre $113,639.54, noviembre $38,478.40.

**No modificado:** fechas de carnets/aplicaciones de vacunas (se guardan como hora real y se muestran en hora de Tepic: ya eran correctas); 14 ventas del 2/11 con fecha 17 h antes de su creación (parecen corregidas a mano; caen en el día correcto); endpoints `audit-*` de reportes (diagnóstico).

**Pendiente de autorización:** correr el script en producción (primero simulación, revisar, luego `--aplicar --autorizado-por-el-usuario`), junto con el despliegue del código; si se despliega el código sin corregir los datos, las ventas anteriores con el defecto se verían desplazadas.

Resultado automático: 67 pruebas — **67 pasan** (zona del equipo America/Mazatlan y también con `TZ=UTC`).

# Inicialización (apertura) FIFO (2026-11-11)

Defectos del código anterior:
- **F13 confirmado:** el `finally` usaba una variable `error` inexistente; al fallar, la liberación del lock lanzaba ReferenceError y el lock quedaba tomado.
- Una sola transacción para ~400 productos: un error dentro abortaba la transacción y todos los productos siguientes fallaban.
- Productos con `fifoInitialized:true` y sin capas (10 en producción) se omitían → no se podían vender nunca.
- Productos sin costo hacían fallar la corrida (estado real de producción: `failed`, "Costo inválido").
- `uuid` se usaba sin estar declarado en `package.json` (venía de `exceljs`).

Reescritura (`POST /api/inventario/inicializar-fifo`):
- Una transacción por producto; el stock se lee dentro de la transacción.
- Idempotente por capas activas (no por la bandera); se puede repetir. Si se corta (p. ej. timeout del servidor), se vuelve a correr y continúa.
- Costo: `Producto.cost` con `costSource: 'costo_capturado'` (**estimado**). Sin costo → capa a $0 `sin_costo`, listada en la respuesta para capturarlo después. Compras nuevas: `costSource: 'compra'` (comprobado). Campo nuevo opcional en `InventoryLayer`.
- `receivedDate` = inicio del día de Tepic: la apertura se consume antes que compras del mismo día.
- Lock atómico; siempre se libera; 409 si hay otro vigente; se recupera si venció.
- Pruebas: `35-inicializacion-fifo.test.js` (8 casos).

Evidencia del costo: en la copia, de 75 productos con stock y compra registrada, 19 difieren >10% entre costo capturado y última compra; la mayoría exactamente ×1.16 (compras con IVA incluido sin marcar). El costo capturado parece neto de IVA; por eso se usa como base estimada.

Ejecución en la **copia local** (vía API, como se haría en producción): 3.7 s; 405 productos: 354 abiertos, 51 omitidos, 0 fallidos; sin costo: "Casco para mascota" y "Producto Test Rollback" (dato de prueba). Valor de apertura: 1,876 unidades, **$124,829.29** a costo capturado (estimado). Verificación de consistencia stock vs. capas: 404 productos, 0 inconsistencias. En pantalla: "Alfadex polvo" (antes rechazado) se vendió; costo de venta $48.75 desde la capa de apertura.

Resultado automático: 75 pruebas — **75 pasan**.

# Revisión de producción, solo lectura (2026-11-11)

| Punto | Estado |
|---|---|
| Servidor | MongoDB 8.0.37, replica set Atlas → transacciones OK |
| Backend | Proceso continuo (Procfile), no serverless: la apertura FIFO no tiene límite de 10 s |
| Datos nuevos desde el respaldo del 10/11 | ventas 547, compras 45, clientes 259, mascotas 330, carnets 325, cuentas por pagar 1 → **hace falta respaldo nuevo antes de desplegar** |
| FIFOInitialization | `failed`, 2 intentos, lock libre → el código nuevo puede reintentar |
| Capas / movimientos | 0 / 0 |
| Productos | 405 activos; 357 con stock (1,896 u.); 10 `fifoInitialized` sin capas; sin stock negativo ni decimal |
| Sin costo con stock | "Casco para mascota" (1) y "Producto Test Rollback" (10) |
| **Productos de prueba** | 14 (SKU TEST-/CORR-TEST/FINAL-TEST), 170 u., **$12,750** a costo; 0 ventas y 0 compras; + 2 proveedores "Test" sin compras |
| Índices faltantes (autoIndex está apagado en producción) | inventorymovements: `movementId` único sparse, `operationId`, `operationBatchId`; ventas: `version`, `editOperationId`; inventorylayers: `purchase`. Sin duplicados que impidan crearlos. Sobra `compra_1` (inofensivo) |
| Corrección de fechas pendiente | 440 ventas +7 h, 22 ventas −1 h, 432 entradas de historial médico |
| Compras con IVA sin marcar "incluido" | 32 items (riesgo de doble IVA, pendiente) |

**Veredicto: todavía no está lista.** Es compatible (transacciones, sin conflictos de índices), pero antes de desplegar hacen falta pasos que modifican producción y requieren autorización.

# Preparación de producción (2026-11-11, autorizada por el usuario)

1. **Respaldo** `Documents\respaldos-erp\estetica-canica-2026-11-11-predespliegue`: 20 colecciones, 2,228 documentos, EJSON canónico + MANIFEST con sha256; verificado (re-lectura y hash 20/20).
2. **Datos de prueba desactivados** (`migraciones/2026-11-desactivar-datos-prueba.js`): 14 productos (SKU TEST-/CORR-TEST/FINAL-TEST) y 2 proveedores "Proveedor Test …" → `isActive:false`. Sin borrar, stock intacto (170 u.), ninguno tenía ventas/compras/capas. Log con los _id para revertir.
3. **Índices creados** (no modifican datos): inventorymovements `operationId_1`, `movementId_1` (único sparse), `operationBatchId_1`; ventas `version_1`, `editOperationId_1`; inventorylayers `purchase_1`. Verificado: el código actual de producción (`main`) no tiene FIFO, así que no escribe movimientos y el índice único no lo afecta.
4. **Verificación final:** 0 índices faltantes; 391 productos activos, 345 con stock (1,726 u., $115,367.06 a costo capturado); sin costo: solo "Casco para mascota".

Pendiente para el día del despliegue (requiere el código nuevo en producción): corrección de fechas (440 + 22 ventas, 432 historial médico) y apertura FIFO. Pendiente del usuario: capturar el costo de "Casco para mascota".

# Ensayo general del despliegue sobre copia exacta de producción (2026-11-11)

Por la regla "prohibido modificar información productiva para facilitar pruebas", las pruebas con escritura se hicieron sobre una copia exacta de producción ya preparada (respaldo `estetica-canica-2026-11-11-preparada`, restaurado como `estetica-canica-ensayo-test` en la instancia local), y en producción solo lecturas.

| Paso | Resultado en el ensayo | Producción (solo lectura) |
|---|---|---|
| Corrección de fechas | 440 + 22 ventas, 432 historial; 2ª pasada 0 | Simulación: 440 + 22, 432 ✔ igual |
| Apertura FIFO | 4.4 s; 391 productos: 345 abiertos, 46 omitidos, 0 fallidos; sin costo: "Casco para mascota"; 2ª corrida: 0 abiertos | 345 activos con stock ✔ igual; Casco sigue en $0 |
| Consistencia stock vs. capas | 390 productos, 0 inconsistencias | — |
| Estado de resultados por mes | Ventas: ago y sep iguales; oct +$473, nov −$473 (venta del 31/10 17:26). Gastos: los $398 del 1/oct pasan de septiembre a octubre (antes caían en el mes anterior) | — |
| Venta en pantalla (2 × Amoxicilina, producto real) | Registrada con fecha 11/11; costo $7.10 desde la capa de apertura | — |
| Cancelar esa venta | Stock y capa regresan a 159; reversión $7.10 | — |
| **Cancelar una venta de antes del despliegue** | **409: "requiere un ajuste de inventario"** — esa función no existe todavía | — |

**Bloqueante encontrado:** tras desplegar, ninguna venta anterior con productos se podría cancelar (los productos ya tienen capas FIFO y la venta no tiene movimientos que revertir). Hace falta una devolución de venta histórica (entrada de inventario como ajuste, con costo trazable) antes del despliegue.

Notas para la Etapa 4: el estado de resultados solo suma compras de contado y excluye gastos inactivos ($120 en octubre).
