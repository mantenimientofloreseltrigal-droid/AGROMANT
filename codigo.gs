// ================================================================
//  APPS SCRIPT — AgroMant
//  Versión: App Web nativa con google.script.run
//  Gestión de Mantenimiento y Control de Costos
// ================================================================

var FOLDER_ID = "1TzY2e9mbwThTMMkHifG_Wrl-uUeqXMR5";

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("AgroMant — Gestión de Mantenimiento")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// ================================================================
//  MÓDULO: ÓRDENES DE TRABAJO (OT)
// ================================================================

function crearOT(data) {
  try {
    var urlPDF = "";
    guardarOT(data, urlPDF, []);
    guardarCostoInicial(data);
    return { ok: true, msg: "OT creada exitosamente" };
  } catch(err) {
    Logger.log("crearOT error: " + err.message);
    return { ok: false, msg: err.message };
  }
}

function guardarOT(data, urlPDF, actas) {
  hoja("OT_MANTENIMIENTO").appendRow([
    data.ot_id,
    Utilities.getUuid(),
    data.fecha,                          
    normalizarTexto(data.empresa),
    data.sede,
    data.clasificacion,
    "",                   
    parseFloat(data.precio_total) || 0,
    data.centro_costos,
    "PENDIENTE",
    urlPDF,          
    JSON.stringify(actas || [])
  ]);
}

function getOTs() {
  try {
    var sheet = hoja("OT_MANTENIMIENTO");
    var rows  = sheet.getDataRange().getValues();
    if (rows.length < 2) return [];
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var otId = String(r[0]||"").trim();
      if (!otId) continue;
      var actas = [];
      try { actas = JSON.parse(r[11] || "[]"); } catch(ex) {}
      out.push({
        ot_id:         String(r[0]||"").trim(),
        id_interno:    String(r[1]  || ""),
        fecha:         fmtFecha(r[2]),
        empresa:       normalizarTexto(String(r[3]||"")),
        sede:          String(r[4]  || ""),
        clasificacion: String(r[5]  || ""),
        observaciones: String(r[6]  || ""),
        precio_total:  parseFloat(r[7])  || 0,
        centro_costos: String(r[8]  || ""),
        estado:        String(r[9]  || "PENDIENTE"),
        archivo_pdf:   String(r[10] || ""),
        actas:         actas,                     
        actas_count:   actas.length
      });
    }
    return out.reverse();
  } catch(err) {
    Logger.log("getOTs error: " + err.message);
    return [];
  }
}

function getItemsOT(ot_id) {
  try {
    ot_id = String(ot_id).trim();
    var sheet = hoja("COSTOS_MANTENIMIENTO");
    var rows  = sheet.getDataRange().getValues();
    var out   = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (String(r[2]||"").trim() !== ot_id) continue;
      if (String(r[7]).trim() === "Registro inicial OT") continue;
      out.push({
        categoria:   String(r[4]  || ""),
        tipo:        String(r[5]  || ""),
        labor:       String(r[6]  || ""),
        descripcion: String(r[7]  || ""),
        ubicacion:   String(r[8]  || ""),
        cantidad:    parseFloat(r[9])  || 0,
        precio:      parseFloat(r[10]) || 0,
        total_linea: parseFloat(r[11]) || 0,
        equipo_cod:  String(r[17] || ""),
        equipo_desc: String(r[18] || "")
      });
    }
    return out;
  } catch(err) {
    Logger.log("getItemsOT error: " + err.message);
    return [];
  }
}

