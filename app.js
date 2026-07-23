pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ====================================================================
//  CONEXIÓN SUPABASE — reemplaza Google Apps Script
// ====================================================================
var SUPABASE_URL = "https://iozqlulwwlfkqscunzzj.supabase.co";
var SUPABASE_KEY = "sb_publishable_CCKRZDa7Lzdgqi7Ns8EwXw_2XnibYkO";
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

function sbCheck(res){ if(res && res.error) throw new Error(res.error.message || "Error de Supabase"); return res.data; }

// Mismo contrato que antes: gsr(fn, args, onSuccess, onError)
function gsr(fn, args, onSuccess, onError) {
  var handler = SB[fn];
  if (!handler) { var e = new Error("Función no implementada: " + fn); if (onError) onError(e); else console.error(e); return; }
  Promise.resolve().then(function () { return handler(args); })
    .then(function (data) { if (onSuccess) onSuccess(data); })
    .catch(function (err) {
      console.error("[" + fn + "]", err);
      if (onError) onError(err);
      else toast("❌ " + err.message, "err2");
    });
}

// ---- Caches de catálogo (nombre <-> id) ----
var catNombreToId = {}, catIdToNombre = {};
var ccCache = [];       // se llena en SB.getCentrosCostos
var equiposCacheAll = null; // cache perezosa de TODOS los equipos (para resolver equipo_id)

var DIM_SEDE = {
  "MANANTIALES": { nave: 707.2, medianave: 353.6 },
  "OLAS":        { nave: 462.4, medianave: 231.2 }
};

function parseFechaJS(v) {
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function alertaEstadoJS(fechaProg, hoy) {
  if (!fechaProg) return { estado: "sin_fecha", label: "Sin programar", dias: null };
  fechaProg = new Date(fechaProg); fechaProg.setHours(0, 0, 0, 0);
  var dias = Math.floor((fechaProg - hoy) / 86400000);
  if (dias < 0) return { estado: "vencido", label: "Vencido hace " + Math.abs(dias) + " días", dias: dias };
  if (dias <= 30) return { estado: "proximo", label: "En " + dias + " días", dias: dias };
  return { estado: "ok", label: "En " + dias + " días", dias: dias };
}
function soloFecha(d) { return d ? new Date(d).toISOString().split("T")[0] : ""; }

async function resolverEquipoId(codigo, descripcion) {
  codigo = String(codigo || "").trim();
  if (!codigo) return null;
  if (!equiposCacheAll) {
    var r = await sb.from("equipos").select("id, codigo, descripcion");
    equiposCacheAll = sbCheck(r) || [];
  }
  var m = equiposCacheAll.find(function (e) { return String(e.codigo || "").trim() === codigo; });
  return m ? m.id : null;
}
function ccValido(cc) {
  cc = String(cc || "").trim();
  if (!cc) return null;
  return ccCache.some(function (c) { return c.id === cc; }) ? cc : null;
}
function sedeValida(s) {
  s = String(s || "").trim().toUpperCase();
  return (s === "OLAS" || s === "MANANTIALES") ? s : null;
}

// ====================================================================
//  SB.* — un handler por cada función que antes vivía en codigo.gs
// ====================================================================
var SB = {};

// ---- ÓRDENES DE TRABAJO ----

SB.crearOT = async function (data) {
  var otId = String(data.ot_id).trim();
  var existe = sbCheck(await sb.from("ordenes_trabajo").select("id").eq("ot_id", otId).maybeSingle());
  if (existe) {
    return { ok: false, msg: "Ya existe una cotización con el código \"" + otId + "\". Usa otro código, o edítala desde Registros si es la misma." };
  }

  var sede = sedeValida(data.sede) || "OLAS";
  var cc = ccValido(data.centro_costos);
  var ins = await sb.from("ordenes_trabajo").insert({
    ot_id: otId,
    fecha: data.fecha,
    empresa: normalizarEmpresa(data.empresa || ""),
    sede_id: sede,
    clasificacion: data.clasificacion || null,
    precio_total: parseFloat(data.precio_total) || 0,
    centro_costo_id: cc,
    estado: "PENDIENTE"
  }).select("id").single();
  var row = sbCheck(ins);

  // Línea de costo inicial (placeholder), igual que guardarCostoInicial en Apps Script
  var hoy = data.fecha || soloFecha(new Date());
  await sb.from("costos_mantenimiento").insert({
    ot_id: row.id,
    fecha: hoy,
    empresa: normalizarEmpresa(data.empresa || ""),
    descripcion: "Registro inicial OT",
    ubicacion: "GENERAL",
    cantidad: 1,
    precio_unitario: parseFloat(data.precio_total) || 0,
    sede_id: sede,
    centro_costo_id: cc
  });
  return { ok: true, msg: "OT creada exitosamente" };
};

SB.getOTs = async function () {
  var r = await sb.from("ordenes_trabajo").select("*").order("creado_en", { ascending: false });
  var rows = sbCheck(r) || [];
  return rows.map(function (o) {
    return {
      ot_id: o.ot_id, id_interno: o.id, fecha: o.fecha,
      empresa: normalizarEmpresa(o.empresa || ""), sede: o.sede_id,
      clasificacion: o.clasificacion || "", observaciones: o.observaciones || "",
      precio_total: parseFloat(o.precio_total) || 0, centro_costos: o.centro_costo_id || "",
      estado: o.estado || "PENDIENTE", archivo_pdf: o.archivo_pdf_url || "",
      actas: [], actas_count: 0
    };
  });
};

SB.getItemsOT = async function (ot_id) {
  ot_id = String(ot_id).trim();
  var otR = await sb.from("ordenes_trabajo").select("id").eq("ot_id", ot_id).single();
  var ot = sbCheck(otR);
  if (!ot) return [];
  var r = await sb.from("costos_mantenimiento")
    .select("*, categorias(nombre), equipos(id, codigo, descripcion)")
    .eq("ot_id", ot.id);
  var rows = sbCheck(r) || [];
  return rows.filter(function (c) { return c.descripcion !== "Registro inicial OT"; })
    .map(function (c) {
      return {
        categoria: c.categorias ? c.categorias.nombre : "", tipo: c.tipo || "", labor: c.labor || "",
        descripcion: c.descripcion || "", ubicacion: c.ubicacion || "",
        cantidad: parseFloat(c.cantidad) || 0, precio: parseFloat(c.precio_unitario) || 0,
        total_linea: parseFloat(c.total_linea) || 0,
        equipo_id: c.equipos ? c.equipos.id : "",
        equipo_cod: c.equipos ? c.equipos.codigo : "", equipo_desc: c.equipos ? c.equipos.descripcion : ""
      };
    });
};

SB.saveDetalle = async function (payload) {
  var items = payload.items || [];
  var ot_id = String(payload.ot_id).trim();
  var otR = await sb.from("ordenes_trabajo").select("id").eq("ot_id", ot_id).single();
  var ot = sbCheck(otR);
  if (!ot) throw new Error("OT no encontrada: " + ot_id);

  await sb.from("costos_mantenimiento").delete().eq("ot_id", ot.id);

  var hoy = soloFecha(new Date());
  var filas = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var cant = parseFloat(item.cantidad) || 0;
    var prec = parseFloat(item.precio) || 0;
    var fechaItem = item.fecha_ot || hoy;
    // Si el ítem ya trae equipo_id (elegido en el buscador), se usa directo.
    // Si no, se intenta resolver por código/descripción (compatibilidad con carga masiva).
    var eqId = item.equipo_id ? item.equipo_id : await resolverEquipoId(item.equipo_cod, item.equipo_desc);
    filas.push({
      ot_id: ot.id, fecha: fechaItem, empresa: item.empresa || "",
      categoria_id: catNombreToId[item.categoria] || null, tipo: item.tipo || "", labor: item.labor || "",
      descripcion: item.descripcion || "", ubicacion: item.ubicacion || "", equipo_id: eqId || null,
      cantidad: cant, precio_unitario: prec, adjunto: "",
      sede_id: sedeValida(item.sede), centro_costo_id: ccValido(item.centro_costos)
    });
  }
  if (filas.length) { var insR = await sb.from("costos_mantenimiento").insert(filas); sbCheck(insR); }

  await procesarItemsInvernaderoJS(items, items.length && items[0].fecha_ot ? items[0].fecha_ot : hoy);
  return { ok: true };
};

SB.saveEditarOT = async function (datos) {
  var sede = sedeValida(datos.sede);
  var cc = ccValido(datos.centro_costos);
  var upd = await sb.from("ordenes_trabajo").update({
    ot_id: datos.ot_id, fecha: datos.fecha, empresa: normalizarEmpresa(datos.empresa || ""),
    sede_id: sede || "OLAS", clasificacion: datos.clasificacion || null,
    observaciones: datos.observaciones || "", precio_total: parseFloat(datos.precio_total) || 0,
    centro_costo_id: cc, estado: datos.estado
  }).eq("ot_id", datos.ot_id_original).select("id");
  var rows = sbCheck(upd);
  if (!rows || !rows.length) throw new Error("OT no encontrada: " + datos.ot_id_original);
  return { ok: true };
};

SB.deleteOT = async function (ot_id) {
  var del = await sb.from("ordenes_trabajo").delete().eq("ot_id", String(ot_id).trim());
  sbCheck(del);
  return { ok: true };
};

// ---- CATÁLOGO ----

SB.getCatalogo = async function () {
  var r = await sb.from("categorias").select("id, nombre, tipos_actividad(id, nombre)").order("nombre");
  var rows = sbCheck(r) || [];
  var out = {};
  catNombreToId = {}; catIdToNombre = {};
  rows.forEach(function (c) {
    catNombreToId[c.nombre] = c.id; catIdToNombre[c.id] = c.nombre;
    out[c.nombre] = (c.tipos_actividad || []).map(function (t) { return t.nombre; }).sort();
  });
  return out;
};

SB.saveCatalogo = async function (catalogoObj) {
  // Sincroniza la hoja completa de categorías/tipos contra lo que ya hay en la BD.
  var r = await sb.from("categorias").select("id, nombre, tipos_actividad(id, nombre)");
  var actuales = sbCheck(r) || [];
  var actualesPorNombre = {}; actuales.forEach(function (c) { actualesPorNombre[c.nombre] = c; });

  for (var nombre in catalogoObj) {
    if (!catalogoObj.hasOwnProperty(nombre)) continue;
    var tiposNuevos = catalogoObj[nombre] || [];
    var cat = actualesPorNombre[nombre];
    var catId;
    if (!cat) {
      var insC = await sb.from("categorias").insert({ nombre: nombre }).select("id").single();
      catId = sbCheck(insC).id;
      cat = { id: catId, nombre: nombre, tipos_actividad: [] };
    } else { catId = cat.id; }
    catNombreToId[nombre] = catId; catIdToNombre[catId] = nombre;

    var tiposActuales = (cat.tipos_actividad || []).map(function (t) { return t.nombre; });
    var aInsertar = tiposNuevos.filter(function (t) { return tiposActuales.indexOf(t) < 0; });
    var aBorrar = (cat.tipos_actividad || []).filter(function (t) { return tiposNuevos.indexOf(t.nombre) < 0; });
    for (var i = 0; i < aInsertar.length; i++) {
      await sb.from("tipos_actividad").insert({ categoria_id: catId, nombre: aInsertar[i] });
    }
    for (var j = 0; j < aBorrar.length; j++) {
      await sb.from("tipos_actividad").delete().eq("id", aBorrar[j].id);
    }
  }
  // Categorías que ya no están en el objeto local: se intentan borrar (si tienen
  // costos ligados, la base de datos rechaza el borrado y simplemente se ignoran).
  for (var nombreDB in actualesPorNombre) {
    if (!catalogoObj.hasOwnProperty(nombreDB)) {
      try { await sb.from("categorias").delete().eq("id", actualesPorNombre[nombreDB].id); }
      catch (e) { /* tiene costos históricos ligados: se conserva */ }
    }
  }
  return { ok: true };
};

// ---- CENTROS DE COSTO / EQUIPOS / UBICACIONES ----

SB.getCentrosCostos = async function () {
  var r = await sb.from("centros_costos").select("*");
  var rows = sbCheck(r) || [];
  ccCache = rows;
  return rows.map(function (c) {
    return { id: c.id, sede: c.sede_id, clasificacion: c.clasificacion, descripcion: c.descripcion || "", estado: c.estado || "", presupuesto: parseFloat(c.presupuesto) || 0 };
  });
};

SB.getEquiposPorSede = async function (sede) {
  var q = sb.from("equipos").select("*");
  if (sede) q = q.eq("sede_id", sedeValida(sede) || sede);
  var r = await q;
  var rows = sbCheck(r) || [];
  return rows.map(function (e) {
    return { id: e.id, codigo: e.codigo || "", descripcion: e.descripcion || "", referencia: e.referencia || "", ubicacion: e.ubicacion || "", marca: e.marca || "", sede: e.sede_id || "", estado: e.estado || "", area: e.area || "", criticidad: e.criticidad || "" };
  });
};

SB.getUbicacionesPorSede = async function (data) {
  var categoria = String(data.categoria || "").toLowerCase();
  if (categoria.indexOf("invernadero") < 0) return [];
  var q = sb.from("invernaderos_bloques").select("ubicacion");
  if (data.sede) q = q.eq("sede_id", sedeValida(data.sede) || data.sede);
  var r = await q;
  var rows = sbCheck(r) || [];
  return rows.map(function (x) { return x.ubicacion; }).filter(Boolean);
};

SB.getUbicacionesMecanicos = async function (sede) {
  var q = sb.from("equipos").select("ubicacion");
  if (sede) q = q.eq("sede_id", sedeValida(sede) || sede);
  var r = await q;
  var rows = sbCheck(r) || [];
  var set = {};
  rows.forEach(function (x) { var u = String(x.ubicacion || "").trim(); if (u) set[u] = true; });
  return Object.keys(set).sort();
};

// ---- ANALÍTICA / DASHBOARD ----

SB.getAnalitica = async function () {
  var rOT = await sb.from("ordenes_trabajo").select("ot_id, fecha, empresa, sede_id, estado, precio_total");
  var ots = (sbCheck(rOT) || []).map(function (o) {
    return { ot_id: o.ot_id, fecha: o.fecha, empresa: normalizarEmpresa(o.empresa || ""), sede: o.sede_id, estado: o.estado, precio_total: parseFloat(o.precio_total) || 0 };
  });
  var rC = await sb.from("costos_mantenimiento").select("fecha, empresa, tipo, labor, descripcion, cantidad, precio_unitario, total_linea, sede_id, centro_costo_id, categorias(nombre), ordenes_trabajo!inner(ot_id)");
  var costos = (sbCheck(rC) || []).map(function (c) {
    return {
      ot_id: c.ordenes_trabajo.ot_id, fecha: c.fecha, empresa: normalizarEmpresa(c.empresa || ""),
      categoria: c.categorias ? c.categorias.nombre : "", tipo: c.tipo || "", labor: c.labor || "",
      descripcion: c.descripcion || "", cantidad: parseFloat(c.cantidad) || 0, precio: parseFloat(c.precio_unitario) || 0,
      total_linea: parseFloat(c.total_linea) || 0, sede: c.sede_id || "", cc: c.centro_costo_id || ""
    };
  });
  return { ots: ots, costos: costos };
};

SB.getAnaliticaEquipos = async function () {
  var r = await sb.from("costos_mantenimiento")
    .select("fecha, cantidad, total_linea, sede_id, categorias(nombre), equipos!inner(codigo, descripcion), ordenes_trabajo!inner(ot_id)")
    .not("equipo_id", "is", null);
  var rows = sbCheck(r) || [];
  return rows.map(function (c) {
    return {
      ot_id: c.ordenes_trabajo.ot_id, fecha: c.fecha, categoria: c.categorias ? c.categorias.nombre : "",
      tipo: "", descripcion: "", sede: c.sede_id || "", equipo_cod: c.equipos.codigo || "",
      equipo_desc: c.equipos.descripcion || "", total_linea: parseFloat(c.total_linea) || 0
    };
  });
};

SB.getAnaliticaInvernaderos = async function () {
  var rInv = await sb.from("invernaderos_bloques").select("sede_id, ubicacion, num_naves, num_medianave");
  var bloques = sbCheck(rInv) || [];
  var bloquesMap = {};
  bloques.forEach(function (b) {
    var dim = DIM_SEDE[b.sede_id] || { nave: 462.4, medianave: 231.2 };
    var m2 = (parseFloat(b.num_naves) || 0) * dim.nave + (parseFloat(b.num_medianave) || 0) * dim.medianave;
    bloquesMap[b.sede_id + "|" + String(b.ubicacion || "").toUpperCase()] = { naves: parseFloat(b.num_naves) || 0, medianaves: parseFloat(b.num_medianave) || 0, m2: m2 };
  });
  var rC = await sb.from("costos_mantenimiento")
    .select("fecha, tipo, labor, descripcion, cantidad, precio_unitario, total_linea, sede_id, ubicacion, categorias!inner(nombre), ordenes_trabajo!inner(ot_id)")
    .ilike("categorias.nombre", "%invernadero%");
  var rows = sbCheck(rC) || [];
  return rows.map(function (r) {
    var key = (r.sede_id || "") + "|" + String(r.ubicacion || "").toUpperCase();
    var info = bloquesMap[key] || { naves: 0, medianaves: 0, m2: 0 };
    return {
      ot_id: r.ordenes_trabajo.ot_id, fecha: r.fecha, sede: r.sede_id || "", ubicacion: r.ubicacion || "",
      tipo: r.tipo || "", labor: r.labor || "", descripcion: r.descripcion || "",
      cantidad: parseFloat(r.cantidad) || 0, precio: parseFloat(r.precio_unitario) || 0, total_linea: parseFloat(r.total_linea) || 0,
      m2_bloque: info.m2, naves: info.naves, medianaves: info.medianaves
    };
  });
};

