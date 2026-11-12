/**
 * Respaldo diario de la base de producción (solo lectura). Pensado para correr con el
 * Programador de tareas de Windows todos los días a las 11 pm (ver scripts/respaldo-diario.cmd).
 *
 * - Lee MONGODB_URI de backend/.env (o --uri para pruebas).
 * - Exporta todas las colecciones en EJSON canónico (un documento por línea) + índices,
 *   con sha256 por colección y verificación de conteo contra el servidor.
 * - Carpeta: Documentos\respaldos-erp\diarios\<base>-AAAA-MM-DD (fecha de Tepic).
 *   Si ya existe la del día, no la sobrescribe (agrega -2, -3...).
 * - Conserva los últimos N respaldos diarios (--conservar, 30 por defecto) y borra solo
 *   carpetas más antiguas creadas por este mismo script (con MANIFEST.json de tipo 'diario').
 * - Escribe una línea por ejecución en respaldos-erp\diarios\bitacora.log.
 * Código de salida 0 = respaldo completo y verificado; 1 = falló (revisar la bitácora).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient, BSON } = require('mongodb');
const { EJSON } = BSON;

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const uri = arg('--uri') || process.env.MONGODB_URI;
const raiz = arg('--destino') || path.join(os.homedir(), 'Documents', 'respaldos-erp', 'diarios');
const conservar = Number(arg('--conservar') || 30);

const fechaTepic = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const bitacora = linea => {
  fs.mkdirSync(raiz, { recursive: true });
  fs.appendFileSync(path.join(raiz, 'bitacora.log'), `${new Date().toISOString()} ${linea}\n`);
  console.log(linea);
};

(async () => {
  if (!uri) throw new Error('No hay MONGODB_URI (crea backend/.env)');
  const client = new MongoClient(uri, { readConcernLevel: 'majority', serverSelectionTimeoutMS: 30000 });
  await client.connect();
  try {
    const db = client.db(); // la base viene en la URI
    const base = db.databaseName;
    let salida = path.join(raiz, `${base}-${fechaTepic}`);
    for (let n = 2; fs.existsSync(salida); n++) salida = path.join(raiz, `${base}-${fechaTepic}-${n}`);
    fs.mkdirSync(salida, { recursive: true });

    const colecciones = (await db.listCollections({}, { nameOnly: false }).toArray())
      .filter(c => c.type === 'collection').sort((a, b) => a.name.localeCompare(b.name));
    const manifest = { tipo: 'diario', database: base, startedAt: new Date(), format: 'EJSON canonical, one document per line (.ejson.jsonl)', collections: [] };
    const diferencias = [];
    let documentos = 0;
    for (const c of colecciones) {
      const fd = fs.openSync(path.join(salida, `${c.name}.ejson.jsonl`), 'w');
      const hash = crypto.createHash('sha256');
      let n = 0;
      for await (const doc of db.collection(c.name).find({}).sort({ _id: 1 })) {
        const linea = EJSON.stringify(doc, { relaxed: false }) + '\n';
        fs.writeSync(fd, linea);
        hash.update(linea);
        n++;
      }
      fs.closeSync(fd);
      fs.writeFileSync(path.join(salida, `${c.name}.indexes.json`), EJSON.stringify(await db.collection(c.name).indexes(), null, 2, { relaxed: false }));
      const enServidor = await db.collection(c.name).countDocuments({});
      if (enServidor !== n) diferencias.push(`${c.name} ${n}/${enServidor}`);
      documentos += n;
      manifest.collections.push({ name: c.name, exported: n, serverCountAfter: enServidor, sha256: hash.digest('hex'), options: c.options });
    }
    manifest.finishedAt = new Date();
    fs.writeFileSync(path.join(salida, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

    // Una diferencia de conteo puede ser una venta registrada durante el respaldo: se anota, no se descarta.
    bitacora(`OK ${path.basename(salida)}: ${colecciones.length} colecciones, ${documentos} documentos`
      + (diferencias.length ? ` (cambiaron durante el respaldo: ${diferencias.join(', ')})` : ''));

    // Retención: solo carpetas de respaldos diarios de esta base, de este script
    const diarios = fs.readdirSync(raiz)
      .filter(d => d.startsWith(`${base}-`) && fs.existsSync(path.join(raiz, d, 'MANIFEST.json')))
      .filter(d => { try { return JSON.parse(fs.readFileSync(path.join(raiz, d, 'MANIFEST.json'), 'utf8')).tipo === 'diario'; } catch { return false; } })
      .sort();
    for (const viejo of diarios.slice(0, Math.max(0, diarios.length - conservar))) {
      fs.rmSync(path.join(raiz, viejo), { recursive: true, force: true });
      bitacora(`Borrado respaldo antiguo ${viejo} (se conservan los últimos ${conservar})`);
    }
  } finally {
    await client.close();
  }
})().catch(e => {
  // Nunca escribir la URI (tiene la contraseña) en la bitácora
  bitacora(`ERROR ${String(e.message).replace(/mongodb(\+srv)?:\/\/[^\s]+/g, '<uri>')}`);
  process.exit(1);
});