function getAnalitica() {
  try {
    var shOT  = hoja("OT_MANTENIMIENTO");
    var shCOS = hoja("COSTOS_MANTENIMIENTO");
    var rowsOT  = shOT.getDataRange().getValues();
    var rowsCOS = shCOS.getDataRange().getValues();
    var ots = [], costos = [];
    
    for (var i = 1; i < rowsOT.length; i++) {
      var r = rowsOT[i];
      if (!r[0]) continue;
      ots.push({
        ot_id:        String(r[0]||"").trim(),
        fecha:        fmtFecha(r[2]),
        empresa:      normalizarTexto(String(r[3]||"")),
        sede:         String(r[4] || ""),          
        estado:       String(r[9] || "PENDIENTE"),
        precio_total: parseFloat(r[7]) || 0
      });
    }

    for (var i = 1; i < rowsCOS.length; i++) {
      var r = rowsCOS[i];
      if (!r[0] && !r[2]) continue;
      if (!r[2]) continue;
      costos.push({
        ot_id:       String(r[2]||"").trim(),
        fecha:       fmtFecha(r[1]),
        empresa:     normalizarTexto(String(r[3]||"")),
        categoria:   String(r[4]  || ""),
        tipo:        String(r[5]  || ""),
        labor:       String(r[6]  || ""),
        descripcion: String(r[7]  || ""),
        cantidad:    parseFloat(r[9])  || 0,
        precio:      parseFloat(r[10]) || 0,
        total_linea: parseFloat(r[11]) || 0,
        sede:        String(r[14] || ""),
        cc:          String(r[16] || "")
      });
    }
    return { ots: ots, costos: costos };
  } catch(err) {
    Logger.log("getAnalitica error: " + err.message);
    return { ots: [], costos: [] };
  }
}

function saveDetalle(payload) {
  try {
    var items  = payload.items;
    var ot_id  = String(payload.ot_id).trim();
    var sheet  = hoja("COSTOS_MANTENIMIENTO");
    var rows   = sheet.getDataRange().getValues();
    var hoyStr = fmt(new Date());

    for (var i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][2]).trim() === ot_id) sheet.deleteRow(i + 1);
    }

    items.forEach(function(item) {
      var cant = parseFloat(item.cantidad) || 0;
      var prec = parseFloat(item.precio)   || 0;
      var fechaItem = item.fecha_ot || hoyStr;
      sheet.appendRow([
        Utilities.getUuid(),
        fechaItem,   
        ot_id,
        item.empresa       || "",
        item.categoria     || "",
        item.tipo          || "",
        item.labor         || "",
        item.descripcion   || "",
        item.ubicacion     || "",
        cant,                
        prec,
        cant * prec,
        "",                      
        hoyStr,
        item.sede          || "",
        fechaItem.substring(0, 7),
        item.centro_costos || "",
        item.equipo_cod    || "",
        item.equipo_desc   || ""
      ]);
    });
    
    var fechaOT = (items.length && items[0].fecha_ot) ? items[0].fecha_ot : hoyStr;
    procesarItemsInvernadero(items, fechaOT);
    return { ok: true };
  } catch(err) {
    Logger.log("saveDetalle error: " + err.message);
    return { ok: false, msg: err.message };
  }
}

function saveEditarOT(datos) {
  try {
    editarOT(datos);
    return { ok: true };
  } catch(err) {
    Logger.log("saveEditarOT error: " + err.message);
    return { ok: false, msg: err.message };
  }
}

function editarOT(datos) {
  var sheet    = hoja("OT_MANTENIMIENTO");
  var rows     = sheet.getDataRange().getValues();
  var encontro = false;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(datos.ot_id_original).trim()) {
      var row = i + 1;
      sheet.getRange(row, 1).setValue(datos.ot_id);
      sheet.getRange(row, 3).setValue(datos.fecha);
      sheet.getRange(row, 4).setValue(normalizarTexto(datos.empresa));
      sheet.getRange(row, 5).setValue(datos.sede);
      sheet.getRange(row, 6).setValue(datos.clasificacion);
      sheet.getRange(row, 7).setValue(datos.observaciones);
      sheet.getRange(row, 8).setValue(parseFloat(datos.precio_total) || 0);
      sheet.getRange(row, 9).setValue(datos.centro_costos);
      sheet.getRange(row, 10).setValue(datos.estado);
      encontro = true;
    }
  }
  if (!encontro) throw new Error("OT no encontrada: " + datos.ot_id_original);
}

function guardarCostoInicial(data) {
  var h = data.fecha || fmt(new Date());
  hoja("COSTOS_MANTENIMIENTO").appendRow([
    Utilities.getUuid(),
    h,
    data.ot_id,
    normalizarTexto(data.empresa),
    "",
    "",
    "",
    "Registro inicial OT",
    "GENERAL",
    1,
    parseFloat(data.precio_total) || 0,
    parseFloat(data.precio_total) || 0,
    "",
    h,
    data.sede           || "",
    h.substring(0, 7),
    data.centro_costos  || ""
  ]);
}

