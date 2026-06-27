pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ====================================================================
// CONEXIÓN API REAL (GITHUB -> GOOGLE)
// ====================================================================
// PEGA AQUÍ TU LINK DE GOOGLE APPS SCRIPT:
var SCRIPT_URL = "https://script.google.com/macros/s/TU_LINK_AQUI/exec";

function gsr(fn, args, onSuccess, onError) {
  fetch(SCRIPT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify({ funcion: fn, parametros: args })
  })
  .then(function(respuesta) {
    return respuesta.json();
  })
  .then(function(data) {
    if (data && data.error) {
      if (onError) onError(new Error(data.error));
      else toast("❌ Error del servidor: " + data.error, "err2");
    } else {
      if (onSuccess) onSuccess(data);
    }
  })
  .catch(function(error) {
    console.error("Error de conexión:", error);
    if (onError) onError(error);
    else toast("❌ Error de red al contactar a Google", "err2");
  });
}
// ====================================================================

var OT={}, pdfB64="", actasFiles=[];
var centrosCostosData = [];
var allOTs=[], filtOTs=[], pgOTs=1, pgSz=15;
var otData=[], costoData=[];
var charts={};
var currentEditOT=null;
var catalogo={
  "Invernaderos":  ["Cambio de cubiertas","Lavado de cubiertas","Reparación estructural","Instalación sistema riego","Mantenimiento ventilación"],
  "Mecánicos":     ["Cambio de aceite","Revisión de frenos","Reparación motor","Mantenimiento preventivo","Cambio de correas"],
  "Zonas Verdes":  ["Poda de árboles","Siembra de césped","Control de plagas","Fertilización","Riego"],
  "Producción":    ["Calibración de equipos","Limpieza de maquinaria","Reparación de línea","Mantenimiento preventivo","Cambio de piezas"],
  "Obras Civiles": ["Pintura","Resane de paredes","Impermeabilización","Reparación de pisos","Construcción menor"],
  "Eléctricos":    ["Revisión tablero","Cambio de luminarias","Instalación tomacorrientes","Mantenimiento UPS","Cableado"]
};
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
  [1,2,3,4,5].forEach(function(i){document.getElementById("s"+i).classList.remove("on");document.getElementById("nt"+i).classList.remove("on")});
  document.getElementById("s"+n).classList.add("on");document.getElementById("nt"+n).classList.add("on");
  window.scrollTo({top:0,behavior:"smooth"});
  if(n===3) poblarCatFiltro();
  if(n===4) setTimeout(renderCharts,120);
}

function onSedeChange(){
  var sede = document.getElementById("sede").value;
  var clasSel = document.getElementById("clas");
  var ccSel   = document.getElementById("cc");
  if(!sede){
    clasSel.innerHTML='<option value="">— Selecciona sede primero —</option>';
    clasSel.disabled=true;
    ccSel.innerHTML='<option value="">— Selecciona sede primero —</option>';
    ccSel.disabled=true;
    return;
  }
  if(!centrosCostosData.length){
    clasSel.innerHTML='<option value="">Cargando...</option>';
    clasSel.disabled=true;
    gsr("getCentrosCostos", null, function(data){
      centrosCostosData = Array.isArray(data) ? data : [];
      poblarFiltrosCC();
      onSedeChange(); 
    }, function(){
      clasSel.innerHTML='<option value="">— Error —</option>';
    });
    return;
  }
  var filtrados = centrosCostosData.filter(function(c){ return (c.sede||"").toUpperCase() === sede.toUpperCase(); });
  var clases = [];
  filtrados.forEach(function(c){ if(c.clasificacion && clases.indexOf(c.clasificacion)<0) clases.push(c.clasificacion); });
  clases.sort();
  clasSel.innerHTML='<option value="">— Clasificación CC —</option>';
  clases.forEach(function(cl){ clasSel.innerHTML+='<option value="'+esc(cl)+'">'+esc(cl)+'</option>'; });
  clasSel.disabled = clases.length === 0;
  ccSel.innerHTML='<option value="">— Selecciona clasificación —</option>';
  ccSel.disabled=true;
}