SB.getResumenInvernaderos = async function () {
  var rInv = await sb.from("invernaderos_bloques").select("*");
  var bloques = sbCheck(rInv) || [];
  var rC = await sb.from("costos_mantenimiento")
    .select("fecha, ubicacion, sede_id, tipo, categorias!inner(nombre)")
    .ilike("categorias.nombre", "%invernadero%")
    .ilike("tipo", "%lavado%");
  var costosLavado = (sbCheck(rC) || []).filter(function (c) { return String(c.tipo || "").toLowerCase().indexOf("cubiert") >= 0; });

  var hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  var out = [];
  bloques.forEach(function (b) {
    var sede = b.sede_id, ubic = b.ubicacion;
    var fEjeCambio = parseFechaJS(b.fecha_eje_cambio);
    var conteoReal = 0;
    costosLavado.forEach(function (c) {
      if (String(c.sede_id || "").toUpperCase() !== String(sede).toUpperCase()) return;
      if (String(c.ubicacion || "").toUpperCase() !== String(ubic).toUpperCase()) return;
      var fCosto = parseFechaJS(c.fecha);
      if (fEjeCambio && fCosto && fCosto <= fEjeCambio) return;
      conteoReal++;
    });
    var reqCambio = conteoReal >= 3;
    var aC = alertaEstadoJS(parseFechaJS(b.fecha_prog_cambio), hoy);
    var aL = reqCambio ? { estado: "cambio_req", label: "Requiere cambio (" + conteoReal + " lavados)", dias: 0 } : alertaEstadoJS(parseFechaJS(b.fecha_prog_lavado), hoy);
    var estados = [aC.estado, aL.estado];
    var global = estados.indexOf("vencido") >= 0 ? "vencido" : estados.indexOf("cambio_req") >= 0 ? "cambio_req" : estados.indexOf("proximo") >= 0 ? "proximo" : "ok";
    out.push({
      sede: sede, ubicacion: ubic, num_naves: parseFloat(b.num_naves) || 0, num_medianave: parseFloat(b.num_medianave) || 0,
      fecha_prog_cambio: soloFecha(b.fecha_prog_cambio), fecha_eje_cambio: soloFecha(b.fecha_eje_cambio),
      fecha_prog_lavado: soloFecha(b.fecha_prog_lavado), fecha_eje_lavado: soloFecha(b.fecha_eje_lavado),
      conteo_lavados: conteoReal, requiere_cambio: reqCambio, alerta_cambio: aC, alerta_lavado: aL, alerta_global: global
    });
  });
  var v = 0, p = 0, cr = 0, ok = 0;
  out.forEach(function (b) { if (b.alerta_global === "vencido") v++; else if (b.alerta_global === "cambio_req") cr++; else if (b.alerta_global === "proximo") p++; else ok++; });
  return { total: out.length, vencidos: v, proximos: p, cambios_req: cr, ok: ok, bloques: out };
};

// Puerto de procesarItemsInvernadero + registrarEjecucionInvernadero (Apps Script -> JS)
async function procesarItemsInvernaderoJS(items, fecha_ot) {
  var procesados = {};
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (String(item.categoria || "").toLowerCase().indexOf("invernadero") < 0) continue;
    var tipo = String(item.tipo || "").toLowerCase();
    var esCambio = tipo.indexOf("cambio") >= 0 && tipo.indexOf("cubiert") >= 0;
    var esLavado = tipo.indexOf("lavado") >= 0 && tipo.indexOf("cubiert") >= 0;
    if (!esCambio && !esLavado) continue;
    var key = (item.sede || "") + "|" + (item.ubicacion || "");
    if (procesados[key]) continue;
    procesados[key] = true;

    var sede = sedeValida(item.sede); if (!sede) continue;
    var ubic = String(item.ubicacion || "").trim(); if (!ubic) continue;
    var rB = await sb.from("invernaderos_bloques").select("*").eq("sede_id", sede).ilike("ubicacion", ubic).maybeSingle();
    var bloque = sbCheck(rB);
    if (!bloque) continue;
    var fecha = parseFechaJS(fecha_ot) || new Date();

    if (esCambio) {
      var pC = new Date(fecha); pC.setFullYear(pC.getFullYear() + 2);
      var pL = new Date(fecha); pL.setMonth(pL.getMonth() + 6);
      await sb.from("invernaderos_bloques").update({
        fecha_eje_cambio: soloFecha(fecha), fecha_prog_cambio: soloFecha(pC), fecha_prog_lavado: soloFecha(pL), fecha_eje_lavado: null
      }).eq("id", bloque.id);
    } else if (esLavado) {
      var rC = await sb.from("costos_mantenimiento")
        .select("fecha, ubicacion, sede_id, tipo, categorias!inner(nombre)")
        .ilike("categorias.nombre", "%invernadero%").ilike("tipo", "%lavado%");
      var lavados = (sbCheck(rC) || []).filter(function (c) { return String(c.tipo || "").toLowerCase().indexOf("cubiert") >= 0; });
      var fEjeC = parseFechaJS(bloque.fecha_eje_cambio);
      var conteo = 0;
      lavados.forEach(function (c) {
        if (String(c.sede_id || "").toUpperCase() !== sede) return;
        if (String(c.ubicacion || "").trim().toLowerCase() !== ubic.toLowerCase()) return;
        var fC = parseFechaJS(c.fecha);
        if (fEjeC && fC && fC <= fEjeC) return;
        conteo++;
      });
      var nuevoConteo = conteo + 1;
      var patch = { fecha_eje_lavado: soloFecha(fecha) };
      if (nuevoConteo < 3) { var pL2 = new Date(fecha); pL2.setMonth(pL2.getMonth() + 6); patch.fecha_prog_lavado = soloFecha(pL2); }
      else { patch.fecha_prog_lavado = null; }
      await sb.from("invernaderos_bloques").update(patch).eq("id", bloque.id);
    }
  }
}

// ---- ENERGÍA ----

SB.getEnergia = async function () {
  var r = await sb.from("energia").select("*");
  var rows = sbCheck(r) || [];
  return rows.map(function (e) {
    return { id_mov: e.id, sede: e.sede_id, anio: e.anio, mes: e.mes, consumo_kwh: parseFloat(e.consumo_kwh) || 0, generacion_fv_kwh: parseFloat(e.generacion_fv_kwh) || 0, valor_factura: parseFloat(e.valor_factura) || 0, observaciones: e.observaciones || "", fecha_reg: e.creado_en };
  });
};

SB.guardarEnergia = async function (data) {
  var sede = sedeValida(data.sede);
  var anio = parseInt(data.anio, 10), mes = parseInt(data.mes, 10);
  if (!sede || !anio || !mes) return { ok: false, msg: "Sede, año y mes son obligatorios" };
  var fila = {
    sede_id: sede, anio: anio, mes: mes,
    consumo_kwh: parseFloat(data.consumo_kwh) || 0, generacion_fv_kwh: parseFloat(data.generacion_fv_kwh) || 0,
    valor_factura: parseFloat(data.valor_factura) || 0, observaciones: String(data.observaciones || "").trim()
  };
  var idMov = String(data.id_mov || "").trim();
  var res;
  if (idMov) res = await sb.from("energia").update(fila).eq("id", idMov);
  else res = await sb.from("energia").upsert(fila, { onConflict: "sede_id,anio,mes" });
  sbCheck(res);
  return { ok: true, msg: idMov ? "Registro actualizado" : "Registro guardado" };
};

SB.eliminarEnergia = async function (id_mov) {
  var res = await sb.from("energia").delete().eq("id", String(id_mov).trim());
  sbCheck(res);
  return { ok: true };
};

// ---- CARGA MASIVA (cotizaciones de proveedores) ----

SB.cargaMasiva = async function (filas) {
  var grupos = {};
  filas.forEach(function (f) {
    var oid = String(f.ot_id || "").trim();
    if (!oid) return;
    if (!grupos[oid]) grupos[oid] = [];
    grupos[oid].push(f);
  });

  var creadas = [], omitidas = [], errores = [], lineasInsertadas = 0;

  for (var oid in grupos) {
    if (!grupos.hasOwnProperty(oid)) continue;
    var items = grupos[oid];
    try {
      var existe = await sb.from("ordenes_trabajo").select("id").eq("ot_id", oid).maybeSingle();
      var ex = sbCheck(existe);
      if (ex) { omitidas.push(oid); continue; }

      var primero = items[0];
      var sede = sedeValida(primero.sede) || "OLAS";
      var cc = ccValido(primero.centro_costo);
      var fechas = items.map(function (i) { return i.fecha; }).filter(Boolean).sort();
      var fecha = fechas.length ? fechas[0] : soloFecha(new Date());
      var total = items.reduce(function (a, i) { return a + (parseFloat(i.cantidad) || 0) * (parseFloat(i.precio_unitario) || 0); }, 0);

      var insOT = await sb.from("ordenes_trabajo").insert({
        ot_id: oid, fecha: fecha, empresa: normalizarEmpresa(primero.proveedor || ""),
        sede_id: sede, clasificacion: null, precio_total: total, centro_costo_id: cc,
        estado: String(primero.estado || "PENDIENTE").toUpperCase()
      }).select("id").single();
      var otRow = sbCheck(insOT);

      var filasCosto = items.map(function (i) {
        return {
          ot_id: otRow.id, fecha: i.fecha || fecha, empresa: normalizarEmpresa(primero.proveedor || ""),
          categoria_id: catNombreToId[String(i.categoria || "").trim()] || null,
          tipo: i.tipo || "", labor: i.labor || "", descripcion: i.descripcion || "",
          ubicacion: i.ubicacion || "", cantidad: parseFloat(i.cantidad) || 0,
          precio_unitario: parseFloat(i.precio_unitario) || 0,
          sede_id: sede, centro_costo_id: cc
        };
      });
      var insCostos = await sb.from("costos_mantenimiento").insert(filasCosto);
      sbCheck(insCostos);
      lineasInsertadas += filasCosto.length;
      creadas.push(oid);

      await procesarItemsInvernaderoJS(items, fecha);
    } catch (err) {
      errores.push({ ot_id: oid, msg: err.message });
    }
  }

  return { ok: true, creadas: creadas, omitidas: omitidas, errores: errores, lineas: lineasInsertadas };
};


var OT={}, pdfB64="", actasFiles=[];
var centrosCostosData = [];
var allOTs=[], filtOTs=[], pgOTs=1, pgSz=15;
var otData=[], costoData=[];
var charts={};
var currentEditOT=null;
var catalogo={}; // se carga desde Supabase (tablas categorias + tipos_actividad) al iniciar
var labores=["Mano de obra","Material","Repuesto","Servicio","Transporte","Otro"];
var CL=["#3b82f6","#10b981","#f59e0b","#8b5cf6","#ec4899","#06b6d4","#f97316","#84cc16","#ef4444","#a78bfa"];

function uniq(arr){var seen={},out=[];arr.forEach(function(v){if(v!==undefined&&v!==null&&v!==""&&!seen[v]){seen[v]=1;out.push(v);}});return out;}

window.addEventListener("DOMContentLoaded",function(){
  initTheme();
  document.getElementById("fecha").value=new Date().toISOString().split("T")[0];
  setupDrop("dz1","arch_pdf",false);
  setupDrop("dz2","arch_actas",true);
  document.addEventListener("click", function(e){
    var sw = e.target.closest(".estado-sw");
    if(sw) nextEstado(sw.getAttribute("data-otid"));
  });
  gsr("getCatalogo", null, function(data){
    if(data&&Object.keys(data).length>0){catalogo=data;}
    renderAdmin();
  }, function(){ renderAdmin(); });
  gsr("getCentrosCostos", null, function(data){
    centrosCostosData = Array.isArray(data) ? data : [];
  }, function(){});
  cargarRegs();
  cargarAnalitica();
});

function setupDrop(dzId,inputId,multi){
  var dz=document.getElementById(dzId);
  dz.addEventListener("dragover",function(e){e.preventDefault();dz.classList.add("drag")});
  dz.addEventListener("dragleave",function(){dz.classList.remove("drag")});
  dz.addEventListener("drop",function(){dz.classList.remove("drag")});
  document.getElementById(inputId).addEventListener("change",function(){
    if(multi){
      actasFiles=Array.from(this.files);renderActasList();
      if(actasFiles.length) toast("📎 "+actasFiles.length+" archivo(s)","ok2");
    } else {
      var f=this.files[0];if(!f)return;
      document.getElementById("dn1").textContent="✓ "+f.name;document.getElementById("dn1").style.display="block";
      var r=new FileReader();r.onload=function(){pdfB64=r.result};r.readAsDataURL(f);
    }
  });
}

function renderActasList(){
  var el=document.getElementById("actasList");el.innerHTML="";
  actasFiles.forEach(function(f,i){
    var d=document.createElement("div");d.style.cssText="display:flex;align-items:center;gap:0.5rem;background:var(--bg-hover);padding:0.5rem;border-radius:var(--radius-sm);border:1px solid var(--border-color);";
    d.innerHTML='<span style="font-size:1rem">'+fIco(f.name)+'</span><span style="flex:1;font-size:0.75rem;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(f.name)+'</span><button style="background:none;border:none;cursor:pointer;color:var(--danger);" onclick="rmActa('+i+')">✕</button>';
    el.appendChild(d);
  });
  var dn=document.getElementById("dn2");
  dn.textContent=actasFiles.length>0?"✓ "+actasFiles.length+" archivo(s)":"";
  dn.style.display=actasFiles.length>0?"block":"none";
}
function rmActa(i){actasFiles.splice(i,1);renderActasList()}
function fIco(n){var e=n.split('.').pop().toLowerCase();return{pdf:'📄',jpg:'🖼',jpeg:'🖼',png:'🖼',doc:'📝',docx:'📝'}[e]||'📎'}

function goTab(n){
  [1,2,3,4,5,6,7].forEach(function(i){document.getElementById("s"+i).classList.remove("on");document.getElementById("nt"+i).classList.remove("on")});
  document.getElementById("s"+n).classList.add("on");document.getElementById("nt"+n).classList.add("on");
  window.scrollTo({top:0,behavior:"smooth"});
  if(n===3) poblarCatFiltro();
  if(n===4) setTimeout(renderCharts,120);
  if(n===6) cargarEnergia();
}

function onDeSedeChange(preservar){
  var sede = document.getElementById("de_sede").value;
  var ccSel = document.getElementById("de_cc");
  var mantener = preservar !== undefined ? preservar : ccSel.value;
  if(!sede){ ccSel.innerHTML='<option value="">— Selecciona sede primero —</option>'; ccSel.disabled=true; return; }
  if(!centrosCostosData.length){
    ccSel.innerHTML='<option value="">Cargando...</option>'; ccSel.disabled=true;
    gsr("getCentrosCostos", null, function(data){ centrosCostosData=Array.isArray(data)?data:[]; poblarFiltrosCC(); onDeSedeChange(mantener); }, function(){});
    return;
  }
  var filtrados = centrosCostosData.filter(function(c){ return (c.sede||"").toUpperCase()===sede.toUpperCase(); });
  var opts='<option value="">— Selecciona CC —</option>', found=false;
  filtrados.forEach(function(c){
    var sel = c.id===mantener; if(sel) found=true;
    opts+='<option value="'+esc(c.id)+'"'+(sel?' selected':'')+'>'+esc(c.id+(c.descripcion?" — "+c.descripcion:""))+'</option>';
  });
  if(mantener && !found){ opts+='<option value="'+esc(mantener)+'" selected>'+esc(mantener)+' (no está en la lista de esta sede)</option>'; }
  ccSel.innerHTML=opts; ccSel.disabled=false;
}

function onSedeChange(){
  var sede = document.getElementById("sede").value;
  var ccSel = document.getElementById("cc");
  if(!sede){
    ccSel.innerHTML='<option value="">— Selecciona sede primero —</option>';
    ccSel.disabled=true;
    return;
  }
  if(!centrosCostosData.length){
    ccSel.innerHTML='<option value="">Cargando...</option>';
    ccSel.disabled=true;
    gsr("getCentrosCostos", null, function(data){
      centrosCostosData = Array.isArray(data) ? data : [];
      poblarFiltrosCC();
      onSedeChange();
    }, function(){
      ccSel.innerHTML='<option value="">— Error —</option>';
    });
    return;
  }
  var filtrados = centrosCostosData.filter(function(c){ return (c.sede||"").toUpperCase() === sede.toUpperCase(); });
  ccSel.innerHTML='<option value="">— Selecciona CC —</option>';
  filtrados.forEach(function(c){
    var lbl = c.id + (c.descripcion ? " — "+c.descripcion : "");
    ccSel.innerHTML+='<option value="'+esc(c.id)+'">'+esc(lbl)+'</option>';
  });
  ccSel.disabled=false;
}

function genID(){
  var d=new Date(),p=function(x){return String(x).padStart(2,"0")};
  document.getElementById("ot_id").value="OT-"+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+"-"+String(Math.floor(Math.random()*9000)+1000);
}

function buscarPosibleDuplicado(empresa, fecha, precio_total){
  var emp = normalizarEmpresa(empresa);
  var fechaD = new Date(fecha);
  var precio = parseFloat(precio_total) || 0;
  if(!emp || isNaN(fechaD.getTime()) || !precio) return [];
  return (allOTs||[]).filter(function(o){
    if(normalizarEmpresa(o.empresa) !== emp) return false;
    var diffDias = Math.abs((new Date(o.fecha) - fechaD) / 86400000);
    if(diffDias > 5) return false;
    var difPct = o.precio_total ? Math.abs(o.precio_total - precio) / o.precio_total : 1;
    return difPct < 0.02;
  });
}

document.getElementById("formOT").addEventListener("submit",function(e){
  e.preventDefault();
  var f=document.getElementById("arch_pdf").files[0];
  OT={ot_id:document.getElementById("ot_id").value.trim(),fecha:document.getElementById("fecha").value,empresa:normalizarEmpresa(document.getElementById("emp").value.trim()),sede:document.getElementById("sede").value.trim(),clasificacion:document.getElementById("clas").value.trim(),precio_total:document.getElementById("ptot").value||"0",centro_costos:document.getElementById("cc").value.trim(),nombre_archivo:f?f.name:""};

  var posibles = buscarPosibleDuplicado(OT.empresa, OT.fecha, OT.precio_total);
  if(posibles.length){
    var lista = posibles.map(function(o){ return "• "+o.ot_id+" — "+o.fecha+" — "+fmtCOP(o.precio_total); }).join("\n");
    if(!confirm("⚠️ Esto se parece a una cotización que ya existe (mismo proveedor, fecha cercana y monto similar):\n\n"+lista+"\n\n¿Seguro que quieres guardarla de todas formas?")) return;
  }

  setB("btnOT","sp1","bOTt",true,"Guardando…");
  var payloadBase = Object.assign({}, OT, {archivo:"", actas:[]});
  gsr("crearOT", payloadBase,
    function(res){
      if(!res||!res.ok){ toast("❌ "+(res?res.msg:"Error"),"err2"); setB("btnOT","sp1","bOTt",false,"Guardar OT y continuar →"); return; }
      toast("✅ OT guardada","ok2");
      if(f){ setB("btnOT","sp1","bOTt",true,"Subiendo PDF…"); subirPDF(f, OT.ot_id, function(){ setB("btnOT","sp1","bOTt",false,"Guardar OT y continuar →"); }); }
      irCot();
      setB("btnOT","sp1","bOTt",false,"Guardar OT y continuar →");
    },
    function(err){ toast("❌ "+err.message,"err2"); setB("btnOT","sp1","bOTt",false,"Guardar OT y continuar →"); }
  );
});