function deleteOT(ot_id) {
  try {
    ot_id = String(ot_id).trim();
    var shOT  = hoja("OT_MANTENIMIENTO");
    var rowsOT = shOT.getDataRange().getValues();
    for (var i = rowsOT.length - 1; i >= 1; i--) {
      if (String(rowsOT[i][0]).trim() === ot_id) {
        shOT.deleteRow(i + 1);
      }
    }
    var shCOS  = hoja("COSTOS_MANTENIMIENTO");
    var rowsCOS = shCOS.getDataRange().getValues();
    for (var i = rowsCOS.length - 1; i >= 1; i--) {
      if (String(rowsCOS[i][2]).trim() === ot_id) {
        shCOS.deleteRow(i + 1);
      }
    }
    return { ok: true };
  } catch(err) {
    return { ok: false, msg: err.message };
  }
}

// ================================================================
//  CATÁLOGO & ARCHIVOS
// ================================================================

function getCatalogo() {
  try { return leerCatalogo(); } catch(err) { return {}; }
}

function saveCatalogo(catalogo) {
  try { guardarCatalogo(catalogo); return { ok: true }; }
  catch(err) { return { ok: false, msg: err.message }; }
}

function guardarCatalogo(catalogo) {
  var sheet = hoja("CATALOGO");
  sheet.clearContents();
  sheet.appendRow(["CATEGORIA", "TIPOS_JSON"]);
  Object.keys(catalogo).forEach(function(cat) {
    sheet.appendRow([cat, JSON.stringify(catalogo[cat] || [])]);
  });
}

function leerCatalogo() {
  var sheet = hoja("CATALOGO");
  var rows  = sheet.getDataRange().getValues();
  var cat   = {};
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    try { cat[rows[i][0]] = JSON.parse(rows[i][1] || "[]"); }
    catch(e) { cat[rows[i][0]] = []; }
  }
  return cat;
}

function recibirChunkPDF(data) {
  try {
    PropertiesService.getScriptProperties().setProperty("chunk_" + data.ot_id + "_" + data.idx, data.chunk);
    return { ok: true };
  } catch(err) {
    return { ok: false, msg: err.message };
  }
}

function ensamblarPDF(data) {
  try {
    var props = PropertiesService.getScriptProperties();
    var b64   = "";
    for (var i = 0; i < data.total; i++) {
      var key = "chunk_" + data.ot_id + "_" + i;
      b64 += (props.getProperty(key) || "");
      props.deleteProperty(key);
    }
    if (!b64) return { ok: false, msg: "Sin datos de chunks" };
    
    var carpeta = DriveApp.getFolderById(FOLDER_ID);
    var bytes   = Utilities.base64Decode(b64.split(",")[1]);
    var blob    = Utilities.newBlob(bytes, "application/pdf", data.nombre);
    var f       = carpeta.createFile(blob);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var url = f.getUrl();
    
    var sheet = hoja("OT_MANTENIMIENTO");
    var rows  = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === String(data.ot_id).trim()) {
        sheet.getRange(i + 1, 11).setValue(url);
        break;
      }
    }
    return { ok: true, url: url };
  } catch(err) {
    return { ok: false, msg: err.message };
  }
}

// ================================================================
//  MÓDULOS DE NEGOCIO (INVERNADEROS Y EQUIPOS)
// ================================================================

