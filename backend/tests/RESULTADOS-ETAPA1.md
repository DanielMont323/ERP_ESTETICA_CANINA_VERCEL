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