function subirPDF(file, ot_id, onDone){
  var path = ot_id + "/" + Date.now() + "_" + file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
  sb.storage.from("ot-adjuntos").upload(path, file, { upsert: true })
    .then(function(res){
      if(res.error) throw res.error;
      var pub = sb.storage.from("ot-adjuntos").getPublicUrl(path);
      var url = pub.data.publicUrl;
      return sb.from("ordenes_trabajo").update({ archivo_pdf_url: url }).eq("ot_id", ot_id);
    })
    .then(function(res){
      if(res && res.error) throw res.error;
      toast("📄 PDF subido","ok2");
      if(onDone) onDone();
    })
    .catch(function(err){
      toast("❌ Error subiendo PDF: "+err.message,"err2");
      if(onDone) onDone();
    });
}

function irCot(){
  document.getElementById("st1").classList.remove("on");document.getElementById("st1").classList.add("done");
  document.getElementById("st2").classList.add("on");
  goTab(2);
  document.getElementById("pillOT").textContent=OT.ot_id;
  var defs=[{l:"Empresa",v:OT.empresa||"—"},{l:"Sede",v:OT.sede||"—"},{l:"Fecha",v:OT.fecha||"—"},{l:"Clas.",v:OT.clasificacion||"—"},{l:"CC",v:OT.centro_costos||"—"}];
  var gc=document.getElementById("igrid");gc.innerHTML="";
  defs.forEach(function(c){
    gc.innerHTML+='<div style="background:var(--bg-hover);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:0.75rem;"><div style="font-size:0.65rem;text-transform:uppercase;color:var(--text-muted);font-weight:600;">'+c.l+'</div><div style="font-size:0.875rem;font-weight:600;">'+c.v+'</div></div>'
  });
  if(pdfB64){document.getElementById("aimsg").textContent=OT.nombre_archivo;document.getElementById("aist").className="aist rdy";document.getElementById("aist").textContent="PDF OK";}
  else{document.getElementById("aimsg").textContent="Sin PDF adjunto";document.getElementById("aist").className="aist none";document.getElementById("aist").textContent="Sin PDF";}
  document.getElementById("tld").style.display="block";document.getElementById("twrap").style.display="none";
  ubicacionesCache={}; ubicMecanicosCache={};
  cargarUbicMecanicos(OT.sede||"", function(){});
  cargarEquiposSede(OT.sede||"", function(){
  gsr("getItemsOT", OT.ot_id,
    function(items){
      document.getElementById("tld").style.display="none";document.getElementById("twrap").style.display="block";
      if(Array.isArray(items)&&items.length){items.forEach(function(it){addFila(it)});toast("📋 "+items.length+" ítem(s) cargados","ok2")}
      else updEmpty();calcT();
    },
    function(){document.getElementById("tld").style.display="none";document.getElementById("twrap").style.display="block";updEmpty()}
  );
  });
}

var equiposCache = []; 
var ubicacionesCache = {}; 
var ubicMecanicosCache = {}; 

function cargarEquiposSede(sede, cb){
  if(!sede){ equiposCache=[]; if(cb)cb(); return; }
  gsr("getEquiposPorSede", sede, function(data){ equiposCache=Array.isArray(data)?data:[]; if(cb)cb(); }, function(){ equiposCache=[]; if(cb)cb(); });
}
function cargarUbicMecanicos(sede, cb){
  if(!sede){ if(cb)cb([]); return; }
  if(ubicMecanicosCache[sede]){ if(cb)cb(ubicMecanicosCache[sede]); return; }
  gsr("getUbicacionesMecanicos", sede, function(data){ ubicMecanicosCache[sede] = Array.isArray(data)?data:[]; if(cb)cb(ubicMecanicosCache[sede]); }, function(){ if(cb)cb([]); });
}
function cargarUbicaciones(sede, categoria, cb){
  var key = sede+"|"+categoria;
  if(ubicacionesCache[key]){ if(cb)cb(ubicacionesCache[key]); return; }
  gsr("getUbicacionesPorSede", {sede:sede, categoria:categoria}, function(data){ ubicacionesCache[key] = Array.isArray(data)?data:[]; if(cb)cb(ubicacionesCache[key]); }, function(){ if(cb)cb([]); });
}

function buildEquipoOpts(){ return ""; } // obsoleto, se conserva vacío por compatibilidad

function bCO(s){var o='<option value="">— Cat —</option>';Object.keys(catalogo).forEach(function(c){o+='<option value="'+esc(c)+'"'+(s===c?" selected":"")+">"+esc(c)+"</option>"});return o}
function bTO(cat,s){var o='<option value="">— Tipo —</option>';var found=false;if(cat&&catalogo[cat])catalogo[cat].forEach(function(t){if(s===t)found=true;o+='<option value="'+esc(t)+'"'+(s===t?" selected":"")+">"+esc(t)+"</option>"});if(s&&!found){o+='<option value="'+esc(s)+'" selected>'+esc(s)+' (no está en el catálogo)</option>'}return o}
function bLO(s){return labores.map(function(l){return'<option value="'+l+'"'+(s===l?" selected":"")+">"+l+"</option>"}).join("")}

function eqBuscar(inp){
  var q = inp.value.trim().toLowerCase();
  var drop = inp.nextElementSibling;
  var sede = (currentEditOT && currentEditOT.sede) || (OT && OT.sede) || "";
  var lista = equiposCache.filter(function(e){
    if(sede && e.sede !== sede) return false;
    if(!q) return true;
    return (e.codigo||"").toLowerCase().indexOf(q) >= 0 || (e.descripcion||"").toLowerCase().indexOf(q) >= 0;
  }).slice(0, 15);
  if(!lista.length){
    drop.innerHTML = '<div class="eq-drop-item eq-empty">'+(q ? "Sin resultados" : (equiposCache.length ? "Escribe para buscar…" : "No hay equipos cargados para esta sede"))+'</div>';
    drop.style.display = "block"; return;
  }
  drop.innerHTML = lista.map(function(e){
    var inactivo = e.estado && e.estado.toLowerCase().indexOf("baja") >= 0;
    return '<div class="eq-drop-item'+(inactivo?' eq-inactivo':'')+'" data-id="'+esc(e.id)+'" data-cod="'+esc(e.codigo)+'" data-desc="'+esc(e.descripcion)+'" onmousedown="eqElegir(this)">'+
      '<b>'+esc(e.codigo)+'</b> — '+esc(e.descripcion)+(e.ubicacion?' <span style="color:var(--text-muted)">('+esc(e.ubicacion)+')</span>':'')+(inactivo?' <span class="eq-tag">de baja</span>':'')+
      '</div>';
  }).join("");
  drop.style.display = "block";
}
function eqElegir(el){
  var drop = el.parentElement, inp = drop.previousElementSibling;
  inp.value = el.getAttribute("data-cod") + " — " + el.getAttribute("data-desc");
  inp.setAttribute("data-eqid", el.getAttribute("data-id"));
  drop.style.display = "none";
}
function eqCerrar(inp){ setTimeout(function(){ var drop = inp.nextElementSibling; if(drop) drop.style.display = "none"; }, 150); }
function eqLimpiarInput(inp){ inp.value = ""; inp.setAttribute("data-eqid",""); inp.focus(); }
function equipoSearchHTML(item){
  var label = (item.equipo_id && (item.equipo_cod || item.equipo_desc)) ? ((item.equipo_cod?item.equipo_cod+" — ":"")+(item.equipo_desc||"")) : "";
  return '<div class="eq-wrap">'+
    '<input class="ci eq-search" type="text" placeholder="Buscar equipo (opcional)…" autocomplete="off" '+
      'value="'+esc(label)+'" data-eqid="'+esc(item.equipo_id||"")+'" '+
      'oninput="eqBuscar(this)" onfocus="eqBuscar(this)" onblur="eqCerrar(this)">'+
    '<div class="eq-drop"></div></div>';
}
function getEquipoSelData(tr){
  var inp = tr.querySelector(".eq-search");
  if(!inp) return { equipo_id:"", codigo:"", descripcion:"" };
  var val = String(inp.value||"").trim();
  var cod = "", desc = "";
  if(val.indexOf(" — ") >= 0){ var parts = val.split(" — "); cod = parts[0].trim(); desc = parts.slice(1).join(" — ").trim(); }
  return { equipo_id: inp.getAttribute("data-eqid") || "", codigo: cod, descripcion: desc };
}

function addFila(item,tbody){
  item=item||{};tbody=tbody||document.getElementById("tbody");
  var n=tbody.children.length+1;
  var tr=document.createElement("div"); tr.className="item-card";
  var ubicHtml='<input class="ci ubic-in" value="'+esc(item.ubicacion||"")+'" placeholder="Ubicación" onchange="onUbicChange(this)">';
  tr.innerHTML=
    '<div class="item-card-head"><span class="item-card-num">Ítem #'+n+'</span><button class="btn brd" style="padding:4px 10px;font-size:0.75rem;" onclick="delF(this)">✕ Quitar</button></div>'+
    '<div class="item-card-grid">'+
      '<div class="fd"><label>Categoría</label><select class="ci csel" onchange="onCC(this,false)">'+bCO(item.categoria)+'</select></div>'+
      '<div class="fd"><label>Tipo</label><select class="ci tsel">'+bTO(item.categoria,item.tipo)+'</select></div>'+
      '<div class="fd"><label>Labor</label><select class="ci">'+bLO(item.labor)+'</select></div>'+
      '<div class="fd"><label>Ubicación</label><div class="ubic-td">'+ubicHtml+'</div></div>'+
      '<div class="fd full"><label>Descripción</label><input class="ci" data-rol="desc" value="'+esc(item.descripcion||"")+'" placeholder="Descripción del trabajo"></div>'+
      '<div class="fd full"><label>Equipo (opcional)</label>'+equipoSearchHTML(item)+'</div>'+
      '<div class="fd"><label>Cantidad</label><input class="ci mn" data-rol="cant" value="'+(item.cantidad||"")+'" type="number" min="0" step="0.01" oninput="calcT()"></div>'+
      '<div class="fd"><label>Precio unitario</label><input class="ci mn" data-rol="prec" value="'+(item.precio||"")+'" type="number" min="0" step="0.01" oninput="calcT()"></div>'+
    '</div>'+
    '<div class="item-card-total">Total línea: <span data-tl>$ 0.00</span></div>';
  tbody.appendChild(tr);updEmpty();updCnt();calcT();
  if(item.categoria && (item.categoria.toLowerCase().indexOf("invernadero")>=0 || item.categoria.toLowerCase().indexOf("mec")>=0)){
    actualizarUbicCell(tr, item.categoria||"", item.ubicacion||"", false);
  }
}
function onCC(sel,dp){
  var tr=sel.closest(".item-card"), cat=sel.value;
  tr.querySelector(".tsel").innerHTML=bTO(cat,"");
  actualizarUbicCell(tr, cat, "", dp);
  if(dp)dpCalcT();else calcT();
}
function actualizarUbicCell(tr, cat, selVal, dp){
  var sede = (currentEditOT&&currentEditOT.sede)||(OT&&OT.sede)||"";
  var td = tr.querySelector(".ubic-td"); if(!td) return;
  var esInv = cat && cat.toLowerCase().indexOf("invernadero") >= 0;
  var esMec = cat && cat.toLowerCase().indexOf("mec") >= 0;

  function renderUbic(lista, placeholder){
    if(lista && lista.length){
      var opts='<option value="">'+esc(placeholder)+'</option>';
      var found=false;
      lista.forEach(function(u){ if(u===selVal)found=true; opts+='<option value="'+esc(u)+'"'+(u===selVal?' selected':'')+'>'+esc(u)+'</option>'; });
      if(selVal && !found){ opts += '<option value="'+esc(selVal)+'" selected>'+esc(selVal)+' (no registrada)</option>'; }
      td.innerHTML='<select class="ci ubic-sel" onchange="onUbicChange(this)">'+opts+'</select>';
    } else {
      td.innerHTML='<input class="ci ubic-in" value="'+esc(selVal)+'" placeholder="Ubicación" onchange="onUbicChange(this)">';
    }
    if(dp) dpCalcT(); else calcT();
  }
  if(esInv){ cargarUbicaciones(sede, cat, function(lista){ renderUbic(lista, "— Bloque —"); }); }
  else if(esMec){ cargarUbicMecanicos(sede, function(lista){ renderUbic(lista, "— Ubicación —"); }); }
  else {
    td.innerHTML='<input class="ci ubic-in" value="'+esc(selVal)+'" placeholder="Ubicación" onchange="onUbicChange(this)">';
    if(dp) dpCalcT(); else calcT();
  }
}
function onUbicChange(){ /* la búsqueda de equipo ya no depende de la ubicación seleccionada */ }
function getUbicVal(tr){ var s=tr.querySelector(".ubic-sel"); if(s) return s.value; var i=tr.querySelector(".ubic-in"); return i?i.value:""; }
function delF(btn){btn.closest(".item-card").remove();updEmpty();updCnt();calcT()}
function clearT(){if(!confirm("¿Limpiar todo?"))return;document.getElementById("tbody").innerHTML="";updEmpty();updCnt();calcT()}
function updEmpty(){document.getElementById("tempty").style.display=document.getElementById("tbody").children.length===0?"block":"none"}
function updCnt(){document.getElementById("nit").textContent=document.getElementById("tbody").children.length}
function calcT(){
  var rows=document.querySelectorAll("#tbody .item-card"),sub=0;
  var fmt2=function(n){return"$ "+n.toLocaleString("es-CO",{minimumFractionDigits:2,maximumFractionDigits:2})};
  rows.forEach(function(r){
    var cant=r.querySelector("[data-rol='cant']"), prec=r.querySelector("[data-rol='prec']");
    var c=parseFloat(cant?cant.value:0)||0, p=parseFloat(prec?prec.value:0)||0, ln=c*p;
    sub+=ln;
    var tl=r.querySelector("[data-tl]"); if(tl)tl.textContent=fmt2(ln);
  });
  if(document.getElementById("svl"))document.getElementById("svl").textContent=fmt2(sub);
  if(document.getElementById("tvl"))document.getElementById("tvl").textContent=fmt2(sub);
}

function guardarDet(){
  var rows=document.querySelectorAll("#tbody .item-card");
  if(!rows.length){toast("⚠️ Agrega al menos un ítem","err2");return}
  var items=[];
  rows.forEach(function(r){
    var descI=r.querySelector("[data-rol='desc']"), catS2=r.querySelector(".csel"), tipS2=r.querySelector(".tsel"), labS2=r.querySelectorAll("select")[2];
    var eqData=getEquipoSelData(r);
    items.push({ot_id:OT.ot_id, categoria:catS2?catS2.value:"", tipo:tipS2?tipS2.value:"", labor:labS2?labS2.value:"", descripcion:descI?descI.value.trim():"", ubicacion:getUbicVal(r).trim(), cantidad:(r.querySelector("[data-rol='cant']")||{value:"0"}).value||"0", precio:(r.querySelector("[data-rol='prec']")||{value:"0"}).value||"0", equipo_id:eqData.equipo_id, equipo_cod:eqData.codigo, equipo_desc:eqData.descripcion, sede:OT.sede||"", empresa:OT.empresa||"", centro_costos:OT.centro_costos||"", fecha_ot:OT.fecha||""});
  });
  setB("bSD","sp2","bDt",true,"Guardando…");
  gsr("saveDetalle",{items:items,ot_id:OT.ot_id},
    function(res){if(!res||!res.ok){toast("❌ Error","err2")}else{toast("✅ Cotización guardada","ok2");cargarRegs();cargarAnalitica()}setB("bSD","sp2","bDt",false,"💾 Guardar Cotización")},
    function(err){toast("❌ "+err.message,"err2");setB("bSD","sp2","bDt",false,"💾 Guardar Cotización")}
  );
}
function volverOT(){
  if(!confirm("¿Deseas volver y descartar los cambios actuales?"))return;
  document.getElementById("st1").classList.add("on");document.getElementById("st1").classList.remove("done");document.getElementById("st2").classList.remove("on");
  document.getElementById("formOT").reset();document.getElementById("dn1").style.display="none";document.getElementById("dn2").style.display="none";
  document.getElementById("actasList").innerHTML="";document.getElementById("fecha").value=new Date().toISOString().split("T")[0];
  document.getElementById("cc").innerHTML='<option value="">— Selecciona sede primero —</option>'; document.getElementById("cc").disabled=true;
  document.getElementById("tbody").innerHTML="";document.getElementById("igrid").innerHTML="";
  pdfB64="";OT={};actasFiles=[];updEmpty();updCnt();calcT();goTab(1);
}

function cargarRegs(){
  document.getElementById("regLd").style.display="block";document.getElementById("regWrap").style.display="none";
  gsr("getOTs",null,
    function(data){
      allOTs=Array.isArray(data)?data:[]; filtOTs=allOTs.slice(); pgOTs=1;
      document.getElementById("regLd").style.display="none"; document.getElementById("regWrap").style.display="block";
      var clasEl=document.getElementById("rfClas");
      if(clasEl){
        var clases=[]; allOTs.forEach(function(o){ if(o.clasificacion&&clases.indexOf(o.clasificacion)<0) clases.push(o.clasificacion); });
        clases.sort(); clasEl.innerHTML='<option value="">Todas las clas.</option>';
        clases.forEach(function(c){ clasEl.innerHTML+='<option value="'+esc(c)+'">'+esc(c)+'</option>'; });
      }
      poblarCatFiltro(); renderTablaOTs();
    },
    function(){document.getElementById("regLd").style.display="none";document.getElementById("regWrap").style.display="block";toast("❌ Error al cargar","err2")}
  );
}

function poblarCatFiltro(){
  var catEl = document.getElementById("rfCat"); if(!catEl || !costoData.length) return;
  var cats = []; costoData.forEach(function(c){ if(c.categoria && cats.indexOf(c.categoria)<0) cats.push(c.categoria); }); cats.sort();
  var cur = catEl.value; catEl.innerHTML='<option value="">Categorías</option>';
  cats.forEach(function(c){ catEl.innerHTML+='<option value="'+esc(c)+'"'+(c===cur?' selected':'')+'>'+esc(c)+'</option>'; });
}