function parseFecha(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function alertaEstado(fechaProg, hoy) {
  if (!fechaProg) return { estado:"sin_fecha", label:"Sin programar", dias:null };
  fechaProg = new Date(fechaProg); fechaProg.setHours(0,0,0,0);
  var dias = Math.floor((fechaProg - hoy) / 86400000);
  if (dias < 0)   return { estado:"vencido",  label:"Vencido hace "+Math.abs(dias)+" días", dias:dias };
  if (dias <= 30) return { estado:"proximo",  label:"En "+dias+" días", dias:dias };
  return { estado:"ok", label:"En "+dias+" días", dias:dias };
}

function getInvernaderos() {
  try {
    var shInv = hoja("MANTENIMIENTO_INVERNADEROS");
    var shCOS = hoja("COSTOS_MANTENIMIENTO");
    var rowsInv = shInv.getDataRange().getValues();
    var rowsCOS = shCOS.getDataRange().getValues();
    if (rowsInv.length < 2) return [];
    var hoy = new Date(); hoy.setHours(0,0,0,0);
    var conteosMap = {};

    for (var c = 1; c < rowsCOS.length; c++) {
      var rc = rowsCOS[c];
      if (!rc[0]) continue;
      var cat  = String(rc[4]||"").toLowerCase();
      var tipo = String(rc[5]||"").toLowerCase();
      var sede = String(rc[14]||"").trim().toLowerCase();
      var ubic = String(rc[8]||"").trim().toLowerCase();
      if (cat.indexOf("invernadero") < 0) continue;
      if (tipo.indexOf("lavado") < 0 || tipo.indexOf("cubiert") < 0) continue;
      var key = sede + "|" + ubic;
      if (!conteosMap[key]) conteosMap[key] = { conteo: 0, ultimoEjeCambio: null };
      conteosMap[key].conteo++;
    }

    var out = [];
    for (var i = 1; i < rowsInv.length; i++) {
      var r = rowsInv[i];
      if (!r[0] && !r[1]) continue;
      var sede = String(r[0]||"").trim();
      var ubic = String(r[1]||"").trim();
      var key  = sede.toLowerCase() + "|" + ubic.toLowerCase();
      var fEjeCambio = parseFecha(r[5]);
      var conteoReal = 0;
      
      for (var c = 1; c < rowsCOS.length; c++) {
        var rc = rowsCOS[c];
        if (!rc[0]) continue;
        var cat2  = String(rc[4]||"").toLowerCase();
        var tipo2 = String(rc[5]||"").toLowerCase();
        var sede2 = String(rc[14]||"").trim().toLowerCase();
        var ubic2 = String(rc[8]||"").trim().toLowerCase();
        var fCosto = parseFecha(rc[1]);
        if (cat2.indexOf("invernadero") < 0) continue;
        if (tipo2.indexOf("lavado") < 0 || tipo2.indexOf("cubiert") < 0) continue;
        if (sede2 !== sede.toLowerCase() || ubic2 !== ubic.toLowerCase()) continue;
        if (fEjeCambio && fCosto && fCosto <= fEjeCambio) continue;
        conteoReal++;
      }

      var reqCambio = conteoReal >= 3;
      var fProgC = parseFecha(r[4]);
      var fProgL = parseFecha(r[6]);
      var aC = alertaEstado(fProgC, hoy);
      var aL = reqCambio
        ? { estado:"cambio_req", label:"Requiere cambio ("+conteoReal+" lavados)", dias:0 }
        : alertaEstado(fProgL, hoy);
      
      var estados = [aC.estado, aL.estado];
      var global = estados.indexOf("vencido")>=0 ? "vencido"
                 : estados.indexOf("cambio_req")>=0 ? "cambio_req"
                 : estados.indexOf("proximo")>=0 ? "proximo" : "ok";
                 
      out.push({
        fila:              i+1,
        sede:              sede,
        ubicacion:         ubic,
        num_naves:         parseFloat(r[2])||0,
        num_medianave:     parseFloat(r[3])||0,
        fecha_prog_cambio: fmtFecha(r[4]),
        fecha_eje_cambio:  fmtFecha(r[5]),
        fecha_prog_lavado: fmtFecha(r[6]),
        fecha_eje_lavado:  fmtFecha(r[7]),
        conteo_lavados:    conteoReal,
        requiere_cambio:   reqCambio,
        alerta_cambio:     aC,
        alerta_lavado:     aL,
        alerta_global:     global
      });
    }
    return out;
  } catch(err) {
    return [];
  }
}

function getResumenInvernaderos() {
  try {
    var bloques = getInvernaderos();
    var v=0, p=0, cr=0, ok=0;
    bloques.forEach(function(b){
      if(b.alerta_global==="vencido")    v++;
      else if(b.alerta_global==="cambio_req") cr++;
      else if(b.alerta_global==="proximo")    p++;
      else ok++;
    });
    return { total:bloques.length, vencidos:v, proximos:p, cambios_req:cr, ok:ok, bloques:bloques };
  } catch(err) { return { total:0, vencidos:0, proximos:0, cambios_req:0, ok:0, bloques:[] }; }
}

function registrarEjecucionInvernadero(data) {
  try {
    var sheet = hoja("MANTENIMIENTO_INVERNADEROS");
    var rows  = sheet.getDataRange().getValues();
    var fecha = parseFecha(data.fecha_ejecutada) || new Date();
    var tipo  = String(data.tipo||"").toLowerCase();
    var esCambio = tipo.indexOf("cambio")>=0 && tipo.indexOf("cubiert")>=0;
    var esLavado = tipo.indexOf("lavado")>=0;
    
    if (!esCambio && !esLavado) return { ok:true, msg:"Tipo no aplica" };
    
    for (var i=1; i<rows.length; i++) {
      var r = rows[i];
      var sedeSheet = String(r[0]||"").trim().toLowerCase();
      var sedeBusc  = String(data.sede||"").trim().toLowerCase();
      if (sedeSheet !== sedeBusc) continue;
      
      var ubicSheet = String(r[1]||"").trim().toLowerCase().replace(/\s+/g," ");
      var ubicBusc  = String(data.ubicacion||"").trim().toLowerCase().replace(/\s+/g," ");
      if (ubicSheet !== ubicBusc) continue;
      
      var row = i+1;
      if (esCambio) {
        sheet.getRange(row,6).setValue(fecha);
        var pC = new Date(fecha); pC.setFullYear(pC.getFullYear()+2);
        sheet.getRange(row,5).setValue(pC);
        var pL = new Date(fecha); pL.setMonth(pL.getMonth()+6);
        sheet.getRange(row,7).setValue(pL);
        sheet.getRange(row,8).setValue("");
      } else if (esLavado) {
        var shCOS2 = hoja("COSTOS_MANTENIMIENTO");
        var rowsCOS2 = shCOS2.getDataRange().getValues();
        var fEjeC = parseFecha(r[5]);
        var conteoActual = 0;
        for (var ci=1; ci<rowsCOS2.length; ci++) {
          var rc2 = rowsCOS2[ci];
          var cat2  = String(rc2[4]||"").toLowerCase();
          var tipo2 = String(rc2[5]||"").toLowerCase();
          var sede2 = String(rc2[14]||"").trim().toLowerCase();
          var ubic2 = String(rc2[8]||"").trim().toLowerCase();
          var fC2   = parseFecha(rc2[1]);
          if (cat2.indexOf("invernadero")<0) continue;
          if (tipo2.indexOf("lavado")<0 || tipo2.indexOf("cubiert")<0) continue;
          if (sede2 !== String(data.sede||"").trim().toLowerCase()) continue;
          if (ubic2 !== String(data.ubicacion||"").trim().toLowerCase()) continue;
          if (fEjeC && fC2 && fC2 <= fEjeC) continue;
          conteoActual++;
        }
        var nuevoConteo = conteoActual + 1;
        sheet.getRange(row,8).setValue(fecha);
        if (nuevoConteo < 3) {
          var pL2 = new Date(fecha);
          pL2.setMonth(pL2.getMonth()+6);
          sheet.getRange(row,7).setValue(pL2);
        } else {
          sheet.getRange(row,7).setValue("CAMBIO REQUERIDO");
        }
      }
      return { ok:true };
    }
    return { ok:true, msg:"Bloque no encontrado en tabla" };
  } catch(err) {
    return { ok:false, msg:err.message };
  }
}

function procesarItemsInvernadero(items, fecha_ot) {
  var procesados = {};
  items.forEach(function(item) {
    if (String(item.categoria||"").toLowerCase().indexOf("invernadero") < 0) return;
    var tipo = String(item.tipo||"").toLowerCase();
    var esCambio = tipo.indexOf("cambio") >= 0 && tipo.indexOf("cubiert") >= 0;
    var esLavado = tipo.indexOf("lavado") >= 0 && tipo.indexOf("cubiert") >= 0;
    if (!esCambio && !esLavado) return;
    var key = (item.sede||"") + "|" + (item.ubicacion||"");
    if (procesados[key]) return; 
    procesados[key] = true;
    registrarEjecucionInvernadero({
      sede:            item.sede  || "",
      ubicacion:       item.ubicacion   || "",
      tipo:            item.tipo        || "",
      fecha_ejecutada: fecha_ot         || fmt(new Date())
    });
  });
}

function getEquiposPorSede(sede) {
  try {
    var sheet = hoja("EQUIPO");
    var rows  = sheet.getDataRange().getValues();
    if (rows.length < 2) return [];
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[0]) continue;
      var sedeFila = String(r[5] || "").trim().toLowerCase();
      var sedeBusc = String(sede || "").trim().toLowerCase();
      if (sedeBusc && sedeFila !== sedeBusc) continue;
      out.push({
        codigo:      String(r[0] || ""),
        descripcion: String(r[1] || ""),
        referencia:  String(r[2] || ""),
        ubicacion:   String(r[3] || ""),
        marca:       String(r[4] || ""),
        sede:        String(r[5] || "")
      });
    }
    return out;
  } catch(err) { return []; }
}

