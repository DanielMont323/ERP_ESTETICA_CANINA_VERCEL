# Plan de despliegue: FIFO, fechas de Tepic y permisos

Rama local: `fifo-rentabilidad`. Probado en ensayo sobre copia exacta de producción y con pruebas directas en producción (ver `backend/tests/RESULTADOS-ETAPA1.md`).

**Duración estimada:** 30–45 min. **Ventana:** al cierre del día, sin ventas en curso.
Entre el paso 5 (código nuevo en línea) y el paso 7 (apertura FIFO) **no se puede vender ningún producto**, por eso van seguidos.

Quién hace qué:
- **Tú:** GitHub (merge a `main` y push), panel de Vercel, Atlas.

**Cómo se despliega:** Vercel tiene dos proyectos (raíz `backend` y raíz `frontend`) conectados a GitHub. Un push a `main` despliega los dos automáticamente (~1–3 min). Un commit local no despliega: hace falta el push.
- **Claude:** scripts contra la base (pasos 2, 3, 6, 7, 8), solo con tu autorización ese día.

---

## Antes del día (cuando quieras)

| # | Tarea | Quién |
|---|---|---|
| A | Capturar el costo de **"Casco para mascota"** en Productos (hoy $0; si no, entra al inventario a $0 "sin costo") | Tú |
| B | ✅ **Verificado 11/11:** `MONGODB_URI`, `JWT_SECRET` y `NODE_ENV` existen (sensibles, *Production and Preview*). **Variables del backend en Vercel** (proyecto backend → Settings → Environment Variables, entorno *Production*): deben existir `MONGODB_URI`, `JWT_SECRET` y `NODE_ENV=production`. **Bloqueante:** hoy `main` incluye `backend/.env` en el repositorio y esta rama lo quita (tenía la contraseña). Si el backend dependía de ese archivo, sin las variables quedaría desconectado. Si `JWT_SECRET` de Vercel es distinto al del archivo, no pasa nada: Vercel ya usa el suyo | Tú |
| C | **Cambiar la contraseña** del usuario de Atlas (quedó escrita en el chat y en el historial de GitHub por el `.env`) y poner la nueva en `MONGODB_URI` de Vercel y en `backend/.env` de tu PC. Al cambiar una variable, Vercel necesita *Redeploy* para usarla | Tú |
| C2 | No hace falta nada para dependencias: Vercel corre `npm install` con el `package.json` (incluye `uuid`) | — |
| D | Decidir el **correo del administrador** a cuyo nombre se registra la apertura FIFO | Tú |

Ya hecho (11/11): datos de prueba desactivados, 6 índices creados, respaldo `estetica-canica-2026-11-11-preparada`.

---

## El día del despliegue

### 1. Avisar y detener ventas
Avisar al personal que no registre ventas ni compras durante ~30 min.

### 2. Respaldo final (Claude, solo lectura)
Respaldo completo EJSON con verificación de hash en `Documentos\respaldos-erp\estetica-canica-AAAA-MM-DD-despliegue`.
✔ Continuar solo si las 20 colecciones coinciden con el servidor.

### 3. Revisión previa (Claude, solo lectura)
- Corrección de fechas en **simulación**: anotar cuántas ventas/historial corregiría (el 11/11 eran 462 y 432; serán algo más por las ventas nuevas).
- Vista previa de la apertura: productos a abrir y valor.
```bash
node migraciones/2026-11-corregir-fechas-tepic.js --uri "<uri de producción>"
```
```bash
node migraciones/2026-11-apertura-fifo.js --uri "<uri de producción>" --admin <correo-admin>
```

### 4. Publicar el código (Tú)
```bash
git checkout main
```
```bash
git merge fifo-rentabilidad
```
```bash
git push origin main
```
No hay variables de entorno nuevas. **No subas la rama `fifo-rentabilidad` sola antes del día:** Vercel crearía un despliegue *Preview* que, si usa las mismas variables, apunta a la base de producción.