function filtrarRegs(){
  var emp=(document.getElementById("rfEmp").value||"").toLowerCase(), sede=(document.getElementById("rfSede")||{value:""}).value.toUpperCase(), est=document.getElementById("rfEst").value, clas=(document.getElementById("rfClas")||{value:""}).value, cat=(document.getElementById("rfCat")||{value:""}).value, cc=(document.getElementById("rfCC")||{value:""}).value.toLowerCase(), mes=document.getElementById("rfMes").value;
  var otsCat = {}; if(cat){ costoData.forEach(function(c){ if((c.categoria||"") === cat) otsCat[c.ot_id] = true; }); }
  filtOTs = allOTs.filter(function(o){
    if(emp && !(o.empresa||"").toLowerCase().includes(emp)) return false;
    if(sede && (o.sede||"").toUpperCase() !== sede) return false;
    if(est && o.estado !== est) return false;
    if(clas && (o.clasificacion||"") !== clas) return false;
    if(cat && !otsCat[o.ot_id]) return false;
    if(cc && !(o.centro_costos||"").toLowerCase().includes(cc)) return false;
    if(mes && !(o.fecha||"").startsWith(mes)) return false;
    return true;
  });
  pgOTs=1; renderTablaOTs();
  var cnt = document.getElementById("regCount"); if(cnt) cnt.textContent = filtOTs.length+" OTs filtradas";
}

function limpiarFiltrosRegs(){ ["rfEmp","rfSede","rfEst","rfClas","rfCat","rfCC","rfMes"].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=""; }); filtrarRegs(); }

function renderTablaOTs(){
  var tbody=document.getElementById("tbodyOTs");tbody.innerHTML="";
  var total=filtOTs.length;document.getElementById("regCount").textContent=total+" OT(s)";
  var start=(pgOTs-1)*pgSz,end=Math.min(start+pgSz,total),page=filtOTs.slice(start,end);
  if(!page.length){document.getElementById("emptyOTs").style.display="block"}
  else{
    document.getElementById("emptyOTs").style.display="none";
    page.forEach(function(o){
      var tr=document.createElement("tr"); var oid=esc(o.ot_id||"");
      tr.innerHTML=
        '<td class="mono" style="font-weight:600">'+oid+'</td>'+
        '<td>'+esc(o.fecha||"")+'</td>'+
        '<td style="font-weight:500">'+esc(o.empresa||"")+'</td>'+
        '<td><span style="font-size:0.75rem; color:var(--text-muted);">'+esc(o.sede||"")+'</span></td>'+
        '<td>'+esc(o.clasificacion||"")+'</td>'+
        '<td class="r" style="color:var(--text-main); font-weight:600;">'+fmtCOP(o.precio_total)+'</td>'+
        '<td class="mono" style="font-size:0.75rem;">'+esc(o.centro_costos||"")+'</td>'+
        '<td>'+mkEstadoSw(o.ot_id, o.estado)+'</td>'+
        '<td style="text-align:center">'+(o.actas_count>0?"📎":"—")+'</td>'+
        '<td style="text-align:center"><div style="display:flex;gap:0.25rem;justify-content:center"><button class="btn bwn" style="padding:4px 8px;font-size:0.75rem;" onclick="abrirDetalle(\''+oid+'\')">✏ Editar</button><button class="btn brd" style="padding:4px 8px;font-size:0.75rem;" onclick="eliminarOT(\''+oid+'\')">🗑</button></div></td>';
      tbody.appendChild(tr);
    });
  }
  var pages=Math.max(1,Math.ceil(total/pgSz));
  document.getElementById("pgInfo").textContent="Mostrando "+(start+1)+"–"+end+" de "+total;
  var pb=document.getElementById("pgBtns");pb.innerHTML="";
  function addPB(lbl,pg,dis,act){var b=document.createElement("button");b.className="pbtn"+(act?" on":"");b.textContent=lbl;b.disabled=dis;b.onclick=function(){pgOTs=pg;renderTablaOTs()};pb.appendChild(b)}
  addPB("‹",pgOTs-1,pgOTs<=1,false);
  var lo=Math.max(1,pgOTs-2),hi=Math.min(pages,pgOTs+2);
  for(var p=lo;p<=hi;p++)addPB(p,p,false,p===pgOTs);
  addPB("›",pgOTs+1,pgOTs>=pages,false);
}

function mkEstadoSw(ot_id, estado){
  var cls = estado==="CERRADO"?"cerr":estado==="EN PROCESO"?"proc":"pend";
  var id  = esc(ot_id||"");
  return '<div class="estado-sw '+cls+'" data-otid="'+id+'"><span>PEND</span><span>PROC</span><span>CERR</span></div>';
}

function nextEstado(ot_id){
  var ot = allOTs.find(function(o){ return o.ot_id === ot_id; }); if(!ot) return;
  var estados = ["PENDIENTE","EN PROCESO","CERRADO"];
  var idx = estados.indexOf(ot.estado);
  var next = estados[(idx+1) % estados.length];
  ot.estado = next; renderTablaOTs();
  var datos = { ot_id_original: ot_id, ot_id: ot.ot_id, fecha: ot.fecha, empresa: ot.empresa, sede: ot.sede, clasificacion: ot.clasificacion, precio_total: ot.precio_total, centro_costos: ot.centro_costos, estado: next, observaciones: ot.observaciones||"" };
  gsr("saveEditarOT", datos,
    function(res){
      if(!res||!res.ok){ ot.estado = estados[idx]; renderTablaOTs(); toast("❌ Error al cambiar estado","err2"); } 
      else { toast("✅ Estado → "+next,"ok2"); cargarAnalitica(); }
    },
    function(err){ ot.estado = estados[idx]; renderTablaOTs(); toast("❌ "+err.message,"err2"); }
  );
}

function eliminarOT(ot_id){
  if(!confirm("¿Eliminar la OT \""+ot_id+"\" y todos sus ítems de forma permanente?")) return;
  gsr("deleteOT", ot_id, function(res){
      if(!res||!res.ok){ toast("❌ Error al eliminar","err2"); return; }
      toast("🗑 OT eliminada","ok2"); cargarRegs(); cargarAnalitica();
    }, function(err){ toast("❌ "+err.message,"err2"); }
  );
}

function abrirDetalle(ot_id){
  var ot=allOTs.find(function(o){return o.ot_id===ot_id});if(!ot)return;
  currentEditOT=JSON.parse(JSON.stringify(ot));
  document.getElementById("dpPill").textContent=ot_id;
  document.getElementById("de_otid").value=ot.ot_id||"";document.getElementById("de_fecha").value=ot.fecha||"";
  document.getElementById("de_emp").value=ot.empresa||"";
  var deSede=document.getElementById("de_sede"); deSede.value=ot.sede||"";
  document.getElementById("de_clas").value=ot.clasificacion||"";
  onDeSedeChange(ot.centro_costos||"");
  document.getElementById("de_ptot").value=ot.precio_total||"";document.getElementById("de_est").value=ot.estado||"PENDIENTE";
  document.getElementById("de_obs").value=ot.observaciones||"";
  var lnk=document.getElementById("de_link");lnk.href=ot.archivo_pdf||"#";lnk.textContent=ot.archivo_pdf?"Abrir documento PDF":"No hay archivo adjunto";
  var ac=document.getElementById("dpActas");
  if(ot.actas&&ot.actas.length){
    ac.className="";ac.innerHTML="";
    ot.actas.forEach(function(a){ac.innerHTML+='<div style="display:flex;align-items:center;gap:0.5rem;background:var(--bg-hover);padding:0.5rem;border-radius:var(--radius-sm);margin-bottom:0.25rem;border:1px solid var(--border-color);"><span style="font-size:1rem;">'+fIco(a.nombre)+'</span><span style="flex:1;font-size:0.75rem;font-family:var(--font-mono)">'+esc(a.nombre)+'</span><a href="'+esc(a.url)+'" target="_blank" class="btn bgh" style="font-size:0.75rem;padding:4px 8px;">Ver</a></div>'})
  } else {ac.className="lst-st";ac.textContent="Sin actas adjuntas"}
  if(ot.sede) cargarEquiposSede(ot.sede, function(){});
  dpTab(1);document.getElementById("detOv").classList.add("open");
}

function dpTab(n){ [1,2,3].forEach(function(i){document.getElementById("dp"+i).style.display=i===n?"block":"none";document.getElementById("pt"+i).classList.toggle("on",i===n)}); if(n===2) cargarCotDP(); }

function cargarCotDP(){
  if(!currentEditOT)return;
  document.getElementById("dp2ld").style.display="block"; document.getElementById("dp2wr").style.display="none";
  var sede = currentEditOT.sede || "";
  cargarUbicMecanicos(sede, function(){});
  cargarEquiposSede(sede, function(){
    gsr("getItemsOT", currentEditOT.ot_id,
      function(items){
        document.getElementById("dp2ld").style.display="none"; document.getElementById("dp2wr").style.display="block";
        var tbody=document.getElementById("dpTbody"); tbody.innerHTML="";
        if(Array.isArray(items)) items.forEach(function(it){ dpAddFila(it); });
        dpCalcT();
      }, function(){ document.getElementById("dp2ld").style.display="none"; document.getElementById("dp2wr").style.display="block"; }
    );
  });
}

function dpAddFila(item){
  item=item||{}; var tbody=document.getElementById("dpTbody");
  var n=tbody.children.length+1;
  var tr=document.createElement("div"); tr.className="item-card";
  var ubicHtmlDp='<input class="dp-fi ubic-in" value="'+esc(item.ubicacion||"")+'" onchange="onUbicChange(this)">';
  tr.innerHTML=
    '<div class="item-card-head"><span class="item-card-num">Ítem #'+n+'</span><button class="btn brd" style="padding:4px 10px;font-size:0.75rem;" onclick="dpDelF(this)">✕ Quitar</button></div>'+
    '<div class="item-card-grid">'+
      '<div class="fd"><label>Categoría</label><select class="dp-fi csel" onchange="onCC(this,true)">'+bCO(item.categoria)+'</select></div>'+
      '<div class="fd"><label>Tipo</label><select class="dp-fi tsel">'+bTO(item.categoria,item.tipo)+'</select></div>'+
      '<div class="fd"><label>Labor</label><select class="dp-fi">'+bLO(item.labor)+'</select></div>'+
      '<div class="fd"><label>Ubicación</label><div class="ubic-td">'+ubicHtmlDp+'</div></div>'+
      '<div class="fd full"><label>Descripción</label><input class="dp-fi" data-rol="desc" value="'+esc(item.descripcion||"")+'"></div>'+
      '<div class="fd full"><label>Equipo (opcional)</label>'+equipoSearchHTML(item)+'</div>'+
      '<div class="fd"><label>Cantidad</label><input class="dp-fi mn" data-rol="cant" value="'+(item.cantidad||"")+'" type="number" step="0.01" oninput="dpCalcT()"></div>'+
      '<div class="fd"><label>Precio unitario</label><input class="dp-fi mn" data-rol="prec" value="'+(item.precio||"")+'" type="number" step="0.01" oninput="dpCalcT()"></div>'+
    '</div>'+
    '<div class="item-card-total">Total línea: <span data-tl>$ 0.00</span></div>';
  tbody.appendChild(tr);dpCalcT();
  if(item.categoria && (item.categoria.toLowerCase().indexOf("invernadero")>=0 || item.categoria.toLowerCase().indexOf("mec")>=0)){ actualizarUbicCell(tr, item.categoria||"", item.ubicacion||"", true); }
}
function dpDelF(btn){btn.closest(".item-card").remove();dpCalcT()}
function dpCalcT(){
  var rows=document.querySelectorAll("#dpTbody .item-card"),sub=0;
  var fmt2=function(n){return"$ "+n.toLocaleString("es-CO",{minimumFractionDigits:2,maximumFractionDigits:2})};
  rows.forEach(function(r){
    var cant=r.querySelector("[data-rol='cant']"), prec=r.querySelector("[data-rol='prec']");
    var c=parseFloat(cant?cant.value:0)||0, p=parseFloat(prec?prec.value:0)||0, ln=c*p; sub+=ln;
    var tl=r.querySelector("[data-tl]"); if(tl)tl.textContent=fmt2(ln);
  });
  var el=document.getElementById("dpTot"); if(el)el.textContent=fmt2(sub);
}

function guardarEdicion(){
  if(!currentEditOT)return;
  var ot_id=document.getElementById("de_otid").value.trim();
  var datos={ot_id_original:currentEditOT.ot_id,ot_id:ot_id,fecha:document.getElementById("de_fecha").value,empresa:document.getElementById("de_emp").value.trim(),sede:document.getElementById("de_sede").value.trim(),clasificacion:document.getElementById("de_clas").value.trim(),precio_total:document.getElementById("de_ptot").value||"0",centro_costos:document.getElementById("de_cc").value.trim(),estado:document.getElementById("de_est").value,observaciones:document.getElementById("de_obs").value.trim()};
  var dpRows=document.querySelectorAll("#dpTbody .item-card"),items=[];
  dpRows.forEach(function(r){
    var descI=r.querySelector("[data-rol='desc']"), catS=r.querySelector(".csel"), tipS=r.querySelector(".tsel"), labS=r.querySelectorAll("select")[2];
    var eqData=getEquipoSelData(r);
    items.push({ot_id:ot_id, categoria:catS?catS.value:"", tipo:tipS?tipS.value:"", labor:labS?labS.value:"", descripcion:descI?descI.value.trim():"", ubicacion:getUbicVal(r).trim(), cantidad:(r.querySelector("[data-rol='cant']")||{value:"0"}).value||"0", precio:(r.querySelector("[data-rol='prec']")||{value:"0"}).value||"0", equipo_id:eqData.equipo_id, equipo_cod:eqData.codigo, equipo_desc:eqData.descripcion, sede:currentEditOT?currentEditOT.sede:"", centro_costos:currentEditOT?currentEditOT.centro_costos:"", empresa:currentEditOT?currentEditOT.empresa:"", fecha_ot:currentEditOT?currentEditOT.fecha:""})
  });
  setB("btnSE","sp3","bSEt",true,"Guardando…");
  gsr("saveEditarOT",datos,
    function(res){
      if(items.length){gsr("saveDetalle",{items:items,ot_id:ot_id},function(){toast("✅ Guardado","ok2");closeDetail();cargarRegs();cargarAnalitica();setB("btnSE","sp3","bSEt",false,"💾 Guardar Cambios")},function(err){toast("❌ "+err.message,"err2");setB("btnSE","sp3","bSEt",false,"💾 Guardar Cambios")})}
      else{toast("✅ OT actualizada","ok2");closeDetail();cargarRegs();setB("btnSE","sp3","bSEt",false,"💾 Guardar Cambios")}
    }, function(err){toast("❌ "+err.message,"err2");setB("btnSE","sp3","bSEt",false,"💾 Guardar Cambios")}
  );
}
function closeDetail(){document.getElementById("detOv").classList.remove("open");currentEditOT=null;document.getElementById("dpTbody").innerHTML=""}

// ═══ ANALÍTICA / DASHBOARD SCRIPT ════════════════
var M2 = { "OLAS": 325000, "MANANTIALES": 160000 };
var sedeActiva = "", catActiva = "", invTipoActivo = "";
var atabActivo = 1;

function setSede(sede){
  sedeActiva = sede;
  ["anSedeTodo","anSedeOlas","anSedeMant"].forEach(function(id){ var b=document.getElementById(id); if(b) b.classList.remove("on"); });
  var btnId = sede===""?"anSedeTodo":sede==="OLAS"?"anSedeOlas":"anSedeMant";
  var btn=document.getElementById(btnId); if(btn) btn.classList.add("on");
  renderDashboard();
}
function setInvTipo(tipo){
  invTipoActivo = tipo;
  ["invTipo0","invTipo1","invTipo2","invTipo3"].forEach(function(id){ var b=document.getElementById(id); if(b) b.classList.remove("on"); });
  var idx = tipo===""?"0":tipo==="cambio"?"1":tipo==="lavado"?"2":"3";
  var btn=document.getElementById("invTipo"+idx); if(btn) btn.classList.add("on");
  renderDashboard();
}
function onCatChange(){
  catActiva = (document.getElementById("anCat")||{value:""}).value;
  var invF = document.getElementById("invTipoFiltro");
  if(invF) invF.style.display = catActiva.toLowerCase().indexOf("invernadero")>=0?"block":"none";
  renderDashboard();
}
function goAtab(n){
  [1,2,3].forEach(function(i){
    document.getElementById("as"+i).style.display = i===n?"block":"none";
    var btn = document.getElementById("at"+i); if(btn) btn.classList.toggle("on", i===n);
  });
  atabActivo = n;
  if(n===1 && (otData.length||costoData.length)) setTimeout(renderCharts,80);
  if(n===2){ cargarInvernaderos(); cargarCostosInv(); }
  if(n===3) cargarEquiposAnalitica();
}

function cargarAnalitica(){
  gsr("getAnalitica",null,function(data){
    otData=data.ots||[];costoData=data.costos||[];
    poblarFiltros(); renderDashboard(); poblarCatFiltro();
  },function(){});
}

function poblarFiltros(){
  var nomMes=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  var anios=uniq(otData.map(function(o){return(o.fecha||"").substring(0,4)}).filter(Boolean)).sort().reverse();
  var emps =uniq(otData.map(function(o){return o.empresa}).filter(Boolean)).sort();
  var cats =uniq(costoData.map(function(c){return c.categoria}).filter(Boolean)).sort();
  var sa=document.getElementById("afAnio"); if(sa){sa.innerHTML='<option value="">Año</option>';anios.forEach(function(a){sa.innerHTML+='<option>'+a+'</option>';});}
  var sm=document.getElementById("afMes"); if(sm){sm.innerHTML='<option value="">Mes</option>'; ["01","02","03","04","05","06","07","08","09","10","11","12"].forEach(function(m,i){ sm.innerHTML+='<option value="'+m+'">'+nomMes[i]+'</option>'; }); }
  var se=document.getElementById("afEmp"); if(se){se.innerHTML='<option value="">Empresa</option>';emps.forEach(function(e){se.innerHTML+='<option>'+e+'</option>';});}
  var ac=document.getElementById("anCat"); if(ac){ var cur=ac.value; ac.innerHTML='<option value="">📊 Categoría</option>'; cats.forEach(function(c){ac.innerHTML+='<option value="'+esc(c)+'">'+esc(c)+'</option>';}); if(cur) ac.value=cur; }
  poblarFiltrosCC();
}