function getAnaliticaEquipos() {
  try {
    var shCOS = hoja("COSTOS_MANTENIMIENTO");
    var rowsCOS = shCOS.getDataRange().getValues();
    var out = [];
    for (var i = 1; i < rowsCOS.length; i++) {
      var r = rowsCOS[i];
      if (!r[0]) continue;
      var equCod  = String(r[17] || "");
      var equDesc = String(r[18] || "");
      if (!equCod && !equDesc) continue;
      out.push({
        ot_id:       String(r[2]  || ""),
        fecha:       String(r[1]  || ""),
        categoria:   String(r[4]  || ""),
        tipo:        String(r[5]  || ""),
        descripcion: String(r[7]  || ""),
        sede:        String(r[14] || ""),
        equipo_cod:  equCod,
        equipo_desc: equDesc,
        total_linea: parseFloat(r[11]) || 0
      });
    }
    return out;
  } catch(err) { return []; }
}

function getUbicacionesPorSede(data) {
  try {
    var categoria = String(data.categoria || "").toLowerCase();
    var sede      = String(data.sede || "").trim();
    var out       = [];
    if (categoria.indexOf("invernadero") >= 0) {
      var sheet = hoja("MANTENIMIENTO_INVERNADEROS");
      var rows  = sheet.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        var r = rows[i];
        if (!r[0] && !r[1]) continue;
        var sedeFila = String(r[0] || "").trim().toLowerCase();
        var sedeBusc = sede.toLowerCase();
        if (sedeBusc && sedeFila !== sedeBusc) continue;
        var ubic = String(r[1] || "").trim();
        if (ubic) out.push(ubic);
      }
    }
    return out;
  } catch(err) { return []; }
}