### 5. Esperar que el backend y el frontend nuevos estén en línea (Tú)
- En Vercel, los dos proyectos con el deployment nuevo en estado **Ready**.
- Backend: `https://<tu-backend>.vercel.app/api/health` responde OK; en *Logs* no hay errores de conexión a MongoDB.
- Frontend: la pantalla de login carga.
Backend y frontend deben quedar los dos con la versión nueva (las pantallas leen las fechas con la regla nueva).

### 6. Corrección de fechas (Claude)
```bash
node migraciones/2026-11-corregir-fechas-tepic.js --uri "<uri de producción>" --aplicar --autorizado-por-el-usuario
```
✔ Volver a correr en simulación: debe dar **0**. Guardar la ruta del respaldo que imprime (sirve para el rollback).

### 7. Apertura del inventario FIFO (Claude)
```bash
node migraciones/2026-11-apertura-fifo.js --uri "<uri de producción>" --admin <correo-admin> --aplicar --autorizado-por-el-usuario
```
✔ `status: completed`, `fallidos: 0`, **0 inconsistencias**. Si se corta, se vuelve a correr (continúa).

### 8. Verificación (Tú en pantalla + Claude en la base)
| Prueba | Esperado |
|---|---|
| Iniciar sesión (admin y usuario normal) | Entra |
| Lista de ventas | Ventas de ayer en la tarde con su día correcto |
| Registrar una venta real pequeña (o de prueba y cancelarla) | Se registra, fecha de hoy, stock baja |
| Cancelar esa venta | Stock regresa |
| Cancelar una venta de ayer (si hace falta) | Se cancela; la mercancía regresa como devolución |
| Productos: cambiar stock a mano de un producto | Rechazado con mensaje FIFO |
| Reportes: estado de resultados del mes pasado | Responde; el total puede moverse unos pesos por ventas de la tarde del último día |
| Claude: consistencia stock vs. capas | 0 inconsistencias |

### 9. Reabrir operación
Avisar al personal que ya pueden vender.

---

## Si algo sale mal (rollback)

Decidir **antes del paso 9**. Después de reabrir, las ventas nuevas ya usan FIFO y volver atrás pierde ese registro.

1. **Código:** en Vercel, en cada proyecto (backend y frontend) → *Deployments* → el deployment anterior → **Instant Rollback / Promote to Production**. Es inmediato y no requiere tocar GitHub — Tú.
2. **Fechas** (Claude): revierte exactamente con el respaldo del paso 6.
   ```bash
   node migraciones/2026-11-revertir-fechas-tepic.js --uri "<uri de producción>" --respaldo <archivo del paso 6> --aplicar --autorizado-por-el-usuario
   ```
3. **FIFO:** no hace falta tocar nada; el código anterior ignora capas y movimientos. Quedan guardados para un segundo intento (la apertura es idempotente).
4. **Último recurso:** restaurar desde el respaldo del paso 2.

Ensayado el 11/11 sobre la copia: revertir 462 ventas y 432 historiales y volver a corregir dio el mismo resultado.

---

## Qué cambia para el personal
- Las ventas de la tarde ya aparecen en su día.
- No se puede cambiar el stock a mano en productos con inventario FIFO: el stock cambia con compras, ventas y cancelaciones.
- Solo un administrador puede cancelar compras.
- Toda la app pide sesión (ya lo hacía la pantalla; ahora también el servidor).

## Pendientes después del despliegue (no bloquean)
- 32 artículos de compras con IVA no marcado como "incluido" (riesgo de doble IVA en costos).
- Editar una venta no recalcula pagos; el servidor no valida que cuadren con el total.
- Estado de resultados: solo cuenta compras de contado.
- Registros "ZZ PRUEBA SISTEMA" (cancelados/inactivos) de las pruebas en producción del 11/11.
- Etapas 3–5: costeo de servicios y rentabilidad por periodo.