function getDatos(){
  var anio=(document.getElementById("afAnio")||{value:""}).value, mes=(document.getElementById("afMes")||{value:""}).value, emp=(document.getElementById("afEmp")||{value:""}).value, estOT=(document.getElementById("afEstOT")||{value:""}).value;
  var ots2=otData.filter(function(o){
    if(sedeActiva && (o.sede||"").toUpperCase()!==sedeActiva) return false;
    if(anio && !(o.fecha||"").startsWith(anio)) return false;
    if(mes && (o.fecha||"").substring(5,7)!==mes) return false;
    if(emp && o.empresa!==emp) return false;
    if(estOT && o.estado!==estOT) return false;
    return true;
  });
  var ids=new Set(ots2.map(function(o){return o.ot_id;}));
  var cos2=costoData.filter(function(c){
    if(!ids.has(c.ot_id)) return false;
    if(catActiva && c.categoria!==catActiva) return false;
    if(invTipoActivo){
      var t=(c.tipo||"").toLowerCase();
      if(invTipoActivo==="cambio" && !t.includes("cambio")) return false;
      if(invTipoActivo==="lavado" && !t.includes("lavado")) return false;
      if(invTipoActivo==="otros" && (t.includes("cambio")||t.includes("lavado"))) return false;
    }
    return true;
  });
  return {ots:ots2, costos:cos2};
}

function renderDashboard(){
  var d = getDatos();
  var cat = catActiva.toLowerCase(), esInv = cat.indexOf("invernadero")>=0, esMec = cat.indexOf("mec")>=0, esTodas = catActiva==="";
  
  var secTodas = document.getElementById("secTodas"), secMec = document.getElementById("secMecanicos"), secInv = document.getElementById("secInvernaderos"), secRV = document.getElementById("secRadarVol"), sedesP = document.getElementById("sedesPanel");
  if(secTodas) secTodas.style.display = esTodas?"block":"none";
  if(secMec) secMec.style.display = esMec?"block":"none";
  if(secInv) secInv.style.display = esInv?"block":"none";
  if(secRV) secRV.style.display = esTodas?"block":"none";
  if(sedesP) sedesP.style.display = (sedeActiva===""&&esTodas)?"block":"none";

  renderKPIs(d.ots, d.costos); renderM2Panel(d.costos);
  chMes(d.costos); chEmp(d.ots, d.costos);

  if(esTodas){ chSedes(); chCat(d.costos); chTipo(d.costos); chEst(d.ots); chLab(d.costos); chTop(d.ots, d.costos); chRadar(d.costos); chVol(d.ots); }
  if(esMec) renderSecMecanicos(d.costos);
  if(esInv) renderSecInvernaderos(d.costos);

  renderChCC(); renderPresupInversion();
}
function renderCharts(){ renderDashboard(); }

function renderKPIs(ots,cos){
  var tot=cos.reduce(function(a,c){return a+(parseFloat(c.total_linea)||0)},0);
  var pend=ots.filter(function(o){return o.estado==="PENDIENTE"}).length;
  var proc=ots.filter(function(o){return o.estado==="EN PROCESO"}).length;
  var cerr=ots.filter(function(o){return o.estado==="CERRADO"}).length;
  var pm=ots.length?tot/ots.length:0;
  var porMes={};cos.forEach(function(c){var m=(c.fecha||"").substring(0,7);if(m)porMes[m]=(porMes[m]||0)+(parseFloat(c.total_linea)||0);});
  var mc=Object.keys(porMes).sort(function(a,b){return porMes[b]-porMes[a]})[0]||"—";
  var ctop={};cos.forEach(function(c){if(c.categoria)ctop[c.categoria]=(ctop[c.categoria]||0)+(parseFloat(c.total_linea)||0);});
  var cm=Object.keys(ctop).sort(function(a,b){return ctop[b]-ctop[a]})[0]||"—";

  var m2Sede = sedeActiva ? (M2[sedeActiva]||1) : (M2["OLAS"]+M2["MANANTIALES"]);
  var costoM2 = tot/m2Sede;

  var kpis=[
    {ico:"💰",val:fmtCOP(tot),lbl:"Gasto Total",sub:ots.length+" órdenes",cls:"blue"},
    {ico:"📐",val:fmtCOP(Math.round(costoM2)),lbl:"Costo/m²",sub:sedeActiva||(catActiva||"Todas"),cls:"cyan"},
    {ico:"⏳",val:pend,lbl:"Pendientes",sub:"Por ejecutar",cls:"warn"},
    {ico:"🔄",val:proc,lbl:"En Proceso",sub:"En ejecución",cls:"purple"},
    {ico:"✅",val:cerr,lbl:"Cerradas",sub:"Completadas",cls:"green"},
    {ico:"📊",val:fmtCOP(pm),lbl:"Ticket Promedio",sub:"Por OT",cls:"pink"},
    {ico:"📅",val:mc,lbl:"Mes Peak",sub:porMes[mc]?fmtCOP(porMes[mc]):"—",cls:"orange"},
    {ico:"🏷",val:cm,lbl:"Top Categoría",sub:ctop[cm]?fmtCOP(ctop[cm]):"—",cls:"blue"}
  ];
  var el=document.getElementById("kpiGrid");
  if(el){el.innerHTML="";kpis.forEach(function(k){el.innerHTML+='<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div><div class="kpi-sub">'+k.sub+'</div></div>';});}
}

function renderM2Panel(costos){
  var panel=document.getElementById("m2Panel"); if(!panel) return;
  if(!sedeActiva){ panel.style.display="none"; return; }
  panel.style.display="block";
  var m2=M2[sedeActiva]||1, tot=costos.reduce(function(a,c){return a+(parseFloat(c.total_linea)||0)},0), byCat={};
  costos.forEach(function(c){if(c.categoria)byCat[c.categoria]=(byCat[c.categoria]||0)+(parseFloat(c.total_linea)||0);});
  document.getElementById("m2Sub").textContent=sedeActiva+" · "+m2.toLocaleString("es-CO")+" m²";
  var grid=document.getElementById("m2Grid"); if(!grid) return;
  grid.innerHTML='<div class="kpi blue"><div class="kpi-ico">📐</div><div class="kpi-val">'+fmtCOP(Math.round(tot/m2))+'</div><div class="kpi-lbl">Costo/m² Total</div><div class="kpi-sub">'+fmtCOP(tot)+'</div></div>';
  var cls=["green","warn","purple","cyan","pink","orange"];
  Object.keys(byCat).sort().forEach(function(cat,i){
    var t=byCat[cat],cm2=t/m2;
    grid.innerHTML+='<div class="kpi '+cls[i%6]+'"><div class="kpi-ico">📐</div><div class="kpi-val">'+fmtCOP(Math.round(cm2))+'</div><div class="kpi-lbl">'+esc(cat)+'</div><div class="kpi-sub">'+fmtCOP(t)+'</div></div>';
  });
}

function renderSecMecanicos(costos){
  var isLight=!document.body.classList.contains("dark"), tc=isLight?"#64748b":"#94a3b8", gc=isLight?"#e2e8f0":"#334155";
  var mapa={};
  costos.forEach(function(c){
    var key = c.equipo_cod?(c.equipo_cod+(c.equipo_desc?" — "+c.equipo_desc:"")):(c.descripcion||"Sin equipo");
    if(!key.trim()) return;
    if(!mapa[key]) mapa[key]={costo:0,count:0};
    mapa[key].costo+=parseFloat(c.total_linea)||0; mapa[key].count+=1;
  });
  var sorted=Object.keys(mapa).sort(function(a,b){return mapa[b].costo-mapa[a].costo}).slice(0,15);
  if(charts["chEqCostoG"]) charts["chEqCostoG"].destroy();
  var ctx1=document.getElementById("chEqCostoG");
  if(ctx1) charts["chEqCostoG"]=new Chart(ctx1,{type:"bar",data:{labels:sorted,datasets:[{data:sorted.map(function(k){return mapa[k].costo}),backgroundColor:CL,borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{color:tc,callback:function(v){return fmtK(v)}}},y:{ticks:{color:tc}}}}});
  var sortedC=Object.keys(mapa).sort(function(a,b){return mapa[b].count-mapa[a].count}).slice(0,15);
  if(charts["chEqCountG"]) charts["chEqCountG"].destroy();
  var ctx2=document.getElementById("chEqCountG");
  if(ctx2) charts["chEqCountG"]=new Chart(ctx2,{type:"bar",data:{labels:sortedC,datasets:[{data:sortedC.map(function(k){return mapa[k].count;}),backgroundColor:CL.slice().reverse(),borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{color:tc,stepSize:1}},y:{ticks:{color:tc}}}}});
}

function renderSecInvernaderos(costos){
  var isLight=!document.body.classList.contains("dark"), tc=isLight?"#64748b":"#94a3b8", gc=isLight?"#e2e8f0":"#334155";
  var bloques={};
  costos.forEach(function(c){
    var k=(c.sede||"")+"|"+(c.ubicacion||"");
    if(!(c.ubicacion||"").trim()) return;
    if(!bloques[k]) bloques[k]={costo:0,m2:c.m2_bloque||0,label:(c.ubicacion||""),sede:(c.sede||"")};
    bloques[k].costo+=parseFloat(c.total_linea)||0; if(!bloques[k].m2 && c.m2_bloque) bloques[k].m2=c.m2_bloque;
  });
  var sortedB=Object.keys(bloques).sort(function(a,b){return bloques[b].costo-bloques[a].costo}).slice(0,15);
  var labelsB=sortedB.map(function(k){return bloques[k].label;}), costosB=sortedB.map(function(k){return bloques[k].costo;}), colorsB=sortedB.map(function(_,i){return CL[i%CL.length];});
  if(charts["chInvBloqueG"]) charts["chInvBloqueG"].destroy(); var ctx1=document.getElementById("chInvBloqueG");
  if(ctx1) charts["chInvBloqueG"]=new Chart(ctx1,{type:"bar",data:{labels:labelsB,datasets:[{data:costosB,backgroundColor:colorsB,borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{color:tc,callback:function(v){return fmtK(v)}}},y:{ticks:{color:tc}}}}});
  var m2B=sortedB.map(function(k){var m=bloques[k].m2;return m>0?Math.round(bloques[k].costo/m):0;});
  if(charts["chInvM2BloqueG"]) charts["chInvM2BloqueG"].destroy(); var ctx2=document.getElementById("chInvM2BloqueG");
  if(ctx2) charts["chInvM2BloqueG"]=new Chart(ctx2,{type:"bar",data:{labels:labelsB,datasets:[{data:m2B,backgroundColor:colorsB,borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{color:tc,callback:function(v){return"$"+fmtK(v)}}},y:{ticks:{color:tc}}}}});
  var cambio=0,lavado=0,otros=0; costos.forEach(function(c){var t=(c.tipo||"").toLowerCase(),v=parseFloat(c.total_linea)||0;if(t.includes("cambio"))cambio+=v;else if(t.includes("lavado"))lavado+=v;else otros+=v;});
  if(charts["chInvRatioG"]) charts["chInvRatioG"].destroy(); var ctx3=document.getElementById("chInvRatioG");
  if(ctx3) charts["chInvRatioG"]=new Chart(ctx3,{type:"doughnut",data:{labels:["Cambio","Lavado","Otros"],datasets:[{data:[cambio,lavado,otros],backgroundColor:[CL[0],CL[1],CL[2]],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom",labels:{color:tc}}}}});
  var sedesInv={"OLAS":{costo:0,m2:0},"MANANTIALES":{costo:0,m2:0}}, bContados={};
  costos.forEach(function(c){ var s=(c.sede||"").toUpperCase(); if(sedesInv[s]) sedesInv[s].costo+=parseFloat(c.total_linea)||0; var bk=s+"|"+(c.ubicacion||"").toUpperCase(); if(!bContados[bk]&&(c.m2_bloque||0)>0){bContados[bk]=true;if(sedesInv[s])sedesInv[s].m2+=c.m2_bloque;} });
  var cm2Sedes=["OLAS","MANANTIALES"].map(function(s){var d=sedesInv[s];return d.m2>0?Math.round(d.costo/d.m2):0;});
  if(charts["chInvM2SedesG"]) charts["chInvM2SedesG"].destroy(); var ctx4=document.getElementById("chInvM2SedesG");
  if(ctx4) charts["chInvM2SedesG"]=new Chart(ctx4,{type:"bar",data:{labels:["OLAS","MANANTIALES"],datasets:[{data:cm2Sedes,backgroundColor:[CL[0],CL[1]],borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{color:tc}},y:{grid:{color:gc},ticks:{color:tc,callback:function(v){return"$"+fmtK(v)}}}}}});
}

function mkChart(id,type,labels,datasets,opts){
  if(charts[id])charts[id].destroy();var ctx=document.getElementById(id);if(!ctx)return;
  var isLight=!document.body.classList.contains("dark"), tc=isLight?"#64748b":"#94a3b8", gc=isLight?"#e2e8f0":"#334155";
  charts[id]=new Chart(ctx,{type:type,data:{labels:labels,datasets:datasets},options:Object.assign({responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:tc}}},scales:type==="pie"||type==="doughnut"||type==="radar"?undefined:{x:{grid:{color:gc},ticks:{color:tc}},y:{grid:{color:gc},ticks:{color:tc,callback:function(v){return fmtK(v)}}}}},opts||{})});
}

function chCat(cos){var m={};cos.forEach(function(c){if(c.categoria)m[c.categoria]=(m[c.categoria]||0)+(parseFloat(c.total_linea)||0)});var s=Object.keys(m).sort(function(a,b){return m[b]-m[a]});mkChart("chCat","bar",s,[{data:s.map(function(k){return m[k]}),backgroundColor:CL,borderRadius:6}],{indexAxis:"x",plugins:{legend:{display:false}}})}
function chTipo(cos){var m={};cos.forEach(function(c){if(c.tipo)m[c.tipo]=(m[c.tipo]||0)+(parseFloat(c.total_linea)||0)});var s=Object.keys(m).sort(function(a,b){return m[b]-m[a]}).slice(0,10);mkChart("chTipo","bar",s,[{data:s.map(function(k){return m[k]}),backgroundColor:CL,borderRadius:6}],{indexAxis:"y",plugins:{legend:{display:false}}})}
function chMes(cos){var m={};cos.forEach(function(c){var x=(c.fecha||"").substring(0,7);if(x)m[x]=(m[x]||0)+(parseFloat(c.total_linea)||0)});var l=Object.keys(m).sort();mkChart("chMes","line",l,[{label:"Gasto",data:l.map(function(k){return m[k]}),borderColor:CL[0],backgroundColor:"rgba(37,99,235,0.15)",fill:true,tension:0.4,pointRadius:4,pointBackgroundColor:CL[0]}]);}
function chEmp(ots,cos){var emps=uniq(ots.map(function(o){return o.empresa}).filter(Boolean));var cats=uniq(cos.map(function(c){return c.categoria}).filter(Boolean)).slice(0,5);var ds=cats.map(function(cat,i){return{label:cat,data:emps.map(function(emp){var ids=new Set(ots.filter(function(o){return o.empresa===emp}).map(function(o){return o.ot_id}));return cos.filter(function(c){return c.categoria===cat&&ids.has(c.ot_id)}).reduce(function(a,c){return a+(parseFloat(c.total_linea)||0)},0)}),backgroundColor:CL[i],borderRadius:4}});mkChart("chEmp","bar",emps,ds,{scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:function(v){return fmtK(v)}}}}})}
function chEst(ots){var m={PENDIENTE:0,"EN PROCESO":0,CERRADO:0};ots.forEach(function(o){m[o.estado]=(m[o.estado]||0)+1});mkChart("chEst","doughnut",Object.keys(m),[{data:Object.values(m),backgroundColor:[CL[2],CL[0],CL[1]],borderWidth:0,hoverOffset:6}],{plugins:{legend:{position:"bottom"}}})}
function chLab(cos){var m={};cos.forEach(function(c){if(c.labor)m[c.labor]=(m[c.labor]||0)+(parseFloat(c.total_linea)||0)});var l=Object.keys(m);mkChart("chLab","doughnut",l,[{data:l.map(function(k){return m[k]}),backgroundColor:CL.slice(0,l.length),borderWidth:0,hoverOffset:6}],{plugins:{legend:{position:"bottom"}}})}
function chTop(ots,cos){var m={};cos.forEach(function(c){m[c.ot_id]=(m[c.ot_id]||0)+(parseFloat(c.total_linea)||0)});var s=Object.keys(m).sort(function(a,b){return m[b]-m[a]}).slice(0,10);mkChart("chTop","bar",s,[{data:s.map(function(k){return m[k]}),backgroundColor:CL,borderRadius:6}],{indexAxis:"y",plugins:{legend:{display:false}}})}
function chRadar(cos){var cats=uniq(cos.map(function(c){return c.categoria}).filter(Boolean));var prom=cats.map(function(cat){var r=cos.filter(function(c){return c.categoria===cat});return r.length?r.reduce(function(a,c){return a+(parseFloat(c.total_linea)||0)},0)/r.length:0});mkChart("chRadar","radar",cats,[{label:"Ticket Promedio",data:prom,backgroundColor:"rgba(37,99,235,0.2)",borderColor:CL[0],pointBackgroundColor:CL[0]}]);}
function chVol(ots){var m={};ots.forEach(function(o){var x=(o.fecha||"").substring(0,7);if(x)m[x]=(m[x]||0)+1});var l=Object.keys(m).sort();mkChart("chVol","bar",l,[{data:l.map(function(k){return m[k]}),backgroundColor:CL[4],borderRadius:6}],{plugins:{legend:{display:false}}})}
function chSedes(){
  var costoOlas=0,costoMant=0; var idsOlas=new Set(),idsMant=new Set();
  otData.forEach(function(o){var s=(o.sede||"").toUpperCase();if(s==="OLAS")idsOlas.add(o.ot_id);else if(s==="MANANTIALES")idsMant.add(o.ot_id);});
  costoData.forEach(function(c){var t=parseFloat(c.total_linea)||0;if(idsOlas.has(c.ot_id))costoOlas+=t;else if(idsMant.has(c.ot_id))costoMant+=t;});
  mkChart("chSedes","bar",["OLAS","MANANTIALES"],[{data:[costoOlas,costoMant],backgroundColor:[CL[0],CL[1]],borderRadius:6}],{plugins:{legend:{display:false}}});
  mkChart("chM2","bar",["OLAS (325k m²)","MANANTIALES (160k m²)"],[{label:"$/m²",data:[Math.round(costoOlas/M2["OLAS"]),Math.round(costoMant/M2["MANANTIALES"])],backgroundColor:[CL[4],CL[2]],borderRadius:6}],{plugins:{legend:{display:false}}});
}