function getAnaliticaInvernaderos() {
  try {
    var shCOS = hoja("COSTOS_MANTENIMIENTO");
    var shINV = hoja("MANTENIMIENTO_INVERNADEROS");
    var rowsCOS = shCOS.getDataRange().getValues();
    var rowsINV = shINV.getDataRange().getValues();
    
    var dimSede = {
      "MANANTIALES": { nave: 707.2, medianave: 353.6 },
      "OLAS":        { nave: 462.4, medianave: 231.2 }
    };
    var bloquesMap = {};
    for (var b = 1; b < rowsINV.length; b++) {
      var rb = rowsINV[b];
      if (!rb[0] && !rb[1]) continue;
      var sedeB = String(rb[0]||"").trim().toUpperCase();
      var ubicB = String(rb[1]||"").trim().toUpperCase();
      var naves  = parseFloat(rb[2])||0;
      var medias = parseFloat(rb[3])||0;
      var dim    = dimSede[sedeB] || { nave: 462.4, medianave: 231.2 };
      var m2     = naves * dim.nave + medias * dim.medianave;
      bloquesMap[sedeB + "|" + ubicB] = { naves: naves, medianaves: medias, m2: m2 };
    }

    var out = [];
    for (var i = 1; i < rowsCOS.length; i++) {
      var r = rowsCOS[i];
      if (!r[0]) continue;
      var cat = String(r[4]||"").toLowerCase();
      if (cat.indexOf("invernadero") < 0) continue;
      var sedeR = String(r[14]||"").trim().toUpperCase();
      var ubicR = String(r[8] ||"").trim().toUpperCase();
      var info  = bloquesMap[sedeR + "|" + ubicR] || { naves:0, medianaves:0, m2:0 };
      out.push({
        ot_id:       String(r[2]  || ""),
        fecha:       fmtFecha(r[1]),
        sede:        String(r[14] || ""),
        ubicacion:   String(r[8]  || ""),
        tipo:        String(r[5]  || ""),
        labor:       String(r[6]  || ""),
        descripcion: String(r[7]  || ""),
        cantidad:    parseFloat(r[9])  || 0,
        precio:      parseFloat(r[10]) || 0,
        total_linea: parseFloat(r[11]) || 0,
        m2_bloque:   info.m2,
        naves:       info.naves,
        medianaves:  info.medianaves
      });
    }
    return out;
  } catch(err) { return []; }
}