function onClasChange(){
  var sede  = document.getElementById("sede").value;
  var clas  = document.getElementById("clas").value;
  var ccSel = document.getElementById("cc");
  if(!sede || !clas){
    ccSel.innerHTML='<option value="">— Selecciona clasificación —</option>';
    ccSel.disabled=true;
    return;
  }
  var filtrados = centrosCostosData.filter(function(c){ return (c.sede||"").toUpperCase() === sede.toUpperCase() && (c.clasificacion||"") === clas; });
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

document.getElementById("formOT").addEventListener("submit",function(e){
  e.preventDefault();
  var f=document.getElementById("arch_pdf").files[0];
  OT={ot_id:document.getElementById("ot_id").value.trim(),fecha:document.getElementById("fecha").value,empresa:normalizarEmpresa(document.getElementById("emp").value.trim()),sede:document.getElementById("sede").value.trim(),clasificacion:document.getElementById("clas").value.trim(),precio_total:document.getElementById("ptot").value||"0",centro_costos:document.getElementById("cc").value.trim(),nombre_archivo:f?f.name:""};
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
  var CHUNK = 400000; 
  var reader = new FileReader();
  reader.onload = function(){
    var b64 = reader.result;
    var total = b64.length;
    var partes = [];
    for(var i=0; i<total; i+=CHUNK){ partes.push(b64.substring(i, i+CHUNK)); }
    var nombre = "COT_"+ot_id+".pdf";
    function enviarChunk(idx){
      if(idx >= partes.length){
        gsr("ensamblarPDF", {ot_id:ot_id, nombre:nombre, total:partes.length}, function(){ toast("📄 PDF en Drive","ok2"); if(onDone)onDone(); }, function(){ if(onDone)onDone(); });
        return;
      }
      gsr("recibirChunkPDF", {ot_id:ot_id, idx:idx, total:partes.length, chunk:partes[idx], nombre:nombre}, function(){ enviarChunk(idx+1); }, function(){ if(onDone)onDone(); });
    }
    enviarChunk(0);
  };
  reader.readAsDataURL(file);
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

function buildEquipoOpts(categoria, ubicacion, selCod){
  var esMecanico = categoria && categoria.toLowerCase().indexOf("mec")>=0;
  if(!esMecanico) return '<option value="">— N/A —</option>';
  var currentSel = String(selCod || "").trim();
  if(currentSel.indexOf("||") >= 0) currentSel = currentSel.split("||")[0];
  var filtrados = equiposCache.filter(function(e){ if(!ubicacion) return true; return String(e.ubicacion||"").toLowerCase().includes(String(ubicacion).toLowerCase()); });
  var opts = '<option value="">— Selecciona equipo —</option>';
  var foundSel = false;
  filtrados.forEach(function(e){
    var codigo = String(e.codigo || "").trim();
    var desc = String(e.descripcion || "").trim();
    var lbl = (codigo ? codigo + " — " : "") + desc + (e.marca ? " (" + e.marca + ")" : "");
    var isSel = currentSel && codigo === currentSel;
    if(isSel) foundSel = true;
    opts += '<option value="'+esc(codigo)+'" data-desc="'+esc(desc)+'"'+(isSel?' selected':'')+'>'+esc(lbl)+'</option>';
  });
  if(currentSel && !foundSel){
    var match = equiposCache.find(function(e){ return String(e.codigo || "").trim() === currentSel; });
    var desc2 = match ? String(match.descripcion || "").trim() : "";
    var lbl2 = match ? ((match.codigo ? match.codigo + " — " : "") + match.descripcion + (match.marca ? " (" + match.marca + ")" : "")) : currentSel;
    opts += '<option value="'+esc(currentSel)+'" data-desc="'+esc(desc2)+'" selected>'+esc(lbl2 || currentSel)+'</option>';
  }
  if(!filtrados.length && !currentSel) opts+='<option value="" disabled>Sin equipos</option>';
  return opts;
}

function bCO(s){var o='<option value="">— Cat —</option>';Object.keys(catalogo).forEach(function(c){o+='<option value="'+esc(c)+'"'+(s===c?" selected":"")+">"+esc(c)+"</option>"});return o}
function bTO(cat,s){var o='<option value="">— Tipo —</option>';if(cat&&catalogo[cat])catalogo[cat].forEach(function(t){o+='<option value="'+esc(t)+'"'+(s===t?" selected":"")+">"+esc(t)+"</option>"});return o}
function bLO(s){return labores.map(function(l){return'<option value="'+l+'"'+(s===l?" selected":"")+">"+l+"</option>"}).join("")}

function getEquipoSelData(tr){
  var sel = tr.querySelector(".eq-sel");
  var codigo = sel ? String(sel.value || "").trim() : "";
  if(codigo.indexOf("||") >= 0) codigo = codigo.split("||")[0];
  var opt = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0] : null;
  var descripcion = opt ? String(opt.getAttribute("data-desc") || "").trim() : "";
  if(!descripcion && opt){
    var txt = String(opt.textContent || "").trim();
    descripcion = txt.indexOf("—") >= 0 ? txt.split("—").slice(1).join("—").trim() : txt;
  }
  if(!descripcion && codigo){
    var found = equiposCache.find(function(e){ return String(e.codigo || "").trim() === codigo; });
    if(found) descripcion = String(found.descripcion || "").trim();
  }
  return { codigo: codigo, descripcion: descripcion };
}

function addFila(item,tbody){
  item=item||{};tbody=tbody||document.getElementById("tbody");
  var tr=document.createElement("tr");
  var eqOpts=buildEquipoOpts(item.categoria, item.ubicacion, item.equipo_cod||"");
  var ubicHtml='<input class="ci ubic-in" value="'+esc(item.ubicacion||"")+'" placeholder="Ubicación" onchange="onUbicChange(this)">';
  tr.innerHTML=
    '<td><select class="ci csel" onchange="onCC(this,false)" title="'+esc(item.categoria||"")+'">'+bCO(item.categoria)+'</select></td>'+
    '<td><select class="ci tsel" title="'+esc(item.tipo||"")+'">'+bTO(item.categoria,item.tipo)+'</select></td>'+
    '<td><select class="ci">'+bLO(item.labor)+'</select></td>'+
    '<td><input class="ci" value="'+esc(item.descripcion||"")+'" placeholder="Descripción"></td>'+
    '<td class="ubic-td">'+ubicHtml+'</td>'+
    '<td><select class="ci eq-sel" onchange="onEquipoChange(this)">'+eqOpts+'</select></td>'+
    '<td><input class="ci mn" data-rol="cant" value="'+(item.cantidad||"")+'" type="number" min="0" step="0.01" oninput="calcT()"></td>'+
    '<td><input class="ci mn" data-rol="prec" value="'+(item.precio||"")+'" type="number" min="0" step="0.01" oninput="calcT()"></td>'+
    '<td><div class="tl" data-tl style="font-family:var(--font-mono);font-size:0.875rem;text-align:right;">$ 0.00</div></td>'+
    '<td style="text-align:center"><button class="btn brd" style="padding:4px;" onclick="delF(this)">✕</button></td>';
  tbody.appendChild(tr);updEmpty();updCnt();calcT();
  if(item.categoria && (item.categoria.toLowerCase().indexOf("invernadero")>=0 || item.categoria.toLowerCase().indexOf("mec")>=0)){
    actualizarUbicCell(tr, item.categoria, item.ubicacion||"", false);
  }
}
function onCC(sel,dp){
  var tr=sel.closest("tr"), cat=sel.value;
  tr.querySelector(".tsel").innerHTML=bTO(cat,"");
  actualizarUbicCell(tr, cat, "", dp);
  if(dp)dpCalcT();else calcT();
}
function actualizarUbicCell(tr, cat, selVal, dp){
  var sede = (currentEditOT&&currentEditOT.sede)||(OT&&OT.sede)||"";
  var td = tr.querySelector(".ubic-td"); if(!td) return;
  var eqSel = tr.querySelector(".eq-sel");
  var currentEq = eqSel ? String(eqSel.value || "").trim() : "";
  var esInv = cat && cat.toLowerCase().indexOf("invernadero") >= 0;
  var esMec = cat && cat.toLowerCase().indexOf("mec") >= 0;

  function renderUbic(lista, placeholder){
    if(lista && lista.length){
      var opts='<option value="">'+esc(placeholder)+'</option>';
      lista.forEach(function(u){ opts+='<option value="'+esc(u)+'"'+(u===selVal?' selected':'')+'>'+esc(u)+'</option>'; });
      td.innerHTML='<select class="ci ubic-sel" onchange="onUbicChange(this)">'+opts+'</select>';
    } else {
      td.innerHTML='<input class="ci ubic-in" value="'+esc(selVal)+'" placeholder="Ubicación" onchange="onUbicChange(this)">';
    }
    if(eqSel) eqSel.innerHTML=buildEquipoOpts(cat, selVal, currentEq);
    if(dp) dpCalcT(); else calcT();
  }
  if(esInv){ cargarUbicaciones(sede, cat, function(lista){ renderUbic(lista, "— Bloque —"); }); } 
  else if(esMec){ cargarUbicMecanicos(sede, function(lista){ renderUbic(lista, "— Ubicación —"); }); } 
  else {
    td.innerHTML='<input class="ci ubic-in" value="'+esc(selVal)+'" placeholder="Ubicación" onchange="onUbicChange(this)">';
    if(eqSel) eqSel.innerHTML=buildEquipoOpts(cat, selVal, currentEq);
    if(dp) dpCalcT(); else calcT();
  }
}
function onUbicChange(inp){
  var tr=inp.closest("tr"), catSel=tr.querySelector(".csel"), eqSel=tr.querySelector(".eq-sel");
  var currentEq = eqSel ? String(eqSel.value || "").trim() : "";
  if(eqSel&&catSel) eqSel.innerHTML=buildEquipoOpts(catSel.value, inp.value, currentEq);
}
function onEquipoChange(sel){
  var tr = sel.closest("tr"); if(!tr) return;
  var opt = sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0] : null;
  var desc = opt ? String(opt.getAttribute("data-desc") || "").trim() : "";
  sel.setAttribute("data-desc", desc);
}
function getUbicVal(tr){ var s=tr.querySelector(".ubic-sel"); if(s) return s.value; var i=tr.querySelector(".ubic-in"); return i?i.value:""; }
function delF(btn){btn.closest("tr").remove();updEmpty();updCnt();calcT()}
function clearT(){if(!confirm("¿Limpiar todo?"))return;document.getElementById("tbody").innerHTML="";updEmpty();updCnt();calcT()}
function updEmpty(){document.getElementById("tempty").style.display=document.getElementById("tbody").rows.length===0?"block":"none"}
function updCnt(){document.getElementById("nit").textContent=document.getElementById("tbody").rows.length}
function calcT(){
  var rows=document.querySelectorAll("#tbody tr"),sub=0;
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
  var rows=document.querySelectorAll("#tbody tr");
  if(!rows.length){toast("⚠️ Agrega al menos un ítem","err2");return}
  var items=[];
  rows.forEach(function(r){
    var ins=r.querySelectorAll("input"), catS2=r.querySelector(".csel"), tipS2=r.querySelector(".tsel"), labS2=r.querySelectorAll("select")[2];
    var eqData=getEquipoSelData(r);
    items.push({ot_id:OT.ot_id, categoria:catS2?catS2.value:"", tipo:tipS2?tipS2.value:"", labor:labS2?labS2.value:"", descripcion:ins[0]?ins[0].value.trim():"", ubicacion:getUbicVal(r).trim(), cantidad:(r.querySelector("[data-rol='cant']")||{value:"0"}).value||"0", precio:(r.querySelector("[data-rol='prec']")||{value:"0"}).value||"0", equipo_cod:eqData.codigo, equipo_desc:eqData.descripcion, sede:OT.sede||"", empresa:OT.empresa||"", centro_costos:OT.centro_costos||"", fecha_ot:OT.fecha||""});
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
  document.getElementById("clas").innerHTML='<option value="">— Selecciona sede primero —</option>'; document.getElementById("clas").disabled=true;
  document.getElementById("cc").innerHTML='<option value="">— Selecciona clasificación —</option>'; document.getElementById("cc").disabled=true;
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
  document.getElementById("de_clas").value=ot.clasificacion||"";document.getElementById("de_cc").value=ot.centro_costos||"";
  document.getElementById("de_ptot").value=ot.precio_total||"";document.getElementById("de_est").value=ot.estado||"PENDIENTE";
  document.getElementById("de_obs").value=ot.observaciones||"";
  var lnk=document.getElementById("de_link");lnk.href=ot.archivo_pdf||"#";lnk.textContent=ot.archivo_pdf?"Abrir documento PDF":"No hay archivo adjunto";
  var ac=document.getElementById("dpActas");
  if(ot.actas&&ot.actas.length){
    ac.className="";ac.innerHTML="";
    ot.actas.forEach(function(a){ac.innerHTML+='<div style="display:flex;align-items:center;gap:0.5rem;background:var(--bg-hover);padding:0.5rem;border-radius:var(--radius-sm);margin-bottom:0.25rem;border:1px solid var(--border-color);"><span style="font-size:1rem;">'+fIco(a.nombre)+'</span><span style="flex:1;font-size:0.75rem;font-family:var(--font-mono)">'+esc(a.nombre)+'</span><a href="'+esc(a.url)+'" target="_blank" class="btn bgh" style="font-size:0.75rem;padding:4px 8px;">Ver</a></div>'})
  } else {ac.className="lst-st";ac.