function poblarFiltrosCC(){
  var clasifs=[]; centrosCostosData.forEach(function(c){ if(c.clasificacion&&clasifs.indexOf(c.clasificacion)<0) clasifs.push(c.clasificacion); });
  var sel=document.getElementById("ccFiltClasif"); if(sel){ sel.innerHTML='<option value="">Clasificaciones</option>'; clasifs.sort().forEach(function(cl){ sel.innerHTML+='<option value="'+esc(cl)+'">'+esc(cl)+'</option>'; }); }
}

function renderChCC(){
  var sede=(document.getElementById("ccFiltSede")||{value:""}).value, clasif=(document.getElementById("ccFiltClasif")||{value:""}).value;
  var d=getDatos(); var ccMap={};centrosCostosData.forEach(function(c){ccMap[c.id]=c;});
  var costosFilt=d.costos.filter(function(c){
    if(sede&&(c.sede||"").toUpperCase()!==sede.toUpperCase()) return false;
    if(clasif){var info=ccMap[c.cc];if(!info||info.clasificacion!==clasif)return false;} return true;
  });
  var porCC={};costosFilt.forEach(function(c){var k=c.cc||"SIN CC";porCC[k]=(porCC[k]||0)+(parseFloat(c.total_linea)||0);});
  var totalGasto=costosFilt.reduce(function(a,c){return a+(parseFloat(c.total_linea)||0)},0), nCC=Object.keys(porCC).filter(function(k){return k!=="SIN CC"}).length;
  var topCC=Object.keys(porCC).sort(function(a,b){return porCC[b]-porCC[a]})[0]||"—", topInfo=ccMap[topCC];
  var porClasif={};costosFilt.forEach(function(c){var info=ccMap[c.cc];var cl=info?info.clasificacion:"Sin clasificar";porClasif[cl]=(porClasif[cl]||0)+(parseFloat(c.total_linea)||0);});
  
  var el=document.getElementById("ccKpis");if(el){el.innerHTML="";
  [{ico:"💰",val:fmtCOP(totalGasto),lbl:"Total CC",cls:"blue"},{ico:"🏆",val:topCC,lbl:"Top CC",sub:topInfo?topInfo.descripcion:"",cls:"warn"},{ico:"🔧",val:fmtCOP(porClasif["MANTENIMIENTO"]||0),lbl:"Mantenimiento",cls:"green"},{ico:"📈",val:fmtCOP(porClasif["PROYECTO DE INVERSION"]||0),lbl:"Proyectos Inv.",cls:"purple"}].forEach(function(k){el.innerHTML+='<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div><div class="kpi-sub">'+(k.sub||"")+'</div></div>';});}
  
  var sortedCC=Object.keys(porCC).sort(function(a,b){return porCC[b]-porCC[a]}).slice(0,10);
  mkChart("chCC","bar",sortedCC.map(function(k){return k}),[{data:sortedCC.map(function(k){return porCC[k]}),backgroundColor:CL,borderRadius:6}],{indexAxis:"y",plugins:{legend:{display:false}}});
  var clasifKeys=Object.keys(porClasif).sort(function(a,b){return porClasif[b]-porClasif[a]});
  mkChart("chCCClasif","doughnut",clasifKeys,[{data:clasifKeys.map(function(k){return porClasif[k]}),backgroundColor:CL,borderWidth:0}],{plugins:{legend:{position:"bottom"}}});
  
  var top5CC=Object.keys(porCC).sort(function(a,b){return porCC[b]-porCC[a]}).slice(0,5), mesesSet={};
  costosFilt.forEach(function(c){var m=(c.fecha||"").substring(0,7);if(m)mesesSet[m]=true;}); var meses=Object.keys(mesesSet).sort();
  var datasets5=top5CC.map(function(cc,i){return{label:cc,data:meses.map(function(m){return costosFilt.filter(function(c){return c.cc===cc&&(c.fecha||"").substring(0,7)===m;}).reduce(function(a,c){return a+(parseFloat(c.total_linea)||0)},0)}),borderColor:CL[i],tension:0.4};});
  mkChart("chCCMes","line",meses,datasets5);
}

function renderPresupInversion(){
  var sede=(document.getElementById("presInvSede")||{value:""}).value;
  var ccsConPresup=centrosCostosData.filter(function(c){if((c.presupuesto||0)<=0)return false;if(sede&&(c.sede||"").toUpperCase()!==sede.toUpperCase())return false; return true;});
  var tb=document.getElementById("presInvTbody"); if(!ccsConPresup.length){if(tb)tb.innerHTML='<tr><td colspan="8" class="lst-st">Sin presupuesto asignado</td></tr>';return;}
  var ejecutadoPorCC={};costoData.forEach(function(c){var k=c.cc||"";if(!k)return;ejecutadoPorCC[k]=(ejecutadoPorCC[k]||0)+(parseFloat(c.total_linea)||0);});
  var filas=ccsConPresup.map(function(cc){var pres=cc.presupuesto||0,ejec=ejecutadoPorCC[cc.id]||0,dif=pres-ejec,pct=pres>0?(ejec/pres*100):0,sobre=ejec>pres;return{cc:cc,pres:pres,ejec:ejec,dif:dif,pct:pct,sobre:sobre};}).sort(function(a,b){return b.pres-a.pres;});
  var totPres=filas.reduce(function(a,r){return a+r.pres},0),totEjec=filas.reduce(function(a,r){return a+r.ejec},0),totDif=totPres-totEjec,nSobre=filas.filter(function(r){return r.sobre}).length,nOk=filas.filter(function(r){return !r.sobre&&r.ejec>0}).length,pctGlobal=totPres>0?(totEjec/totPres*100):0;
  
  var elKpi=document.getElementById("presInvKpis");if(elKpi){elKpi.innerHTML="";[{ico:"💼",val:fmtCOP(totPres),lbl:"Presupuesto Total",cls:"blue"},{ico:"💸",val:fmtCOP(totEjec),lbl:"Total Ejecutado",cls:totEjec>totPres?"warn":"green"},{ico:"🔴",val:nSobre,lbl:"CCs Sobreejec.",cls:"warn"},{ico:"🟢",val:nOk,lbl:"Dentro Presupuesto",cls:"green"}].forEach(function(k){elKpi.innerHTML+='<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div></div>';});}
  
  if(tb){tb.innerHTML="";filas.forEach(function(r){
    var eb=r.ejec===0?'<span class="badge pend">Sin ejecutar</span>':r.sobre?'<span class="badge brd">Sobreejecutado</span>':'<span class="badge bgr">Dentro</span>';
    var tr=document.createElement("tr"); if(r.sobre)tr.style.background="var(--danger-bg)";
    tr.innerHTML='<td class="mono" style="font-weight:600">'+esc(r.cc.id)+'</td><td style="font-size:0.75rem">'+esc((r.cc.descripcion||"—").substring(0,30))+'</td><td>'+esc(r.cc.sede||"")+'</td><td class="r">'+fmtCOP(r.pres)+'</td><td class="r" style="color:'+(r.sobre?"var(--danger)":r.ejec>0?"var(--success)":"var(--text-muted)")+'">'+fmtCOP(r.ejec)+'</td><td class="r" style="color:'+(r.dif<0?"var(--danger)":"var(--success)")+'">'+(r.dif<0?"-":"+")+fmtCOP(Math.abs(r.dif))+'</td><td style="text-align:center">'+r.pct.toFixed(1)+'%</td><td style="text-align:center">'+eb+'</td>';
    tb.appendChild(tr);
  });
  tb.innerHTML+='<tr style="background:var(--bg-hover);font-weight:700;"><td colspan="3">TOTAL</td><td class="r">'+fmtCOP(totPres)+'</td><td class="r">'+fmtCOP(totEjec)+'</td><td class="r">'+(totDif<0?"-":"+")+fmtCOP(Math.abs(totDif))+'</td><td style="text-align:center">'+pctGlobal.toFixed(1)+'%</td><td style="text-align:center"></td></tr>';}
  
  var top10=filas.slice(0,10);
  mkChart("chPresInvBar","bar",top10.map(function(r){return r.cc.id;}),[{label:"Presupuesto",data:top10.map(function(r){return r.pres;}),backgroundColor:"rgba(37,99,235,0.3)",borderColor:"#2563eb",borderWidth:1,borderRadius:4},{label:"Ejecutado",data:top10.map(function(r){return r.ejec;}),backgroundColor:top10.map(function(r){return r.sobre?"#ef4444":"#10b981";}),borderRadius:4}],{indexAxis:"y"});
  mkChart("chPresInvPct","bar",top10.map(function(r){return r.cc.id;}),[{label:"% Ejecución",data:top10.map(function(r){return Math.min(r.pct,150);}),backgroundColor:top10.map(function(r){return r.sobre?"#ef4444":"#10b981";}),borderRadius:4}],{indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{max:150}}});
}

var PRESUPUESTO_INV = { cc:"MTZ000400", sede:"MANANTIALES", anio:"2026", meses:{"2026-01":23446981,"2026-02":23446981,"2026-03":23446981,"2026-04":23446981,"2026-05":23446981,"2026-06":23446981,"2026-07":23446981,"2026-08":23446981,"2026-09":29686759,"2026-10":23446981,"2026-11":23446981,"2026-12":23446981} };
function renderAlertaPresupuesto(){
  var P = PRESUPUESTO_INV, nomMes={"01":"Ene","02":"Feb","03":"Mar","04":"Abr","05":"May","06":"Jun","07":"Jul","08":"Ago","09":"Sep","10":"Oct","11":"Nov","12":"Dic"};
  var costosFilt = invCostData.filter(function(r){ return (r.sede||"").toUpperCase() === "MANANTIALES" && (r.fecha||"").startsWith("2026"); });
  if(!costosFilt.length){ costosFilt = costoData.filter(function(c){ var ot=otData.find(function(o){return o.ot_id===c.ot_id;}); return ((ot&&ot.sede)||"").toUpperCase()==="MANANTIALES" && (c.categoria||"").toLowerCase().indexOf("invernadero")>=0 && (c.fecha||"").startsWith("2026"); }); }
  var ejecucion={}; Object.keys(P.meses).forEach(function(m){ ejecucion[m]=0; });
  costosFilt.forEach(function(r){ var m=(r.fecha||"").substring(0,7); if(ejecucion[m]!==undefined) ejecucion[m]+=parseFloat(r.total_linea)||0; });
  var totalPresup=Object.values(P.meses).reduce(function(a,b){return a+b},0), totalEjec=Object.values(ejecucion).reduce(function(a,b){return a+b},0), pctEjec=totalPresup>0?(totalEjec/totalPresup*100):0, hoy=new Date(), mesActual=hoy.getFullYear()+"-"+String(hoy.getMonth()+1).padStart(2,"0");
  var mesesPasados=Object.keys(P.meses).filter(function(m){return m<=mesActual;}), presupAcumHoy=mesesPasados.reduce(function(a,m){return a+(P.meses[m]||0)},0), ejAcumHoy=mesesPasados.reduce(function(a,m){return a+(ejecucion[m]||0)},0), sobreEjec=ejAcumHoy>presupAcumHoy;
  
  var badge=document.getElementById("presupTotalBadge"); if(badge) badge.textContent="Total Asignado: "+fmtCOP(totalPresup);
  var el=document.getElementById("presupKpis"); if(el){el.innerHTML="";
  [{ico:"📋",val:fmtCOP(totalPresup),lbl:"Presupuesto Anual",cls:"blue"},{ico:"💸",val:fmtCOP(totalEjec),lbl:"Ejecutado Total",cls:totalEjec>totalPresup?"warn":"green"},{ico:"📊",val:fmtCOP(presupAcumHoy),lbl:"Acumulado a la fecha",cls:"purple"},{ico:sobreEjec?"🔴":"🟢",val:fmtCOP(Math.abs(ejAcumHoy-presupAcumHoy)),lbl:sobreEjec?"SOBREEJECUTADO":"DENTRO",cls:sobreEjec?"warn":"green"}].forEach(function(k){el.innerHTML+='<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val" style="font-size:1.25rem">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div></div>';});}
  
  var isLight=!document.body.classList.contains("dark"), tc=isLight?"#64748b":"#94a3b8", gc=isLight?"#e2e8f0":"#334155";
  var mLabels=Object.keys(P.meses).sort().map(function(m){return nomMes[m.substring(5,7)];}), pVals=Object.keys(P.meses).sort().map(function(m){return P.meses[m];}), eVals=Object.keys(P.meses).sort().map(function(m){return ejecucion[m]||0;});
  mkChart("chPresup","bar",mLabels,[{label:"Presupuesto",data:pVals,backgroundColor:"rgba(37,99,235,0.3)",borderColor:"#2563eb",borderWidth:1,borderRadius:4},{label:"Ejecutado",data:eVals,backgroundColor:Object.keys(P.meses).sort().map(function(m){return m>mesActual?"#94a3b8":(ejecucion[m]||0)>P.meses[m]?"#ef4444":"#10b981";}),borderRadius:4}]);
}

var invData=[], invFiltrados=[], invSedeActiva="";
function cargarInvernaderos(){
  document.getElementById("invLoad").style.display="block"; document.getElementById("invWrap").style.display="none";
  gsr("getResumenInvernaderos", null, function(res){
      document.getElementById("invLoad").style.display="none"; document.getElementById("invWrap").style.display="block";
      if(!res){ toast("❌ Error","err2"); return; }
      invData = Array.isArray(res.bloques)?res.bloques:[];
      var sedes=[]; invData.forEach(function(b){ if(b.sede&&sedes.indexOf(b.sede)<0) sedes.push(b.sede); });
      var cont=document.getElementById("invSedeBtns"); cont.innerHTML="";
      sedes.forEach(function(sede, idx){
        var btn=document.createElement("button"); btn.className="atab"+(idx===0?" on":""); btn.textContent=sede;
        btn.onclick=function(){ invSedeActiva=sede; cont.querySelectorAll(".atab").forEach(function(b){b.classList.remove("on");}); btn.classList.add("on"); filtrarInv(); };
        cont.appendChild(btn); if(idx===0) invSedeActiva=sede;
      });
      actualizarKpisInv(); filtrarInv(); renderAlertaPresupuesto();
    }, function(err){ document.getElementById("invLoad").style.display="none"; document.getElementById("invWrap").style.display="block"; toast("❌ "+err.message,"err2"); }
  );
}
function actualizarKpisInv(){
  var bSede=invSedeActiva?invData.filter(function(b){return b.sede===invSedeActiva;}):invData;
  var v=0,p=0,cr=0,ok=0; bSede.forEach(function(b){if(b.alerta_global==="vencido")v++;else if(b.alerta_global==="cambio_req")cr++;else if(b.alerta_global==="proximo")p++;else ok++;});
  document.getElementById("invTot").textContent=bSede.length; document.getElementById("invVenc").textContent=v; document.getElementById("invProx").textContent=p; document.getElementById("invCreq").textContent=cr; document.getElementById("invOk").textContent=ok;
}
function filtrarInv(){
  var busq=(document.getElementById("invBusq").value||"").toLowerCase(), filt=document.getElementById("invFiltro").value;
  invFiltrados=invData.filter(function(b){ if(invSedeActiva&&b.sede!==invSedeActiva)return false; if(busq&&!b.ubicacion.toLowerCase().includes(busq))return false; if(filt&&b.alerta_global!==filt)return false; return true; });
  document.getElementById("invCount").textContent=invFiltrados.length+" bloques";
  var tbody=document.getElementById("invTbody"); tbody.innerHTML="";
  if(!invFiltrados.length){ document.getElementById("invEmpty").style.display="block"; }else{
    document.getElementById("invEmpty").style.display="none";
    invFiltrados.forEach(function(b){
      var tr=document.createElement("tr");
      tr.innerHTML='<td>'+esc(b.sede)+'</td><td style="font-weight:600">'+esc(b.ubicacion)+'</td><td class="r">'+b.num_naves+'</td><td class="r">'+b.num_medianave+'</td><td class="mono">'+esc(b.fecha_prog_cambio||"—")+'</td><td class="mono">'+esc(b.fecha_eje_cambio||"—")+'</td><td><span class="inv-badge '+b.alerta_cambio.estado+'">'+esc(b.alerta_cambio.label)+'</span></td><td class="mono">'+esc(b.fecha_prog_lavado||"—")+'</td><td class="mono">'+esc(b.fecha_eje_lavado||"—")+'</td><td><span class="inv-badge '+b.alerta_lavado.estado+'">'+esc(b.alerta_lavado.label)+'</span></td><td style="text-align:center;font-weight:600;color:'+(b.conteo_lavados>=3?"var(--danger)":b.conteo_lavados>=2?"var(--warning)":"var(--text-main)")+'">'+b.conteo_lavados+'/3</td>';
      tbody.appendChild(tr);
    });
  }
  var labels=invFiltrados.map(function(b){return b.ubicacion;});
  mkChart("chInvCambio","bar",labels,[{label:"Días",data:invFiltrados.map(function(b){return b.alerta_cambio.dias||0;}),backgroundColor:invFiltrados.map(function(b){var e=b.alerta_cambio.estado;return e==="vencido"?"#ef4444":e==="proximo"?"#f59e0b":"#10b981";}),borderRadius:4}],{indexAxis:"y"});
  mkChart("chInvLavado","bar",labels,[{label:"Días",data:invFiltrados.map(function(b){return b.requiere_cambio?0:b.alerta_lavado.dias||0;}),backgroundColor:invFiltrados.map(function(b){if(b.requiere_cambio)return "#8b5cf6";var e=b.alerta_lavado.estado;return e==="vencido"?"#ef4444":e==="proximo"?"#f59e0b":"#10b981";}),borderRadius:4}],{indexAxis:"y"});
}