function getCentrosCostos() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("CENTRO_COSTOS") || ss.getSheetByName("Hoja 6") || ss.getSheetByName("CENTROS_COSTOS") || ss.getSheetByName("CENTRO COSTOS");
    if(!sheet) return [];
    var rows  = sheet.getDataRange().getValues();
    var out   = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[0]) continue;
      out.push({
        id:             String(r[0] || ""),
        sede:           String(r[1] || ""),
        clasificacion:  String(r[2] || ""),
        descripcion:    String(r[3] || ""),
        estado:         String(r[4] || ""),
        presupuesto:    parseFloat(String(r[5]||"").replace(/[^0-9.]/g,"")) || 0
      });
    }
    return out;
  } catch(err) { return []; }
}

function getUbicacionesMecanicos(sede) {
  try {
    var sheet = hoja("EQUIPO");
    var rows  = sheet.getDataRange().getValues();
    var ubics = {};
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[0]) continue;
      var sedeFila = String(r[5]||"").trim().toLowerCase();
      var sedeBusc = String(sede||"").trim().toLowerCase();
      if (sedeBusc && sedeFila !== sedeBusc) continue;
      var ubic = String(r[3]||"").trim();
      if (ubic) ubics[ubic] = true;
    }
    return Object.keys(ubics).sort();
  } catch(err) { return []; }
}

// ================================================================
//  FUNCIONES DE AYUDA (HELPERS)
// ================================================================

function hoja(nombre) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var h  = ss.getSheetByName(nombre);
  if (!h) {
    h = ss.insertSheet(nombre);
    var cabeceras = {
      "OT_MANTENIMIENTO": [
        "OT_ID","ID_INTERNO","FECHA","EMPRESA","SEDE",
        "CLASIFICACION","OBSERVACIONES","PRECIO_TOTAL",
        "CENTRO_COSTOS","ESTADO","ARCHIVO_PDF","ACTAS_JSON"
      ],
      "COSTOS_MANTENIMIENTO": [
        "ID_MOV","FECHA","OT_ID","EMPRESA","CATEGORIA",
        "TIPO","LABOR","DESCRIPCION","UBICACION","CANTIDAD",
        "PRECIO_UNITARIO","TOTAL_LINEA","ADJUNTO","FECHA_REG",
        "SEDE","MES","CC"
      ],
      "CATALOGO": ["CATEGORIA","TIPOS_JSON"]
    };
    if (cabeceras[nombre]) h.appendRow(cabeceras[nombre]);
  }
  return h;
}

function normalizarTexto(s) {
  if (!s) return "";
  return String(s).trim().toLowerCase().replace(/ \w/g, function(l){ return l.toUpperCase(); });
}

function fmt(d) {
  var p = function(n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function fmtFecha(val) {
  if (!val) return "";
  if (val instanceof Date) return fmt(val);
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return fmt(d);
  } catch(e) {}
  return s;
}