var invCostData=[], invCostFiltrados=[];
function cargarCostosInv(){
  document.getElementById("invCostLoad").style.display="block"; document.getElementById("invCostWrap").style.display="none";
  gsr("getAnaliticaInvernaderos", null, function(res){ invCostData=Array.isArray(res)?res:[]; document.getElementById("invCostLoad").style.display="none"; document.getElementById("invCostWrap").style.display="block"; filtrarCostosInv(); }, function(err){ document.getElementById("invCostLoad").style.display="none"; document.getElementById("invCostWrap").style.display="block"; toast("❌ Error","err2"); });
}
function filtrarCostosInv(){
  var sede=document.getElementById("invCostSede").value, tipo=document.getElementById("invCostTipo").value, busq=(document.getElementById("invCostBusq").value||"").toLowerCase();
  invCostFiltrados=invCostData.filter(function(r){ if(sede&&(r.sede||"").toUpperCase()!==sede)return false; if(busq&&!(r.ubicacion||"").toLowerCase().includes(busq))return false; if(tipo==="cambio"&&!(r.tipo||"").toLowerCase().includes("cambio"))return false; if(tipo==="lavado"&&!(r.tipo||"").toLowerCase().includes("lavado"))return false; if(tipo==="otros"){var t=(r.tipo||"").toLowerCase();if(t.includes("cambio")||t.includes("lavado"))return false;} return true; });
  
  var totalGasto=invCostFiltrados.reduce(function(a,r){return a+(parseFloat(r.total_linea)||0)},0), bloques={}, m2PorBloque={}, cambio=0, lavado=0;
  invCostFiltrados.forEach(function(r){ var k=(r.sede||"")+"|"+(r.ubicacion||""); if(!(r.ubicacion||"").trim())return; bloques[k]=(bloques[k]||0)+(parseFloat(r.total_linea)||0); if((r.m2_bloque||0)>0)m2PorBloque[k]=r.m2_bloque; var t=(r.tipo||"").toLowerCase(), v=parseFloat(r.total_linea)||0; if(t.includes("cambio"))cambio+=v;else if(t.includes("lavado"))lavado+=v; });
  var nBloques=Object.keys(bloques).length, topBloque=Object.keys(bloques).sort(function(a,b){return bloques[b]-bloques[a]})[0]||"", m2Total=0; Object.keys(m2PorBloque).forEach(function(k){m2Total+=m2PorBloque[k];});
  
  var el=document.getElementById("invCostKpis"); el.innerHTML="";
  [{ico:"💰",val:fmtCOP(totalGasto),lbl:"Gasto Total",cls:"blue"},{ico:"📐",val:fmtCOP(Math.round(m2Total>0?totalGasto/m2Total:0)),lbl:"Costo/m² prom.",cls:"purple"},{ico:"🔄",val:fmtCOP(cambio),lbl:"Cambios",cls:"cyan"},{ico:"🚿",val:fmtCOP(lavado),lbl:"Lavados",cls:"green"}].forEach(function(k){el.innerHTML+='<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val" style="font-size:1.25rem">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div></div>';});
  
  var tbody=document.getElementById("invCostTbody"); tbody.innerHTML="";
  if(!invCostFiltrados.length){ document.getElementById("invCostEmpty").style.display="block"; document.getElementById("invCostFoot").innerHTML=""; document.getElementById("invCostTbl").style.display="none"; }else{
    document.getElementById("invCostEmpty").style.display="none"; document.getElementById("invCostTbl").style.display="table";
    invCostFiltrados.forEach(function(r){ var tr=document.createElement("tr"); tr.innerHTML='<td>'+esc(r.sede)+'</td><td style="font-weight:600">'+esc(r.ubicacion)+'</td><td class="r">'+Math.round(r.m2_bloque||0)+'</td><td class="r" style="color:var(--primary);font-weight:600;">'+fmtCOP(r.total_linea)+'</td><td class="r">'+fmtCOP(Math.round(r.m2_bloque>0?r.total_linea/r.m2_bloque:0))+'</td><td class="mono">'+esc(r.ot_id)+'</td><td class="mono">'+esc(r.fecha)+'</td><td>'+esc(r.tipo)+'</td><td style="font-size:0.75rem">'+esc(r.descripcion)+'</td><td class="r">'+fmtCOP(r.total_linea)+'</td>'; tbody.appendChild(tr); });
    document.getElementById("invCostFoot").innerHTML='<div style="font-weight:700;font-size:1.25rem;">Total: <span style="color:var(--primary);">'+fmtCOP(totalGasto)+'</span></div>';
  }
  
  var sB=Object.keys(bloques).sort(function(a,b){return bloques[b]-bloques[a]}).slice(0,10);
  mkChart("chInvCostoBloque","bar",sB.map(function(k){return k.split("|")[1]||k;}),[{data:sB.map(function(k){return bloques[k];}),backgroundColor:CL,borderRadius:4}],{indexAxis:"y",plugins:{legend:{display:false}}});
  mkChart("chInvCostoM2","bar",sB.map(function(k){return k.split("|")[1]||k;}),[{data:sB.map(function(k){return m2PorBloque[k]>0?Math.round(bloques[k]/m2PorBloque[k]):0;}),backgroundColor:CL,borderRadius:4}],{indexAxis:"y",plugins:{legend:{display:false}}});

  var sedesData={"OLAS":{c:0,m2:0},"MANANTIALES":{c:0,m2:0}}, bCont={};
  invCostData.forEach(function(r){ var s=(r.sede||"").toUpperCase(); if(sedesData[s])sedesData[s].c+=parseFloat(r.total_linea)||0; var k=s+"|"+(r.ubicacion||"").toUpperCase(); if((r.ubicacion||"").trim()&&!bCont[k]&&(r.m2_bloque||0)>0){bCont[k]=true;if(sedesData[s])sedesData[s].m2+=(r.m2_bloque||0);} });
  mkChart("chInvM2Sede","bar",["OLAS","MANANTIALES"],[{label:"Costo/m²",data:[sedesData["OLAS"].m2>0?sedesData["OLAS"].c/sedesData["OLAS"].m2:0, sedesData["MANANTIALES"].m2>0?sedesData["MANANTIALES"].c/sedesData["MANANTIALES"].m2:0],backgroundColor:[CL[0],CL[1]],borderRadius:4}]);
  var c2=0,l2=0,o2=0; invCostData.forEach(function(r){var t=(r.tipo||"").toLowerCase(), v=parseFloat(r.total_linea)||0; if(t.includes("cambio"))c2+=v;else if(t.includes("lavado"))l2+=v;else o2+=v;});
  mkChart("chInvRatio","doughnut",["Cambio","Lavado","Otros"],[{data:[c2,l2,o2],backgroundColor:[CL[0],CL[1],CL[2]],borderWidth:0}],{plugins:{legend:{position:"bottom"}}});
}

var eqData=[], eqFiltrados=[];
function cargarEquiposAnalitica(){
  document.getElementById("eqLoad").style.display="block"; document.getElementById("eqWrap").style.display="none";
  gsr("getAnaliticaEquipos", null, function(res){ eqData=Array.isArray(res)?res:[]; document.getElementById("eqLoad").style.display="none"; document.getElementById("eqWrap").style.display="block"; var sedes=uniq(eqData.map(function(e){return e.sede}).filter(Boolean)).sort(), sel=document.getElementById("eqSede"), cur=sel.value; sel.innerHTML='<option value="">Sedes</option>'; sedes.forEach(function(s){sel.innerHTML+='<option'+(s===cur?' selected':'')+'>'+s+'</option>'}); filtrarEquiposAnalitica(); }, function(){});
}
function filtrarEquiposAnalitica(){
  var sede=document.getElementById("eqSede").value, cat=document.getElementById("eqCat").value, busq=(document.getElementById("eqBusq").value||"").toLowerCase();
  eqFiltrados=eqData.filter(function(e){ if(sede&&e.sede!==sede)return false; if(cat&&e.categoria!==cat)return false; if(busq&&!(e.equipo_cod+e.equipo_desc).toLowerCase().includes(busq))return false; return true; });
  document.getElementById("eqCount").textContent=eqFiltrados.length+" registros";
  
  var tot=eqFiltrados.reduce(function(a,r){return a+(parseFloat(r.total_linea)||0)},0), mEq={};
  eqFiltrados.forEach(function(r){var k=r.equipo_cod||r.equipo_desc;if(!k)return;mEq[k]=(mEq[k]||0)+(parseFloat(r.total_linea)||0);});
  var sEq=Object.keys(mEq).sort(function(a,b){return mEq[b]-mEq[a]}), tEq=sEq[0]||"";
  var el=document.getElementById("eqKpiGrid"); el.innerHTML="";
  [{ico:"💰",val:fmtCOP(tot),lbl:"Gasto Total Equipos",cls:"blue"},{ico:"⚙",val:uniq(eqFiltrados.map(function(r){return r.equipo_cod||r.equipo_desc}).filter(Boolean)).length,lbl:"Equipos intervenidos",cls:"purple"},{ico:"🏆",val:tEq||"—",lbl:"Top Equipo",cls:"warn"}].forEach(function(k){el.innerHTML+='<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val" style="font-size:1.25rem">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div></div>';});
  
  var tb=document.getElementById("eqTbody"); tb.innerHTML="";
  if(!eqFiltrados.length){document.getElementById("eqEmpty").style.display="block";}else{
    document.getElementById("eqEmpty").style.display="none";
    eqFiltrados.forEach(function(r){var tr=document.createElement("tr");tr.innerHTML='<td class="mono">'+esc(r.equipo_cod||"—")+'</td><td style="font-weight:600">'+esc(r.equipo_desc||"—")+'</td><td>'+esc(r.sede||"")+'</td><td class="mono">'+esc(r.ot_id)+'</td><td class="mono">'+esc(r.fecha)+'</td><td>'+esc(r.categoria)+'</td><td>'+esc(r.tipo)+'</td><td style="font-size:0.75rem">'+esc(r.descripcion)+'</td><td class="r" style="color:var(--primary);font-weight:600;">'+fmtCOP(r.total_linea)+'</td>';tb.appendChild(tr);});
  }
  mkChart("chEqCosto","bar",sEq.slice(0,10),[{data:sEq.slice(0,10).map(function(k){return mEq[k]}),backgroundColor:CL,borderRadius:4}],{indexAxis:"y",plugins:{legend:{display:false}}});
  var mC={}; eqFiltrados.forEach(function(r){var k=r.equipo_cod||r.equipo_desc;if(k)mC[k]=(mC[k]||0)+1;}); var sC=Object.keys(mC).sort(function(a,b){return mC[b]-mC[a]});
  mkChart("chEqCount","bar",sC.slice(0,10),[{data:sC.slice(0,10).map(function(k){return mC[k]}),backgroundColor:CL.slice().reverse(),borderRadius:4}],{indexAxis:"y",plugins:{legend:{display:false}}});
}

// ═══ ADMINISTRACIÓN ══════════════════════════════
var catSeleccionada = "";
function renderAdmin(mantenerCat){
  var cats = Object.keys(catalogo); if(!mantenerCat) catSeleccionada = cats.length ? cats[0] : "";
  document.getElementById("ccount").textContent = cats.length+" categorías";
  var cl = document.getElementById("clist"); cl.innerHTML="";
  cats.forEach(function(cat){
    var isActive = cat === catSeleccionada;
    var d = document.createElement("div");
    d.style.cssText = "display:flex;align-items:center;justify-content:space-between;border-radius:var(--radius-sm);padding:0.75rem 1rem;cursor:pointer;transition:all .2s;border:1px solid "+(isActive?"var(--primary)":"var(--border-color)")+";background:"+(isActive?"var(--primary-bg)":"var(--bg-hover)");
    d.onclick = function(e){ if(e.target.closest("button")) return; catSeleccionada = cat; renderAdmin(true); };
    d.innerHTML = '<div style="flex:1"><div style="font-size:0.875rem;font-weight:600;color:'+(isActive?"var(--primary)":"var(--text-main)")+'">'+esc(cat)+'</div><div style="font-size:0.75rem;color:var(--text-muted);">'+(catalogo[cat]?catalogo[cat].length:0)+' tipos</div></div><div style="display:flex;gap:0.25rem"><button class="btn bwn" style="padding:4px 8px;font-size:0.75rem;" onclick="editCat(this.dataset.cat)" data-cat="'+esc(cat)+'">✏</button><button class="btn brd" style="padding:4px 8px;font-size:0.75rem;" onclick="delCat(this.dataset.cat)" data-cat="'+esc(cat)+'">🗑</button></div>';
    cl.appendChild(d);
  });
  
  var tipos = catSeleccionada && catalogo[catSeleccionada] ? catalogo[catSeleccionada] : [];
  document.getElementById("tcount").textContent = catSeleccionada ? tipos.length+" tipos" : "0 tipos";
  var tl = document.getElementById("tlist"); tl.innerHTML="";
  if(!catSeleccionada || !tipos.length){ tl.innerHTML='<div class="lst-st">Sin tipos — agrega uno abajo</div>'; } 
  else {
    tipos.forEach(function(t){
      var d = document.createElement("div");
      d.style.cssText="display:flex;align-items:center;justify-content:space-between;background:var(--bg-hover);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:0.5rem 1rem;";
      d.innerHTML='<div style="font-size:0.875rem;font-weight:500;">'+esc(t)+'</div><div style="display:flex;gap:0.25rem"><button class="btn bwn" style="padding:4px 8px;font-size:0.75rem;" onclick="editTipo(this.dataset.cat,this.dataset.tip)" data-cat="'+esc(catSeleccionada)+'" data-tip="'+esc(t)+'">✏</button><button class="btn brd" style="padding:4px 8px;font-size:0.75rem;" onclick="delTipo(this.dataset.cat,this.dataset.tip)" data-cat="'+esc(catSeleccionada)+'" data-tip="'+esc(t)+'">🗑</button></div>';
      tl.appendChild(d);
    });
  }
  
  var sel = document.getElementById("ntcat");
  sel.innerHTML='<option value="">— Categoría —</option>';
  cats.forEach(function(c){ sel.innerHTML+='<option value="'+esc(c)+'"'+(c===catSeleccionada?' selected':'')+'>'+esc(c)+'</option>'; });
  if(catSeleccionada) sel.value = catSeleccionada;
  gsr("saveCatalogo", catalogo, null, null);
}

function addCat(){var v=document.getElementById("nci").value.trim();if(!v||catalogo[v]){toast("⚠️ Inválido","wn2");return}catalogo[v]=[];document.getElementById("nci").value="";catSeleccionada=v;renderAdmin(true);toast("✅ Creada","ok2")}
function delCat(cat){if(!confirm("¿Eliminar \""+cat+"\"?"))return;delete catalogo[cat];if(catSeleccionada===cat)catSeleccionada=Object.keys(catalogo)[0]||'';renderAdmin(true);toast("🗑 Eliminada","ok2")}
function addTipo(){var cat=document.getElementById("ntcat").value,v=document.getElementById("nti").value.trim();if(!cat||!v){toast("⚠️ Faltan datos","wn2");return}if(!catalogo[cat])catalogo[cat]=[];if(catalogo[cat].indexOf(v)!==-1){toast("⚠️ Ya existe","wn2");return}catalogo[cat].push(v);document.getElementById("nti").value="";catSeleccionada=cat;renderAdmin(true);toast("✅ Agregado","ok2")}
function delTipo(cat,tipo){if(!confirm("¿Eliminar?"))return;catalogo[cat]=(catalogo[cat]||[]).filter(function(t){return t!==tipo});catSeleccionada=cat;renderAdmin(true);toast("🗑 Eliminado","ok2")}

var _mm="",_md={};
function editCat(cat){_mm="cat";_md={old:cat};document.getElementById("mtit").textContent="Editar categoría";document.getElementById("min").value=cat;document.getElementById("mbg").classList.add("open")}
function editTipo(cat,tipo){_mm="tipo";_md={cat:cat,old:tipo};document.getElementById("mtit").textContent="Editar tipo";document.getElementById("min").value=tipo;document.getElementById("mbg").classList.add("open")}
function closeM(){document.getElementById("mbg").classList.remove("open")}
function saveM(){var v=document.getElementById("min").value.trim();if(!v)return;if(_mm==="cat"){var t=catalogo[_md.old]||[];delete catalogo[_md.old];catalogo[v]=t;catSeleccionada=v;}else{var a=catalogo[_md.cat]||[];var i=a.indexOf(_md.old);if(i!==-1)a[i]=v;catalogo[_md.cat]=a;catSeleccionada=_md.cat;}closeM();renderAdmin(true);toast("✅ Actualizado","ok2")}

// ═══ UTILIDADES GENERALES ════════════════════════
function normalizarEmpresa(s){ return !s ? "" : s.trim().toLowerCase().replace(/\b\w/g,function(l){return l.toUpperCase();}); }
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function fmtCOP(n){return"$ "+parseFloat(n||0).toLocaleString("es-CO",{minimumFractionDigits:0,maximumFractionDigits:0})}
function fmtK(v){if(Math.abs(v)>=1e6)return"$"+(v/1e6).toFixed(1)+"M";if(Math.abs(v)>=1e3)return"$"+(v/1e3).toFixed(0)+"K";return"$"+v}
function setB(bid,sid,tid,loading,txt){var b=document.getElementById(bid);if(b)b.disabled=loading;var s=document.getElementById(sid);if(s)s.style.display=loading?"block":"none";var t=document.getElementById(tid);if(t)t.textContent=txt}
function toast(msg,type){var t=document.getElementById("toast");t.textContent=msg;t.className="toast show "+(type||"");clearTimeout(t._tm);t._tm=setTimeout(function(){t.className="toast"},3800)}

function toggleTheme(){
  var isDark = document.body.classList.toggle("dark");
  document.getElementById("themeLabel").textContent = isDark ? "Claro" : "Oscuro";
  document.getElementById("themeBtn").innerHTML = isDark ? "☀️ <span>Claro</span>" : "🌙 <span>Oscuro</span>";
  var tc = document.getElementById("themeColor"); if(tc) tc.content = isDark ? "#0f172a" : "#f8fafc";
  try{ localStorage.setItem("ot_theme", isDark?"dark":"light"); }catch(e){}
  setTimeout(function(){ if(otData.length||costoData.length) renderCharts(); }, 50);
}
function initTheme(){
  var saved; try{ saved = localStorage.getItem("ot_theme"); }catch(e){}
  if(saved === "dark"){
    document.body.classList.add("dark");
    document.getElementById("themeLabel").textContent = "Claro";
    document.getElementById("themeBtn").innerHTML = "☀️ <span>Claro</span>";
  }
}

// ================================================================
//  MÓDULO: ENERGÍA (kWh / m²)
// ================================================================
var energiaData = [];
var enerEditId  = "";

function periodoE(e){ return e.anio + "-" + String(e.mes).padStart(2,"0"); }
function kwhM2E(e){ var m2 = M2[e.sede]||0; return m2 ? e.consumo_kwh/m2 : 0; }
function pctFVE(e){ var t = e.consumo_kwh + e.generacion_fv_kwh; return t ? (e.generacion_fv_kwh/t*100) : 0; }
function costoKwhE(e){ return e.consumo_kwh ? (e.valor_factura/e.consumo_kwh) : 0; }
function fmtNumEner(n,dec){ return parseFloat(n||0).toLocaleString("es-CO",{minimumFractionDigits:dec||0,maximumFractionDigits:dec||0}); }

function cargarEnergia(){
  var ld=document.getElementById("enerLoad"); if(ld) ld.style.display="block";
  gsr("getEnergia", {},
    function(res){
      energiaData = res||[];
      if(ld) ld.style.display="none";
      poblarFiltroAnioEnergia();
      renderEnergia();
    },
    function(err){ if(ld) ld.style.display="none"; toast("❌ "+err.message,"err2"); }
  );
}

function poblarFiltroAnioEnergia(){
  var sel = document.getElementById("enerFiltAnio"); if(!sel) return;
  var actual = sel.value;
  var anios = uniq(energiaData.map(function(e){return e.anio}).filter(Boolean)).sort(function(a,b){return b-a});
  sel.innerHTML = '<option value="">Todos los años</option>';
  anios.forEach(function(a){ sel.innerHTML += '<option value="'+a+'">'+a+'</option>'; });
  sel.value = actual;
}

function getEnergiaFiltrada(){
  var sedeSel = document.getElementById("enerFiltSede"), anioSel = document.getElementById("enerFiltAnio");
  var sede = sedeSel ? sedeSel.value : "";
  var anio = anioSel ? anioSel.value : "";
  return energiaData.filter(function(e){
    if(sede && e.sede!==sede) return false;
    if(anio && String(e.anio)!==anio) return false;
    return true;
  }).sort(function(a,b){ return periodoE(a) < periodoE(b) ? 1 : -1; });
}

function renderEnergia(){
  var d = getEnergiaFiltrada();
  renderKpisEnergia(d);
  renderTablaEnergia(d);
  renderChartsEnergia(d);
}

function renderKpisEnergia(d){
  var box=document.getElementById("enerKpis"); if(!box) return;
  var consumo=0, fv=0, valor=0;
  d.forEach(function(e){ consumo+=e.consumo_kwh; fv+=e.generacion_fv_kwh; valor+=e.valor_factura; });
  var pctFV = (consumo+fv) ? (fv/(consumo+fv)*100) : 0;
  var costoProm = consumo ? (valor/consumo) : 0;
  var sedesPresentes = uniq(d.map(function(e){return e.sede}).filter(Boolean));
  var m2tot = sedesPresentes.reduce(function(a,s){return a+(M2[s]||0);},0);
  var kwhm2 = m2tot ? (consumo/m2tot) : 0;

  var kpis=[
    {ico:"⚡",val:fmtNumEner(consumo)+" kWh",lbl:"Consumo adquirido",sub:d.length+" registro(s)",cls:"blue"},
    {ico:"☀️",val:fmtNumEner(fv)+" kWh",lbl:"Generación FV",sub:"Autoconsumo solar",cls:"warn"},
    {ico:"🌱",val:pctFV.toFixed(1)+" %",lbl:"Cobertura FV",sub:"Del consumo total",cls:"green"},
    {ico:"💰",val:fmtCOP(valor),lbl:"Costo total factura",sub:sedesPresentes.join(", ")||"—",cls:"pink"},
    {ico:"📉",val:"$ "+fmtNumEner(costoProm,1),lbl:"Costo prom. / kWh",sub:"Ponderado",cls:"purple"},
    {ico:"📐",val:fmtNumEner(kwhm2,2),lbl:"kWh/m²",sub:"Consumo / área",cls:"cyan"}
  ];
  box.innerHTML="";
  kpis.forEach(function(k){
    box.innerHTML += '<div class="kpi '+k.cls+'"><div class="kpi-ico">'+k.ico+'</div><div class="kpi-val">'+k.val+'</div><div class="kpi-lbl">'+k.lbl+'</div><div class="kpi-sub">'+k.sub+'</div></div>';
  });
}

function renderChartsEnergia(d){
  chEnerSede(d); chEnerM2(d); chEnerTend(d); chEnerFV(d); chEnerCosto(d); chEnerPctFV(d);
}

function chEnerSede(d){
  var m={}; d.forEach(function(e){ m[e.sede]=(m[e.sede]||0)+e.consumo_kwh; });
  var s=Object.keys(m);
  mkChart("chEnerSede","bar",s,[{data:s.map(function(k){return Math.round(m[k]);}),backgroundColor:CL,borderRadius:6}],{plugins:{legend:{display:false}}});
}

function chEnerM2(d){
  var sedes=["OLAS","MANANTIALES"];
  var vals=sedes.map(function(s){
    var rs=d.filter(function(e){return e.sede===s});
    var consumo=rs.reduce(function(a,e){return a+e.consumo_kwh;},0);
    return M2[s] ? +(consumo/M2[s]).toFixed(2) : 0;
  });
  mkChart("chEnerM2","bar",sedes,[{data:vals,backgroundColor:[CL[5],CL[2]],borderRadius:6}],{plugins:{legend:{display:false}}});
}

function chEnerTend(d){
  var m={}; d.forEach(function(e){ var p=periodoE(e); m[p]=(m[p]||0)+e.consumo_kwh; });
  var l=Object.keys(m).sort();
  mkChart("chEnerTend","line",l,[{label:"kWh",data:l.map(function(k){return Math.round(m[k]);}),borderColor:CL[0],backgroundColor:"rgba(37,99,235,0.15)",fill:true,tension:0.4,pointRadius:3,pointBackgroundColor:CL[0]}]);
}

function chEnerFV(d){
  var m={}; d.forEach(function(e){ var p=periodoE(e); if(!m[p])m[p]={a:0,f:0}; m[p].a+=e.consumo_kwh; m[p].f+=e.generacion_fv_kwh; });
  var l=Object.keys(m).sort();
  mkChart("chEnerFV","bar",l,[
    {label:"Adquirida",data:l.map(function(k){return Math.round(m[k].a);}),backgroundColor:CL[0],borderRadius:4},
    {label:"Fotovoltaica",data:l.map(function(k){return Math.round(m[k].f);}),backgroundColor:CL[2],borderRadius:4}
  ],{scales:{x:{stacked:true},y:{stacked:true}}});
}

function chEnerCosto(d){
  var m={}; d.forEach(function(e){ m[periodoE(e)]=costoKwhE(e); });
  var l=Object.keys(m).sort();
  mkChart("chEnerCosto","line",l,[{label:"$/kWh",data:l.map(function(k){return +m[k].toFixed(1);}),borderColor:CL[4],backgroundColor:"rgba(236,72,153,0.15)",fill:true,tension:0.4,pointRadius:3,pointBackgroundColor:CL[4]}]);
}

function chEnerPctFV(d){
  var m={}; d.forEach(function(e){ m[periodoE(e)]=pctFVE(e); });
  var l=Object.keys(m).sort();
  mkChart("chEnerPctFV","line",l,[{label:"% FV",data:l.map(function(k){return +m[k].toFixed(1);}),borderColor:CL[1],backgroundColor:"rgba(16,185,129,0.15)",fill:true,tension:0.4,pointRadius:3,pointBackgroundColor:CL[1]}]);
}

function renderTablaEnergia(d){
  var tbody=document.getElementById("enerTbody"); if(!tbody) return;
  tbody.innerHTML="";
  var empty=document.getElementById("enerEmpty"); if(empty) empty.style.display = d.length ? "none" : "block";
  d.forEach(function(e){
    var tr=document.createElement("tr");
    tr.innerHTML =
      '<td>'+esc(e.sede)+'</td>'+
      '<td class="mono">'+periodoE(e)+'</td>'+
      '<td class="r">'+fmtNumEner(e.consumo_kwh)+'</td>'+
      '<td class="r">'+fmtNumEner(e.generacion_fv_kwh)+'</td>'+
      '<td class="r">'+fmtNumEner(kwhM2E(e),2)+'</td>'+
      '<td class="r">'+pctFVE(e).toFixed(1)+'%</td>'+
      '<td class="r">'+fmtCOP(e.valor_factura)+'</td>'+
      '<td class="r">$'+fmtNumEner(costoKwhE(e),1)+'</td>'+
      '<td style="font-size:0.75rem;color:var(--text-muted)">'+esc(e.observaciones||"—")+'</td>'+
      '<td style="text-align:center"><div style="display:flex;gap:0.25rem;justify-content:center"><button class="btn bwn" style="padding:4px 8px;font-size:0.75rem;" onclick="editarEnergiaRow(\''+e.id_mov+'\')">✏</button><button class="btn brd" style="padding:4px 8px;font-size:0.75rem;" onclick="eliminarEnergiaRow(\''+e.id_mov+'\')">🗑</button></div></td>';
    tbody.appendChild(tr);
  });
}

function editarEnergiaRow(id_mov){
  var e = energiaData.find(function(x){return x.id_mov===id_mov;}); if(!e) return;
  enerEditId = id_mov;
  document.getElementById("ener_id_mov").value = id_mov;
  document.getElementById("ener_sede").value = e.sede;
  document.getElementById("ener_anio").value = e.anio;
  document.getElementById("ener_mes").value = e.mes;
  document.getElementById("ener_consumo").value = e.consumo_kwh;
  document.getElementById("ener_fv").value = e.generacion_fv_kwh;
  document.getElementById("ener_valor").value = e.valor_factura;
  document.getElementById("ener_obs").value = e.observaciones||"";
  document.getElementById("bEnerT").textContent = "💾 Actualizar registro";
  document.getElementById("btnEnerCancel").style.display = "block";
  document.getElementById("formEner").scrollIntoView({behavior:"smooth"});
}

function cancelarEdicionEnergia(){
  enerEditId = "";
  document.getElementById("formEner").reset();
  document.getElementById("ener_id_mov").value = "";
  document.getElementById("bEnerT").textContent = "💾 Guardar registro";
  document.getElementById("btnEnerCancel").style.display = "none";
}

function eliminarEnergiaRow(id_mov){
  if(!confirm("¿Eliminar este registro de energía de forma permanente?")) return;
  gsr("eliminarEnergia", id_mov,
    function(res){
      if(!res||!res.ok){ toast("❌ "+(res?res.msg:"Error"),"err2"); return; }
      toast("🗑 Registro eliminado","ok2");
      cargarEnergia();
    },
    function(err){ toast("❌ "+err.message,"err2"); }
  );
}

document.getElementById("formEner").addEventListener("submit", function(ev){
  ev.preventDefault();
  var payload = {
    id_mov: enerEditId || "",
    sede: document.getElementById("ener_sede").value,
    anio: document.getElementById("ener_anio").value,
    mes: document.getElementById("ener_mes").value,
    consumo_kwh: document.getElementById("ener_consumo").value || "0",
    generacion_fv_kwh: document.getElementById("ener_fv").value || "0",
    valor_factura: document.getElementById("ener_valor").value || "0",
    observaciones: document.getElementById("ener_obs").value.trim()
  };
  var editando = !!enerEditId;
  setB("btnEner","spEner","bEnerT",true, editando ? "Actualizando…" : "Guardando…");
  gsr("guardarEnergia", payload,
    function(res){
      if(!res||!res.ok){
        setB("btnEner","spEner","bEnerT",false, editando ? "💾 Actualizar registro" : "💾 Guardar registro");
        toast("❌ "+(res?res.msg:"Error"),"err2");
        return;
      }
      toast("✅ "+res.msg,"ok2");
      cancelarEdicionEnergia();
      cargarEnergia();
    },
    function(err){
      setB("btnEner","spEner","bEnerT",false, editando ? "💾 Actualizar registro" : "💾 Guardar registro");
      toast("❌ "+err.message,"err2");
    }
  );
});

// ================================================================
//  MÓDULO: CARGA MASIVA
// ================================================================
var cmFilas = [];   // filas parseadas del Excel, listas para enviar

function fechaCM(v){
  if (v instanceof Date) return v.toISOString().split("T")[0];
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function procesarCargaMasiva(){
  var input = document.getElementById("cmFile");
  var file = input.files[0];
  if(!file){ toast("⚠️ Selecciona un archivo primero","wn2"); return; }

  var reader = new FileReader();
  reader.onload = function(e){
    var data = new Uint8Array(e.target.result);
    var wb;
    try{ wb = XLSX.read(data, {type:"array", cellDates:true}); }
    catch(err){ toast("❌ No se pudo leer el archivo: "+err.message,"err2"); return; }

    var hoja = wb.Sheets["Carga"] || wb.Sheets[wb.SheetNames[0]];
    if(!hoja){ toast("❌ No encontré una hoja con datos en el archivo","err2"); return; }

    var raw = XLSX.utils.sheet_to_json(hoja, {defval:""});
    cmFilas = raw.map(function(r){
      return {
        ot_id: String(r.ot_id||"").trim(),
        fecha: fechaCM(r.fecha),
        proveedor: String(r.proveedor||"").trim(),
        sede: String(r.sede||"").trim().toUpperCase(),
        centro_costo: String(r.centro_costo||"").trim(),
        categoria: String(r.categoria||"").trim(),
        tipo: String(r.tipo||"").trim(),
        labor: String(r.labor||"").trim(),
        descripcion: String(r.descripcion||"").trim(),
        ubicacion: String(r.ubicacion||"").trim(),
        cantidad: parseFloat(r.cantidad)||0,
        precio_unitario: parseFloat(r.precio_unitario)||0,
        estado: String(r.estado||"PENDIENTE").trim().toUpperCase()
      };
    }).filter(function(r){ return r.ot_id; });

    if(!cmFilas.length){ toast("⚠️ El archivo no tiene filas con ot_id","wn2"); return; }
    renderPreviewCargaMasiva();
  };
  reader.readAsArrayBuffer(file);
}

function renderPreviewCargaMasiva(){
  var grupos = {};
  cmFilas.forEach(function(f){ (grupos[f.ot_id] = grupos[f.ot_id]||[]).push(f); });

  var otsExistentes = {};
  (allOTs||[]).forEach(function(o){ otsExistentes[o.ot_id] = true; });

  var tbody = document.getElementById("cmTbody"); tbody.innerHTML="";
  var totalItems = 0, totalOTs = 0, conAlerta = 0;

  Object.keys(grupos).forEach(function(oid){
    var items = grupos[oid];
    var sub = items.reduce(function(a,i){ return a + i.cantidad*i.precio_unitario; },0);
    var cats = uniq(items.map(function(i){return i.categoria}).filter(Boolean));
    var sede = items[0].sede;
    var alertas = [];
    if(otsExistentes[oid]) alertas.push("Ya existe — se omitirá");
    else{
      var similares = buscarPosibleDuplicado(items[0].proveedor, items[0].fecha, sub);
      if(similares.length) alertas.push("Se parece a "+similares.map(function(o){return o.ot_id}).join(", ")+" (mismo proveedor/fecha/monto)");
    }
    if(sede!=="OLAS" && sede!=="MANANTIALES") alertas.push("Sede inválida: \""+sede+"\"");
    cats.forEach(function(c){ if(!catNombreToId[c]) alertas.push("Categoría no está en el catálogo: \""+c+"\""); });
    if(items.some(function(i){return !i.centro_costo;})) alertas.push("Centro de costo vacío en alguna fila");

    if(alertas.length) conAlerta++;
    totalItems += items.length; totalOTs++;

    var tr = document.createElement("tr");
    if(alertas.length) tr.style.background = "var(--danger-bg)";
    tr.innerHTML =
      '<td class="mono" style="font-weight:600">'+esc(oid)+'</td>'+
      '<td>'+esc(items[0].proveedor)+'</td>'+
      '<td>'+esc(sede)+'</td>'+
      '<td style="font-size:0.75rem">'+esc(cats.join(", ")||"—")+'</td>'+
      '<td class="r">'+items.length+'</td>'+
      '<td class="r">'+fmtCOP(sub)+'</td>'+
      '<td>'+esc(items[0].estado)+'</td>'+
      '<td style="font-size:0.7rem;color:'+(alertas.length?'var(--danger)':'var(--success)')+'">'+(alertas.length?("⚠ "+esc(alertas.join(" · "))):"✓ Lista para cargar")+'</td>';
    tbody.appendChild(tr);
  });

  document.getElementById("cmResumen").textContent = totalOTs+" cotización(es) · "+totalItems+" ítem(s) · "+conAlerta+" con alerta";
  document.getElementById("cmAviso").textContent = conAlerta
    ? "Las filas con alerta igual se pueden cargar: las que 'ya existen' se omiten solas, pero corrige categoría/sede antes de confirmar si aplica."
    : "Todo se ve correcto.";
  document.getElementById("cmPreviewCard").style.display = "block";
  document.getElementById("cmResultCard").style.display = "none";
}

function confirmarCargaMasiva(){
  if(!cmFilas.length) return;
  setB("btnCM","spCM","bCMt",true,"Cargando…");
  gsr("cargaMasiva", cmFilas,
    function(res){
      setB("btnCM","spCM","bCMt",false,"✅ Confirmar carga");
      if(!res||!res.ok){ toast("❌ Error en la carga","err2"); return; }
      var html = '<div style="display:flex;flex-direction:column;gap:0.5rem;font-size:0.875rem;">'+
        '<div>✅ <b>'+res.creadas.length+'</b> cotización(es) creada(s), <b>'+res.lineas+'</b> línea(s) de costo insertadas.</div>';
      if(res.omitidas && res.omitidas.length) html += '<div>↷ Omitidas (ya existían): '+esc(res.omitidas.join(", "))+'</div>';
      if(res.errores && res.errores.length){
        html += '<div style="color:var(--danger)">❌ Con error:</div><ul style="margin:0;padding-left:1.25rem;color:var(--danger);font-size:0.8125rem;">';
        res.errores.forEach(function(e){ html += '<li>'+esc(e.ot_id)+': '+esc(e.msg)+'</li>'; });
        html += '</ul>';
      }
      html += '</div>';
      document.getElementById("cmResultBody").innerHTML = html;
      document.getElementById("cmResultCard").style.display = "block";
      document.getElementById("cmPreviewCard").style.display = "none";
      cmFilas = [];
      document.getElementById("cmFile").value = "";
      toast("✅ Carga masiva completada","ok2");
      cargarRegs(); cargarAnalitica();
    },
    function(err){ setB("btnCM","spCM","bCMt",false,"✅ Confirmar carga"); toast("❌ "+err.message,"err2"); }
  );
}
