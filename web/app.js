/**
 * The tumour review tool — front end.
 *
 * This is the same viewer and editor the Flask build has, with one layer
 * replaced. Where it used to `fetch('/api/...')`, it now calls into
 * lib/backend.js, which does the same work locally against IndexedDB. Nothing
 * about the three-plane viewer, the editing tools, the review flow or the
 * keyboard shortcuts changed, because none of that ever depended on there
 * being a server -- it depended on getting a volume and a mask, which it still
 * does.
 *
 * The parts that DID depend on a server are the ones to look for below:
 *
 *   segmenting      was upload-then-poll; now runs in this tab, and the DICOM
 *                   never leaves the machine
 *   "Open in ITK-SNAP"  was subprocess.Popen on the server; now downloads the
 *                   case as a zip, because a web page cannot start a program
 *   "Check for edits"   was re-reading a shared folder; now imports mask files
 *                   the user picks
 *   storage         was a results folder on disk; now this browser's storage,
 *                   which is a real difference and is said so in the header
 */
import * as Backend from './lib/backend.js';
import { fileNames } from './lib/pipeline.js';

const $ = s => document.querySelector(s);
let STATE=null, SEL=null, SLICE=0, OVERLAY=true;
let FILTER='all', SORT='priority', QUERY='';

/* Preferences that should survive a reload. Nothing here affects any number
   that gets stored -- these are display and workflow settings only. */
const PREFS = Object.assign({
  opacity:55, radius:6, autoNext:false, threeUp:true, crosshair:true,
  square:false, brush3d:false, adaptTol:8, freehandAuto:true,
}, JSON.parse(localStorage.getItem('mriseg.prefs') || '{}'));
const savePrefs = () => localStorage.setItem('mriseg.prefs', JSON.stringify(PREFS));

// There is no server to lose contact with any more, so the old offline banner
// is now the storage banner: the one comparable way this build can quietly
// stop being able to keep your work. It shows when the browser refuses
// persistent storage, which means results can be evicted under disk pressure.
function setStorageWarning(msg){
  const el = $('#offline');
  if(!el) return;
  el.style.display = msg ? 'block' : 'none';
  if(msg) el.innerHTML = msg;
}

function download(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  // Revoking immediately cancels the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const fmt = v => v==null ? '—' : (+v).toFixed(2)+' mm³';
const human = b => b<1024 ? b+' B'
  : b<1048576 ? (b/1024).toFixed(0)+' KB'
  : b<1073741824 ? (b/1048576).toFixed(1)+' MB'
  : (b/1073741824).toFixed(2)+' GB';

function toast(msg, bad){
  const el = document.createElement('div');
  el.className = 'toast'+(bad?' bad':''); el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(()=>{ el.style.opacity=0; setTimeout(()=>el.remove(),250); }, 3600);
  return el;
}

function toastUndo(msg, undo){
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span>`;
  const b = document.createElement('button');
  b.textContent = 'Undo';
  b.style.cssText = 'margin-left:12px;background:transparent;border:1px solid '
    + 'rgba(255,255,255,.4);color:#fff;padding:2px 9px;font-size:12px';
  b.onclick = async () => { el.remove(); try{ await undo(); }catch(e){ toast(e.message,true); } };
  el.appendChild(b);
  $('#toasts').appendChild(el);
  setTimeout(()=>{ el.style.opacity=0; setTimeout(()=>el.remove(),250); }, 6000);
}

/* ======================= staging ======================= */
// Files are grouped into scan folders in the browser, before anything is sent,
// so the queue shows real scan names rather than a file count. The grouping key
// is the path component just above DICOM/ -- that is the session folder no
// matter whether the user picked one scan, a parent folder of scans, or
// dragged in a mixture of both.
const STAGED = new Map();      // key -> {name, files:[{file,path}], bytes}

function sessionKey(rel){
  const parts = rel.split('/');
  const i = parts.findIndex(p => p.toUpperCase()==='DICOM');
  if(i > 0) return parts.slice(0, i).join('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '(loose files)';
}

function addFiles(items){          // items: [{file, path}]
  let added=0, skipped=0;
  for(const it of items){
    if(!it.path.toLowerCase().endsWith('.dcm')){ skipped++; continue; }
    const key = sessionKey(it.path);
    if(!STAGED.has(key)) STAGED.set(key, {name:key, files:[], bytes:0});
    const g = STAGED.get(key);
    if(g.files.some(f => f.path === it.path)) continue;   // same folder twice
    g.files.push(it); g.bytes += it.file.size; added++;
  }
  renderStaged();
  if(added) toast(`Added ${added} DICOM file${added>1?'s':''}`
      + (skipped?` (skipped ${skipped} non-DICOM)`:''));
  else if(skipped) toast(`No DICOM files found in that selection`, true);
}

function renderStaged(){
  const groups = [...STAGED.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const box = $('#staged');
  if(!groups.length){ box.style.display='none'; $('#btnUpload').disabled=true;
    $('#btnPickMore').style.display='none'; $('#uploadHint').textContent='';
    return; }
  box.style.display='block';
  $('#btnPickMore').style.display='';
  const bytes = groups.reduce((s,g)=>s+g.bytes,0);
  const files = groups.reduce((s,g)=>s+g.files.length,0);
  $('#stCount').textContent = `${groups.length} scan folder${groups.length>1?'s':''} queued`;
  $('#stSize').textContent = `${files} files · ${human(bytes)}`;
  $('#stagedList').innerHTML = groups.map(g=>{
    const short = g.name.split('/').pop();
    const ok = g.files.length >= 2;
    return `<div class="st ${ok?'':'bad'}">
      <span class="nm" title="${g.name}">${short}</span>
      <span class="sz">${g.files.length} files · ${human(g.bytes)}</span>
      <button class="ghost" data-k="${encodeURIComponent(g.name)}">✕</button>
    </div>`;
  }).join('');
  $('#stagedList').querySelectorAll('button').forEach(b=>{
    b.onclick = () => { STAGED.delete(decodeURIComponent(b.dataset.k)); renderStaged(); };
  });
  $('#btnUpload').disabled = false;
  $('#uploadHint').textContent = bytes > 500*1048576
    ? 'Large upload — this will take a while.' : '';
}

$('#btnPick').onclick = $('#btnPickMore').onclick = () => $('#picker').click();
$('#picker').onchange = e => {
  addFiles([...e.target.files].map(f => ({file:f, path:f.webkitRelativePath||f.name})));
  e.target.value = '';           // so picking the same folder again re-fires
};
$('#btnClear').onclick = () => { STAGED.clear(); renderStaged(); };

/* drag and drop, including whole directory trees */
const drop = $('#drop');
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e=>{
  e.preventDefault(); drop.classList.add('hot'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e=>{
  e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', async e => {
  const entries = [...e.dataTransfer.items]
      .map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if(!entries.length) return;
  toast('Reading folders…');
  const out = [];
  for(const en of entries) await walkEntry(en, '', out);
  addFiles(out);
});
async function walkEntry(entry, prefix, out){
  if(entry.isFile){
    const file = await new Promise((res,rej)=>entry.file(res,rej));
    out.push({file, path: prefix + entry.name});
  } else if(entry.isDirectory){
    const reader = entry.createReader();
    // readEntries returns at most 100 per call, so it must be drained in a loop
    // or large scan folders silently lose files.
    let batch;
    do {
      batch = await new Promise((res,rej)=>reader.readEntries(res,rej));
      for(const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
    } while(batch.length);
  }
}

/* ======================= running the model =======================
   The Flask build uploaded every DICOM to a server and polled a background
   thread. Here the work happens in this tab, against files the browser already
   has. Two consequences worth knowing:

     * nothing is uploaded, so no scan leaves this machine. That is what makes
       it safe to host this page publicly -- the page is static, and the data
       stays put.
     * the work is on the main thread, so the pipeline yields between scans
       (see backend.run) or the progress bar would never paint. */
$('#btnUpload').onclick = async () => {
  const groups = [...STAGED.values()];
  if(!groups.length) return;
  $('#upErr').innerHTML=''; $('#btnUpload').disabled = true;

  const entries = groups.flatMap(g => g.files);
  showProgress('Reading scans', 'decoding DICOM…', null);
  try{
    await Backend.run(entries, {
      minVoxels: parseInt($('#minVox').value, 10) || 0,
      onTick: job => {
        if(!job.running) return;
        showProgress('Segmenting', `${job.current} — ${job.done} of ${job.total}`,
                     job.total ? 100*job.done/job.total : null);
      },
    });
    const job = Backend.STATE.job;
    job.log.forEach(l => toast(l, l.startsWith('FAILED')));
    const ok = job.total - job.log.length;
    toast(`Segmented ${ok} scan${ok===1?'':'s'}`);
    STAGED.clear(); renderStaged();
    hideProgress();
    await refresh();
  }catch(e){
    hideProgress();
    $('#upErr').innerHTML = `<div class="err">${e.message}</div>`;
    toast(e.message, true);
  }finally{
    $('#btnUpload').disabled = false;
  }
};

function showProgress(title, detail, pct){
  $('#progress').style.display='block';
  $('#progText').textContent = title;
  $('#progCur').textContent = detail || '';
  const wrap = $('#progBarWrap');
  if(pct==null){ wrap.classList.add('indet'); $('#progPct').textContent=''; }
  else { wrap.classList.remove('indet'); $('#progBar').style.width = pct+'%';
         $('#progPct').textContent = Math.round(pct)+'%'; }
}
function hideProgress(){ $('#progress').style.display='none'; }

/* ======================= state ======================= */
const humanBytes = b => b==null ? '—'
  : b<1048576 ? (b/1024).toFixed(0)+' KB'
  : b<1073741824 ? (b/1048576).toFixed(0)+' MB'
  : (b/1073741824).toFixed(2)+' GB';

async function refresh(){
  STATE = Backend.state();
  $('#hdrMeta').textContent = `${STATE.cases.length} scans`;

  const s = STATE.storage;
  const pol = s.policy || {};
  $('#outDirLabel').innerHTML = STATE.cases.length
    ? `Stored in this browser: ${humanBytes(s.used)} used · kept `
      + `<strong>${pol.lifetime || 'until cleared'}</strong>`
    : 'Nothing stored in this browser yet';
  // How long results survive is a per-browser policy, and the answers differ by
  // a lot -- indefinitely on Chrome with persistence, seven days on Safari
  // whatever you do. Someone three hours into reviewing a cohort should hear
  // which one applies to them before it matters, not after.
  setStorageWarning(pol.level === 'warn' && STATE.cases.length
    ? `Results here are kept <strong>${pol.lifetime}</strong>. ${pol.note}`
    : null);

  const b = $('#stubBanner');
  if(STATE.model && !STATE.model_is_real){
    b.style.display='block';
    b.textContent = `⚠ STUB MODEL (${STATE.model}) — these masks are synthetic, `
      + `generated from the image data as a hash, not by segmenting it. `
      + `They are not real predictions. Do not record these volumes.`;
  } else b.style.display='none';

  renderModelCard();

  const has = STATE.cases.length>0;
  $('#main').style.display = has ? 'grid' : 'none';
  $('#setup').style.display = has ? 'none' : 'block';
  renderReviewProgress();
  if(has){ renderFilters(); renderList(); }
}

/* ======================= case list ======================= */
function visibleCases(){
  let cs = [...STATE.cases];
  if(QUERY) cs = cs.filter(c => c.case.toLowerCase().includes(QUERY));
  if(FILTER==='review') cs = cs.filter(c => c.review?.band!=='low'
                                        && c.review_status==='pending');
  if(FILTER==='flagged') cs = cs.filter(c => c.review_status==='flagged');
  if(FILTER==='edited')  cs = cs.filter(c => c.edited);
  if(FILTER==='empty')   cs = cs.filter(c => !c.tumor_present);
  if(FILTER==='pending') cs = cs.filter(c => c.review_status==='pending');
  const vol = c => c.corrected_volume_mm3 ?? c.auto_volume_mm3 ?? 0;
  if(SORT==='priority') cs.sort((a,b)=>(b.review?.score||0)-(a.review?.score||0));
  if(SORT==='name')     cs.sort((a,b)=>a.case.localeCompare(b.case));
  if(SORT==='volume')   cs.sort((a,b)=>vol(b)-vol(a));
  if(SORT==='volumeAsc')cs.sort((a,b)=>vol(a)-vol(b));
  return cs;
}

function renderFilters(){
  const cs = STATE.cases;
  const defs = [
    ['all','All',cs.length],
    ['review','Needs review',cs.filter(c=>c.review?.band!=='low'&&c.review_status==='pending').length],
    ['pending','Unreviewed',cs.filter(c=>c.review_status==='pending').length],
    ['flagged','Flagged',cs.filter(c=>c.review_status==='flagged').length],
    ['edited','Edited',cs.filter(c=>c.edited).length],
    ['empty','No tumour',cs.filter(c=>!c.tumor_present).length],
  ];
  $('#filters').innerHTML = defs.map(([k,l,n])=>
    `<button data-f="${k}" class="${FILTER===k?'on':''}">${l} ${n}</button>`).join('');
  $('#filters').querySelectorAll('button').forEach(b=>{
    b.onclick = () => { FILTER=b.dataset.f; renderFilters(); renderList(); };
  });
}

function renderList(){
  const cases = visibleCases();
  $('#list').innerHTML = cases.length ? cases.map(c=>{
    const band = c.review?.band || 'low';
    const st = c.review_status;
    const chips = [
      st!=='pending' ? `<span class="chip ${st}">${st}</span>` : '',
      c.edited ? `<span class="chip edited">edited</span>` : ''
    ].join('');
    const vol = c.tumor_present ? fmt(c.corrected_volume_mm3 ?? c.auto_volume_mm3)
                                : 'no tumour';
    return `<div class="caseitem ${SEL===c.case?'sel':''}" data-c="${encodeURIComponent(c.case)}">
      <span class="dot ${band}" title="review priority: ${band}"></span>
      <span style="flex:1;min-width:0">
        <div class="nm">${c.case}</div>
        <div class="sub">${vol} · ${c.n_slices} slices ${chips}</div>
      </span></div>`;
  }).join('') : '<div class="empty">Nothing matches that filter.</div>';
  $('#list').querySelectorAll('.caseitem').forEach(el=>{
    el.onclick = ()=> select(decodeURIComponent(el.dataset.c));
  });
  if(SEL) renderDetail();
}

// The QC montage's object URL, held so it can be revoked when the case changes.
let QC_URL = null;
function releaseQC(){ if(QC_URL){ URL.revokeObjectURL(QC_URL); QC_URL = null; } }

function select(name){
  if(name===SEL) return;
  if(!edConfirmLeave()) return;      // never drop unsaved strokes silently
  if(ED.on) edExit();
  releaseQC();
  SEL=name; SLICE=0;
  ZOOM.scale=1; ZOOM.x=0; ZOOM.y=0;   // a new scan starts at fit-to-window
  RULERS.clear();   // measurements belong to the scan they were drawn on
  renderList(); renderDetail();
  const el=$('.caseitem.sel'); if(el) el.scrollIntoView({block:'nearest'});
}

function step(delta){
  const cs = visibleCases(); if(!cs.length) return;
  const i = cs.findIndex(c=>c.case===SEL);
  select(cs[Math.max(0, Math.min(cs.length-1, (i<0?0:i+delta)))].case);
}

/* ======================= the volume =======================
One fetch per scan, then everything is a local array lookup: slice rendering,
the coronal and sagittal reformats, window/level, and the adaptive brush. See
the long note in src/app.py for why this replaced per-slice PNGs.

VOL.img holds intensities rescaled to 0-65535; vmin/vmax are the scanner's real
numbers, kept so the readout can quote them rather than an internal integer.
VOL.mask is one byte per voxel and IS the live editable mask -- the editor
writes into it in place, so every pane shows an edit the moment it happens.
*/
const VOL = {name:null, nx:0, ny:0, nz:0, sx:1, sy:1, sz:1,
             img:null, mask:null, vmin:0, vmax:1, hist:null, base:0};
const CUR = {x:0, y:0};       // crosshair within the axial plane; z is SLICE
const WL  = {lo:0, hi:65535}; // display window, in stored units

const vIndex = (x,y,z) => (z*VOL.ny + y)*VOL.nx + x;
// A stored value turned back into the number the scanner recorded.
const realVal = u => VOL.vmin + u/65535*(VOL.vmax - VOL.vmin);

async function loadVolume(name){
  if(VOL.name === name && VOL.img && VOL.mask) return;
  if(VOL.name !== name || !VOL.img){
    const {data, meta} = await Backend.volumeRaw(name);
    Object.assign(VOL, meta, {img:data, name, mask:null});
    CUR.x = Math.floor(VOL.nx/2); CUR.y = Math.floor(VOL.ny/2);
    autoWindow();
  }
  if(!VOL.mask){
    const {data} = await Backend.maskRaw(name);
    VOL.mask = data;
    VOL.base = countOn(data);      // voxel count as it stands in storage
  }
}

// Drop the cached mask so the next render re-reads it. Used after a save, an
// interpolate or a revert -- anything that rewrote the stored mask.
function invalidateMask(){ VOL.mask = null; }

/* Auto window: 1st to 99.5th percentile, the same range the QC images use, so
   what you see here and what lands in derived/qc/ agree. Computed from the
   256-bin histogram that comes with the volume rather than by sorting 1.1M
   voxels. */
function autoWindow(){
  const h = VOL.hist;
  if(!h || !h.length){ WL.lo = 0; WL.hi = 65535; return; }
  const total = h.reduce((a,b)=>a+b, 0);
  const at = frac => {
    let acc = 0;
    for(let i=0;i<h.length;i++){ acc += h[i];
      if(acc >= total*frac) return (i+0.5)/h.length*65535; }
    return 65535;
  };
  WL.lo = at(0.01); WL.hi = Math.max(at(0.995), WL.lo + 1);
}

const wlWidth  = () => WL.hi - WL.lo;
const wlCentre = () => (WL.hi + WL.lo)/2;
function setWL(centre, width){
  width = Math.max(8, width);
  WL.lo = centre - width/2; WL.hi = centre + width/2;
  renderAllPanes(); updateWLReadout();
}

/* ======================= plane geometry =======================
Each pane is a canvas at NATIVE voxel resolution for its plane, stretched by CSS
to its true physical shape. That split matters: painting maps a pointer to a
voxel with no resampling, while the display still shows 1.10 mm slices as 1.10 mm
rather than squashing them to the same height as a 0.16 mm in-plane row.

The reformats are built from the axial stack, so they are guaranteed to line up
with the mask. They are NOT the separately acquired T2 coronal series -- that
one is a different acquisition on its own grid, and mixing the two would put the
mask in the wrong place.
*/
const PLANES = {
  axial:    {label:'axial',    ids:'ax',
             W:()=>VOL.nx, H:()=>VOL.ny, PW:()=>VOL.nx*VOL.sx, PH:()=>VOL.ny*VOL.sy,
             idx:(u,v)=>vIndex(u, v, SLICE),
             depth:()=>VOL.nz, at:()=>SLICE},
  coronal:  {label:'coronal',  ids:'co',
             W:()=>VOL.nx, H:()=>VOL.nz, PW:()=>VOL.nx*VOL.sx, PH:()=>VOL.nz*VOL.sz,
             idx:(u,v)=>vIndex(u, CUR.y, v),
             depth:()=>VOL.ny, at:()=>CUR.y},
  sagittal: {label:'sagittal', ids:'sa',
             W:()=>VOL.ny, H:()=>VOL.nz, PW:()=>VOL.ny*VOL.sy, PH:()=>VOL.nz*VOL.sz,
             idx:(u,v)=>vIndex(CUR.x, u, v),
             depth:()=>VOL.nx, at:()=>CUR.x},
};

// Where the crosshair falls in a given pane, in that pane's own (u,v).
function crossIn(plane){
  if(plane==='axial')   return [CUR.x, CUR.y];
  if(plane==='coronal') return [CUR.x, SLICE];
  return [CUR.y, SLICE];
}
// The reverse: a click at (u,v) in a pane, as a whole-volume voxel.
function voxelFrom(plane, u, v){
  if(plane==='axial')   return [u, v, SLICE];
  if(plane==='coronal') return [u, CUR.y, v];
  return [CUR.x, u, v];
}

function renderPane(plane){
  const P = PLANES[plane];
  const img = $('#'+P.ids+'Img'), msk = $('#'+P.ids+'Msk');
  if(!img || !msk || !VOL.img) return;
  const w = P.W(), h = P.H();
  if(img.width !== w || img.height !== h){
    img.width = msk.width = w; img.height = msk.height = h;
    const ovr = $('#'+P.ids+'Ovr');
    if(ovr){ ovr.width = w; ovr.height = h; }
  }
  const gi = img.getContext('2d'), gm = msk.getContext('2d');
  const di = gi.createImageData(w, h), dm = gm.createImageData(w, h);
  const a = di.data, b = dm.data;
  const lo = WL.lo, span = Math.max(WL.hi - WL.lo, 1);
  const V = VOL.img, M = VOL.mask;

  for(let v=0; v<h; v++){
    for(let u=0; u<w; u++){
      const k = P.idx(u, v), o = (v*w+u)<<2;
      let g = (V[k] - lo)/span*255;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      a[o] = a[o+1] = a[o+2] = g; a[o+3] = 255;
      if(M && M[k]){
        // Edge voxels get near-full alpha so the boundary reads clearly even
        // with the fill turned right down -- which is how you actually judge
        // whether a mask is correct.
        const edge = u===0 || v===0 || u===w-1 || v===h-1
          || !M[P.idx(u-1,v)] || !M[P.idx(u+1,v)]
          || !M[P.idx(u,v-1)] || !M[P.idx(u,v+1)];
        b[o] = 255; b[o+1] = 45; b[o+2] = 45; b[o+3] = edge ? 235 : 110;
      }
    }
  }
  gi.putImageData(di, 0, 0);
  gm.putImageData(dm, 0, 0);
  msk.style.opacity = maskOpacity();
  drawPaneOverlay(plane);
}

/* The overlay layer carries everything that is not image or mask: the linked
   crosshair, rulers, and the in-progress polygon. Keeping it separate is what
   lets an unaccepted outline be cancelled with zero trace, and lets the mask
   opacity slider not fade the crosshair along with it. */
function drawPaneOverlay(plane){
  const P = PLANES[plane];
  const cv = $('#'+P.ids+'Ovr'); if(!cv) return;
  const g = cv.getContext('2d');
  const w = P.W(), h = P.H();
  g.clearRect(0, 0, w, h);

  if(PREFS.crosshair !== false){
    const [cx, cy] = crossIn(plane);
    const lw = Math.max(0.35, 0.8/Math.max(1, plane==='axial'?ZOOM.scale:1));
    g.strokeStyle = 'rgba(80,220,255,.75)'; g.lineWidth = lw;
    const gap = Math.max(3, Math.round(Math.min(w,h)*0.03));
    g.beginPath();
    g.moveTo(0, cy+.5); g.lineTo(Math.max(0,cx-gap), cy+.5);
    g.moveTo(Math.min(w,cx+gap), cy+.5); g.lineTo(w, cy+.5);
    g.moveTo(cx+.5, 0); g.lineTo(cx+.5, Math.max(0,cy-gap));
    g.moveTo(cx+.5, Math.min(h,cy+gap)); g.lineTo(cx+.5, h);
    g.stroke();
  }
  drawRulers(plane, g);
  if(plane === 'axial') drawPoly(g);
}

function renderAllPanes(){
  renderPane('axial');
  if(PREFS.threeUp){ renderPane('coronal'); renderPane('sagittal'); }
  updatePaneLabels();
  edStats();
}

function updatePaneLabels(){
  const l1 = $('#axLab');
  if(l1) l1.textContent = `axial · slice ${SLICE+1} / ${VOL.nz}`;
  const l2 = $('#coLab');
  if(l2) l2.textContent = `coronal (reformat) · row ${CUR.y+1} / ${VOL.ny}`;
  const l3 = $('#saLab');
  if(l3) l3.textContent = `sagittal (reformat) · column ${CUR.x+1} / ${VOL.nx}`;
  const sc = $('#scrub'); if(sc) sc.value = SLICE;
  const badge = $('#hasMask');
  if(badge && VOL.mask){
    let any = false;
    const n = VOL.nx*VOL.ny, off = SLICE*n;
    for(let i=0;i<n;i++) if(VOL.mask[off+i]){ any = true; break; }
    badge.style.display = any ? 'block' : 'none';
  }
}

/* ======================= rulers =======================
ITK-SNAP's annotation tool, reduced to the part that gets used: drop two points,
get a distance. Lengths are computed from the voxel spacing, so a ruler drawn on
a coronal reformat measures true millimetres through the 1.10 mm slice
direction rather than counting slices. Rulers are display only -- they are never
written to the mask or to any table. */
const RULERS = new Map();      // "plane:index" -> [{a:[u,v], b:[u,v]}]
const rulerKey = plane => `${plane}:${PLANES[plane].at()}`;
const paneMM = plane => plane==='axial'   ? [VOL.sx, VOL.sy]
                      : plane==='coronal' ? [VOL.sx, VOL.sz]
                                          : [VOL.sy, VOL.sz];
function rulerLen(plane, r){
  const [mu, mv] = paneMM(plane);
  return Math.hypot((r.b[0]-r.a[0])*mu, (r.b[1]-r.a[1])*mv);
}
function drawRulers(plane, g){
  const rs = RULERS.get(rulerKey(plane)) || [];
  const scale = plane==='axial' ? Math.max(1, ZOOM.scale) : 1;
  g.lineWidth = Math.max(0.4, 1/scale);
  g.strokeStyle = '#fde047'; g.fillStyle = '#fde047';
  g.font = `${Math.max(6, 9/scale)}px -apple-system, sans-serif`;
  for(const r of rs){
    g.beginPath(); g.moveTo(r.a[0]+.5, r.a[1]+.5); g.lineTo(r.b[0]+.5, r.b[1]+.5);
    g.stroke();
    for(const p of [r.a, r.b]){
      g.beginPath(); g.arc(p[0]+.5, p[1]+.5, Math.max(1, 2/scale), 0, 6.284); g.fill();
    }
    const mid = [(r.a[0]+r.b[0])/2, (r.a[1]+r.b[1])/2];
    g.fillText(rulerLen(plane, r).toFixed(2)+' mm', mid[0]+3, mid[1]-3);
  }
}

/* ======================= display controls =======================
Window and level act on the real intensities, so unlike the CSS brightness and
contrast filter they replaced, they genuinely recover detail that was previously
clipped away by a fixed percentile windowing. They are still display only:
they never touch the mask, the volume, or anything that gets stored.
*/
function updateWLReadout(){
  const o = $('#outWL');
  if(o) o.textContent = `${Math.round(realVal(wlCentre()))} ± ${
    Math.round((realVal(WL.hi)-realVal(WL.lo))/2)}`;
  const wc = $('#ctLevel'), ww = $('#ctWindow');
  if(wc) wc.value = wlCentre();
  if(ww) ww.value = wlWidth();
  const o3 = $('#outOpacity'); if(o3) o3.textContent = PREFS.opacity+'%';
}

function bindDisplay(){
  const lv=$('#ctLevel'), wd=$('#ctWindow'), o=$('#ctOpacity'), r=$('#ctReset');
  if(lv) lv.oninput = e => setWL(+e.target.value, wlWidth());
  if(wd) wd.oninput = e => setWL(wlCentre(), +e.target.value);
  if(o) o.oninput = e => { PREFS.opacity=+e.target.value; savePrefs();
    for(const p of ['ax','co','sa']){
      const m = $('#'+p+'Msk'); if(m) m.style.opacity = maskOpacity(); }
    updateWLReadout(); };
  if(r) r.onclick = () => {
    autoWindow(); PREFS.opacity=55; savePrefs();
    if(o) o.value=55;
    renderAllPanes(); updateWLReadout();
    toast('Display reset to the automatic window');
  };
  updateWLReadout();
}

// "Hide mask" is a review gesture -- it answers "would I have drawn a boundary
// there?". It must NOT survive into the editor, where painting onto an
// invisible mask is how someone loses an afternoon.
function maskOpacity(){ return (ED.on || OVERLAY) ? PREFS.opacity/100 : 0; }

function refreshOverlayOpacity(){
  for(const p of ['ax','co','sa']){
    const m = $('#'+p+'Msk');
    if(m) m.style.opacity = maskOpacity();
  }
}

function bindPointerReadout(){
  const box = $('#canvas'), read = $('#posRead'), dot = $('#brushDot');
  if(!box) return;
  box.addEventListener('pointermove', e => {
    const layer = $('#axImg');
    if(!layer || !VOL.img) return;
    const r = layer.getBoundingClientRect();
    const vx = Math.floor((e.clientX - r.left) / r.width  * VOL.nx);
    const vy = Math.floor((e.clientY - r.top)  / r.height * VOL.ny);
    const inside = vx>=0 && vy>=0 && vx<VOL.nx && vy<VOL.ny;
    if(read){
      read.style.display = inside ? 'block' : 'none';
      if(inside) read.textContent =
        `x ${vx}  y ${vy}  slice ${SLICE+1}   ${
          Math.round(realVal(VOL.img[vIndex(vx,vy,SLICE)]))}`;
    }
    if(dot){
      const brushy = ED.on && ['brush','eraser','adaptive'].includes(ED.tool);
      if(brushy && inside){
        // Brush radius is in voxels; scale it to however big a voxel is on
        // screen right now, so the circle stays truthful at any zoom.
        const px = (r.width / VOL.nx) * ED.radius;
        dot.style.display = 'block';
        dot.style.borderRadius = ED.square ? '2px' : '50%';
        dot.style.width = dot.style.height = (px*2)+'px';
        const b = box.getBoundingClientRect();
        dot.style.left = (e.clientX - b.left - px)+'px';
        dot.style.top  = (e.clientY - b.top  - px)+'px';
      } else dot.style.display = 'none';
    }
  });
  box.addEventListener('pointerleave', () => {
    if(read) read.style.display='none';
    if(dot) dot.style.display='none';
  });
}

/* ======================= zoom and pan =======================
Implemented as a CSS transform on the displayed layer rather than by
re-rendering at a higher resolution. That matters for the editor: the brush
maps pointer position to voxels through getBoundingClientRect(), which already
reports the post-transform box, so painting stays pixel-accurate at any zoom
with no extra maths. Re-rendering at each zoom level would have meant tracking
a separate view transform and reconciling the two.

Zoom is intentionally NOT on the plain scroll wheel -- that scrubs slices,
which is the far more common action. Cmd/Ctrl held turns it into zoom, matching
how maps and image viewers behave.
*/
const ZOOM = {scale:1, x:0, y:0, panning:false, from:null};
const MAX_ZOOM = 12;

// Zoom applies to the axial pane only. The coronal and sagittal reformats are
// small orientation views; zooming them independently would be three sets of
// pan state to keep straight for no gain.
function zoomTarget(){ return $('#axWrap'); }

function zoomClamp(){
  const box = $('#canvas');
  if(!box) return;
  // Keep at least the centre of the image on screen; at scale 1 it is pinned.
  const w = box.clientWidth, h = box.clientHeight;
  const mx = Math.max(0, (ZOOM.scale-1) * w / 2);
  const my = Math.max(0, (ZOOM.scale-1) * h / 2);
  ZOOM.x = Math.max(-mx, Math.min(mx, ZOOM.x));
  ZOOM.y = Math.max(-my, Math.min(my, ZOOM.y));
}

function zoomApply(){
  zoomClamp();
  const el = zoomTarget();
  if(el) el.style.transform =
    `translate(${ZOOM.x}px, ${ZOOM.y}px) scale(${ZOOM.scale})`;
  const lab = $('#zoomPct');
  if(lab) lab.textContent = Math.round(ZOOM.scale*100) + '%';
  const rb = $('#zReset'); if(rb) rb.disabled = (ZOOM.scale === 1 && !ZOOM.x && !ZOOM.y);
}

function zoomAt(clientX, clientY, factor){
  const box = $('#canvas'); if(!box) return;
  const r = box.getBoundingClientRect();
  // Position of the cursor relative to the element's centre, which is where
  // the transform origin sits.
  const cx = clientX - r.left - r.width/2;
  const cy = clientY - r.top  - r.height/2;
  const next = Math.max(1, Math.min(MAX_ZOOM, ZOOM.scale * factor));
  const k = next / ZOOM.scale;
  // Hold the point under the cursor still while the scale changes.
  ZOOM.x = cx - k*(cx - ZOOM.x);
  ZOOM.y = cy - k*(cy - ZOOM.y);
  ZOOM.scale = next;
  if(ZOOM.scale === 1){ ZOOM.x = 0; ZOOM.y = 0; }
  zoomApply();
}

function zoomStep(factor){
  const box = $('#canvas'); if(!box) return;
  const r = box.getBoundingClientRect();
  zoomAt(r.left + r.width/2, r.top + r.height/2, factor);   // zoom about centre
}

function zoomReset(){ ZOOM.scale=1; ZOOM.x=0; ZOOM.y=0; zoomApply(); }

function zoomBind(){
  const box = $('#canvas'); if(!box) return;
  zoomApply();
  if($('#zIn'))    $('#zIn').onclick    = () => zoomStep(1.25);
  if($('#zOut'))   $('#zOut').onclick   = () => zoomStep(1/1.25);
  if($('#zReset')) $('#zReset').onclick = zoomReset;

  // Middle-drag, or any drag while zoomed in view mode, pans. In edit mode a
  // plain drag has to stay reserved for painting, so panning needs the middle
  // button or the space bar.
  box.addEventListener('pointerdown', e => {
    const wantPan = e.button === 1 || SPACE_DOWN ||
                    (!ED.on && ZOOM.scale > 1 && e.button === 0);
    if(!wantPan) return;
    e.preventDefault();
    ZOOM.panning = true; ZOOM.from = [e.clientX, e.clientY, ZOOM.x, ZOOM.y];
    box.classList.add('panning');
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', e => {
    if(!ZOOM.panning) return;
    ZOOM.x = ZOOM.from[2] + (e.clientX - ZOOM.from[0]);
    ZOOM.y = ZOOM.from[3] + (e.clientY - ZOOM.from[1]);
    zoomApply();
  });
  const endPan = () => { ZOOM.panning=false; box.classList.remove('panning'); };
  box.addEventListener('pointerup', endPan);
  box.addEventListener('pointercancel', endPan);
}

let SPACE_DOWN = false;

/* ======================= mask editor =======================
Painting happens at NATIVE VOXEL RESOLUTION on a canvas that CSS only scales up
for display. Every stroke is converted to voxel indices before it touches
anything, so what gets saved is exactly what was drawn -- no resampling, no
half-voxel drift, and the result still sits on the scan's grid and still opens
in ITK-SNAP.

Edits go to the working mask, the same file ITK-SNAP writes. The automated mask
is never touched, so correction tracking treats an in-app edit and an ITK-SNAP
edit identically.
*/
const ED = {
  on:false,
  dirty:new Set(),     // slices changed since the last save
  undo:[], redo:[],
  tool:'freehand', radius:6, painting:false, last:null,
  square:false, brush3d:false, adaptTol:8,
  subtract:false,          // whether the outline tools add or take away
  poly:[], polyDrag:-1, polyFresh:false, lastPoly:null, tracing:false,
  ruler:null,              // the ruler being dragged out right now
};

const countOn = m => { let n=0; for(let i=0;i<m.length;i++) if(m[i]) n++; return n; };

// The mask for one slice, as a view onto the volume rather than a copy -- so a
// stroke written here is immediately visible in the coronal and sagittal panes
// too, which is the whole point of having them.
const sliceMask = z => VOL.mask.subarray(z*VOL.nx*VOL.ny, (z+1)*VOL.nx*VOL.ny);

const edRepaint = () => renderAllPanes();

function edStats(){
  const c = STATE.cases.find(x=>x.case===SEL);
  if(!c || !VOL.mask) return;
  const vox = countOn(VOL.mask);
  const el = $('#edStats2');
  if(el) el.innerHTML = `${vox} voxels · ${(vox*c.voxel_volume_mm3).toFixed(2)} mm³`
    + (ED.dirty.size ? ` <span class="dirty">● ${ED.dirty.size} unsaved</span>` : '');
}

/* ---- polygon: outline a region, then fill it -----------------------------
This is the tool ITK-SNAP leads with, and for tracing a tumour boundary it is
far quicker than brushing: a dozen clicks around the edge beats painting the
interior. Vertices can be dragged before accepting, and the last accepted
polygon can be pasted onto the next slice and nudged -- which is what makes
slice-by-slice tracing fast, because a tumour barely changes between slices.

Nothing touches the mask until Accept. The outline lives on its own canvas so
cancelling is guaranteed to leave no trace.
*/
function polyReset(){ ED.poly = []; ED.polyDrag = -1; polyDraw(); }
function polyDraw(){ drawPaneOverlay('axial'); polyHint(); }

function drawPoly(g){
  const p = ED.poly || [];
  if(!p.length) return;
  const scale = Math.max(1, ZOOM.scale);
  g.lineWidth = Math.max(0.5, 1.4/scale);
  g.strokeStyle = '#38bdf8';
  g.fillStyle = 'rgba(56,189,248,.16)';
  g.beginPath();
  g.moveTo(p[0][0]+.5, p[0][1]+.5);
  for(let i=1;i<p.length;i++) g.lineTo(p[i][0]+.5, p[i][1]+.5);
  if(p.length > 2){ g.closePath(); g.fill(); }
  g.stroke();
  // A freehand trace is a smooth curve with no editable vertices -- drawing
  // hundreds of handles on it would be noise. ITK-SNAP draws the same
  // distinction between a smooth curve and a polygon.
  if(!ED.tracing && ED.tool === 'polygon'){
    const r = Math.max(1, 2.4/scale);
    for(let i=0;i<p.length;i++){
      g.beginPath(); g.arc(p[i][0]+.5, p[i][1]+.5, r, 0, 6.284);
      g.fillStyle = i===0 ? '#fbbf24' : '#38bdf8'; g.fill();
    }
  }
}

function polyHint(){
  const hint = $('#polyHint'); if(!hint) return;
  const p = ED.poly || [];
  if(ED.tool === 'freehand'){
    hint.textContent = !p.length
      ? 'Press and drag right round the tumour boundary. Let go and it fills.'
      : `${p.length} points traced.` + (PREFS.freehandAuto ? '' : ' Accept to fill.');
    return;
  }
  hint.textContent = !p.length
    ? 'Click points around the edge. Drag between points to trace freehand.'
    : p.length < 3
      ? `${p.length} point${p.length>1?'s':''} — at least 3 are needed.`
      : `${p.length} points. Drag to move one, shift-click to delete, click an `
        + `edge to insert. Then Accept.`;
}

// Even-odd scanline fill. Works for concave outlines and self-intersections,
// which hand-drawn ones frequently are.
function polyFill(pts, value){
  if(!VOL.mask || pts.length < 3) return 0;
  const m = sliceMask(SLICE), nx = VOL.nx, ny = VOL.ny;
  let minY = Infinity, maxY = -Infinity;
  for(const p of pts){ minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(ny-1, Math.ceil(maxY));
  let n = 0;
  for(let y=minY; y<=maxY; y++){
    const xs = [];
    for(let i=0, j=pts.length-1; i<pts.length; j=i++){
      const [xi,yi] = pts[i], [xj,yj] = pts[j];
      if((yi > y) !== (yj > y)) xs.push(xi + (y-yi)/(yj-yi)*(xj-xi));
    }
    xs.sort((a,b)=>a-b);
    for(let k=0; k+1<xs.length; k+=2){
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(nx-1, Math.floor(xs[k+1]));
      for(let x=x0; x<=x1; x++){ if(m[y*nx+x]!==value){ m[y*nx+x]=value; n++; } }
    }
  }
  return n;
}

function polyAccept(quiet){
  if(!ED.poly || ED.poly.length < 3){
    if(!quiet) toast('Need at least 3 points', true);
    return;
  }
  edPushUndo();
  const n = polyFill(ED.poly, ED.subtract ? 0 : 1);
  ED.lastPoly = ED.poly.map(p => [...p]);   // remembered for Paste last
  ED.dirty.add(SLICE);
  polyReset(); edRepaint();
  toast(`${ED.subtract ? 'Removed' : 'Filled'} ${n} voxels`);
}

function polyPaste(){
  if(!ED.lastPoly || ED.lastPoly.length < 3)
    return toast('No polygon to paste yet — accept one first', true);
  ED.poly = ED.lastPoly.map(p => [...p]);
  polyDraw();
  toast('Pasted. Nudge the points, then Accept.');
}

/* ---- flood fill ---------------------------------------------------------
Click an enclosed gap to fill it, or click a blob in subtract mode to delete
that blob entirely. Both are things that would otherwise take a lot of careful
brushing. */
function floodFill(sx, sy, value){
  if(!VOL.mask) return 0;
  const m = sliceMask(SLICE), nx = VOL.nx, ny = VOL.ny;
  if(sx<0||sy<0||sx>=nx||sy>=ny) return 0;
  const from = m[sy*nx+sx];
  if(from === value) return 0;
  const stack = [sy*nx+sx];
  let n = 0;
  while(stack.length){
    const p = stack.pop();
    if(m[p] !== from) continue;
    m[p] = value; n++;
    const x = p % nx, y = (p - x) / nx;
    if(x > 0)    stack.push(p-1);
    if(x < nx-1) stack.push(p+1);
    if(y > 0)    stack.push(p-nx);
    if(y < ny-1) stack.push(p+nx);
  }
  return n;
}

/* The brush. Round or square, and optionally spherical in 3D.

   The 3D reach is worth understanding before it surprises anyone: it is
   computed in MILLIMETRES, not voxels. In-plane voxels are 0.16 mm and slices
   sit 1.10 mm apart, so a brush that spans 6 voxels on screen is under a
   millimetre wide and reaches no further than the current slice. That is the
   physically honest answer for this data, not a bug -- the toolbar prints the
   actual slice reach so it is never a mystery. */
function brushReachZ(){
  return ED.brush3d ? Math.floor(ED.radius*VOL.sx/VOL.sz) : 0;
}

function edStamp(cx, cy, erase){
  if(!VOL.mask) return;
  const r = ED.radius, nx = VOL.nx, ny = VOL.ny, rz = brushReachZ();
  const rmm = r*VOL.sx;
  for(let dz=-rz; dz<=rz; dz++){
    const z = SLICE+dz;
    if(z < 0 || z >= VOL.nz) continue;
    // Shrink the in-plane radius with distance from the centre slice, so a 3D
    // brush is a ball rather than a cylinder.
    const shrink = rz ? Math.sqrt(Math.max(0, 1 - Math.pow(dz*VOL.sz/rmm, 2))) : 1;
    const rr = r*shrink, rr2 = rr*rr, off = z*nx*ny;
    for(let y=Math.max(0,Math.ceil(cy-rr)); y<=Math.min(ny-1,Math.floor(cy+rr)); y++){
      const dy = y-cy;
      for(let x=Math.max(0,Math.ceil(cx-rr)); x<=Math.min(nx-1,Math.floor(cx+rr)); x++){
        const dx = x-cx;
        if(!ED.square && dx*dx+dy*dy > rr2) continue;
        VOL.mask[off+y*nx+x] = erase ? 0 : 1;
      }
    }
    ED.dirty.add(z);
  }
}

/* Adaptive brush: within the brush footprint, paint only what is CONTIGUOUS
   with the voxel under the cursor and CLOSE TO IT IN INTENSITY. Straddle the
   tumour boundary and only the tumour side fills.

   Be clear about what this is: ITK-SNAP's adaptive brush builds watershed
   supervoxels and is steered by "granularity" and "smoothness". This is a
   region grow with an intensity tolerance. The behaviour is the one the
   ITK-SNAP manual describes, the algorithm underneath is not the same, and the
   tolerance slider is not the same knob. It is a convenience, and anything it
   produces still has to survive the same review as everything else. */
function edAdaptive(cx, cy, erase){
  if(!VOL.mask || !VOL.img) return 0;
  const nx = VOL.nx, ny = VOL.ny, off = SLICE*nx*ny;
  if(cx<0||cy<0||cx>=nx||cy>=ny) return 0;
  const seed = VOL.img[off + cy*nx + cx];
  // Tolerance is a percentage of the DISPLAYED window, so "similar looking"
  // and "similar valued" stay in step when the window is changed.
  const tol = ED.adaptTol/100 * Math.max(WL.hi - WL.lo, 1);
  const r = ED.radius, r2 = r*r, side = 2*r+1;
  const seen = new Uint8Array(side*side);
  const stack = [cx, cy];
  let n = 0;
  while(stack.length){
    const y = stack.pop(), x = stack.pop();
    if(x<0 || y<0 || x>=nx || y>=ny) continue;
    const dx = x-cx, dy = y-cy;
    if(Math.abs(dx) > r || Math.abs(dy) > r) continue;
    if(!ED.square && dx*dx+dy*dy > r2) continue;
    const s = (dy+r)*side + (dx+r);
    if(seen[s]) continue;
    seen[s] = 1;
    if(Math.abs(VOL.img[off+y*nx+x] - seed) > tol) continue;
    const p = off+y*nx+x;
    if(VOL.mask[p] !== (erase?0:1)){ VOL.mask[p] = erase?0:1; n++; }
    stack.push(x+1,y, x-1,y, x,y+1, x,y-1);
  }
  ED.dirty.add(SLICE);
  return n;
}

/* Scalpel: a thin erased line straight through the mask, splitting whatever it
   crosses into two pieces. Pair it with Fill in subtract mode to delete the
   piece you did not want -- which is how you get rid of a lobe the model
   merged in, without brushing along the whole boundary by hand. */
function edCut(x0,y0,x1,y1){
  if(!VOL.mask) return;
  const m = sliceMask(SLICE), nx = VOL.nx, ny = VOL.ny;
  const steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0), 1);
  for(let i=0;i<=steps;i++){
    const t = i/steps;
    const cx = Math.round(x0+(x1-x0)*t), cy = Math.round(y0+(y1-y0)*t);
    for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
      const x=cx+dx, y=cy+dy;
      if(x>=0 && y>=0 && x<nx && y<ny) m[y*nx+x] = 0;
    }
  }
  ED.dirty.add(SLICE);
}

async function edInterpolate(){
  const c = STATE.cases.find(x=>x.case===SEL); if(!c || !VOL.mask) return;
  const drawn = [];
  const n = VOL.nx*VOL.ny;
  for(let z=0; z<VOL.nz; z++){
    const off = z*n;
    for(let i=0;i<n;i++) if(VOL.mask[off+i]){ drawn.push(z); break; }
  }
  const below = [...drawn].reverse().find(i => i < SLICE - 1);
  const above = drawn.find(i => i > SLICE + 1);
  const other = (SLICE - (below ?? -99)) <= ((above ?? 999) - SLICE) ? below : above;
  if(other === undefined || other === null)
    return toast('Draw on another slice at least two away, then interpolate', true);

  if(ED.dirty.size){
    if(!confirm('Interpolating works on the saved mask, so this slice will be '
                + 'saved first. Continue?')) return;
    await edSave();
  }
  try{
    const j = await Backend.interpolate(SEL, SLICE, other);
    invalidateMask();
    toast(`Filled slices ${j.filled.map(i=>i+1).join(', ')} — volume now ${
      (+j.corrected_volume_mm3).toFixed(2)} mm³`);
    await refresh();
  }catch(e){ toast(e.message, true); }
}

function edStroke(x0,y0,x1,y1,erase){
  // Pointer events fire far apart during a fast drag; without interpolation a
  // quick stroke lands as a row of disconnected dots.
  const steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0), 1);
  for(let i=0;i<=steps;i++){
    const t = i/steps;
    edStamp(Math.round(x0+(x1-x0)*t), Math.round(y0+(y1-y0)*t), erase);
  }
}

/* Undo snapshots the whole mask volume. At 18 x 256 x 248 that is 1.1 MB a
   step, so the history is capped at 25 -- about 28 MB, which is nothing next to
   losing a slice of hand tracing. Snapshotting per slice was cheaper but got
   the 3D brush and interpolation wrong, because those touch several slices at
   once and undo would only have put one of them back. */
function edPushUndo(){
  if(!VOL.mask) return;
  ED.undo.push({data:new Uint8Array(VOL.mask), dirty:new Set(ED.dirty)});
  if(ED.undo.length > 25) ED.undo.shift();
  ED.redo.length = 0;
}

function edApplySnapshot(stack, other){
  const s = stack.pop();
  if(!s) return toast(stack === ED.undo ? 'Nothing to undo' : 'Nothing to redo');
  other.push({data:new Uint8Array(VOL.mask), dirty:new Set(ED.dirty)});
  VOL.mask.set(s.data);
  ED.dirty = s.dirty;
  edRepaint();
}

async function edEnter(){
  ED.on = true;
  ED.dirty.clear();
  ED.undo.length = 0; ED.redo.length = 0;
  ED.poly = []; ED.polyDrag = -1;
  ED.tool = PREFS.tool || 'freehand';
  ED.radius = PREFS.radius;
  ED.square = !!PREFS.square;
  ED.brush3d = !!PREFS.brush3d;
  ED.adaptTol = PREFS.adaptTol;
  await loadVolume(SEL);
  renderDetail();
}

function edExit(){
  ED.on = false;
  ED.dirty.clear();
  ED.undo.length = 0; ED.redo.length = 0;
  ED.poly = [];
  invalidateMask();     // re-read from disk; anything unsaved is gone by design
  renderDetail();
}

const edUnsaved = () => ED.on && ED.dirty.size > 0;
const edConfirmLeave = () => !edUnsaved() ||
  confirm(`${ED.dirty.size} edited slice(s) are not saved. Discard them?`);

/* ======================= pane interaction =======================
Every pane gets the same handler. Which tool runs depends on two things: whether
the editor is on, and whether this is the axial pane.

Editing is AXIAL ONLY, deliberately. The reformats are 18 voxels tall -- a
tumour that spans three slices is three rows there. Letting someone paint into
that would write across the whole stack from a view where a single misplaced
pixel is a whole slice of tumour. They navigate instead, which is what they are
actually good for: see the tumour's extent from the side, click the slice that
looks wrong, and land on it in the axial editor.
*/
function paneVoxel(plane, e){
  const P = PLANES[plane];
  const cv = $('#'+P.ids+'Ovr');
  const r = cv.getBoundingClientRect();
  const u = Math.floor((e.clientX-r.left)/r.width  * P.W());
  const v = Math.floor((e.clientY-r.top) /r.height * P.H());
  return [Math.max(0, Math.min(P.W()-1, u)), Math.max(0, Math.min(P.H()-1, v))];
}

function moveCrosshair(plane, u, v){
  const [x, y, z] = voxelFrom(plane, u, v);
  CUR.x = Math.max(0, Math.min(VOL.nx-1, x));
  CUR.y = Math.max(0, Math.min(VOL.ny-1, y));
  const nz = Math.max(0, Math.min(VOL.nz-1, z));
  if(nz !== SLICE && window._setSlice) window._setSlice(nz);
  else renderAllPanes();
}

function bindPane(plane){
  const P = PLANES[plane];
  const cv = $('#'+P.ids+'Ovr');
  if(!cv || cv._bound) return;
  cv._bound = true;

  const editable = () => ED.on && plane === 'axial';

  cv.addEventListener('pointerdown', e => {
    if(e.button !== 0 || SPACE_DOWN) return;   // space is reserved for panning
    const [u, v] = paneVoxel(plane, e);

    if(!editable() || ED.tool === 'cross'){
      // Zoomed in and not editing, a plain drag pans -- so the crosshair moves
      // on RELEASE, and only if the pointer stayed put. Acting on pointerdown
      // would yank the crosshair to wherever a pan happened to start.
      cv._click = [e.clientX, e.clientY, plane, u, v];
      return;
    }
    cv.setPointerCapture(e.pointerId);
    const p = [u, v];

    if(ED.tool === 'ruler'){
      ED.ruler = {a:p, b:p};
      ED.painting = true; drawPaneOverlay('axial');
      return;
    }

    if(ED.tool === 'freehand'){
      ED.poly = [p]; ED.tracing = true; ED.painting = true;
      polyDraw();
      return;
    }

    if(ED.tool === 'polygon'){
      ED.tracing = false;
      const tol = Math.max(2, Math.round(4/Math.max(1, ZOOM.scale)));
      const hit = (ED.poly||[]).findIndex(q =>
        Math.abs(p[0]-q[0]) <= tol && Math.abs(p[1]-q[1]) <= tol);
      if(hit >= 0){
        // Shift-click removes a vertex; ITK-SNAP calls this trimming. Plain
        // click grabs it to drag.
        if(e.shiftKey){ ED.poly.splice(hit, 1); polyDraw(); return; }
        ED.polyDrag = hit; ED.polyFresh = false;
      } else {
        const seg = nearestSegment(p, tol*1.5);
        if(seg >= 0){
          // Clicking an edge inserts a point there -- ITK-SNAP's split.
          ED.poly.splice(seg+1, 0, p); ED.polyDrag = seg+1; ED.polyFresh = false;
        } else {
          ED.poly.push(p); ED.polyDrag = ED.poly.length-1; ED.polyFresh = true;
        }
      }
      ED.painting = true; polyDraw();
      return;
    }

    if(ED.tool === 'fill'){
      edPushUndo();
      const n = floodFill(p[0], p[1], ED.subtract ? 0 : 1);
      // An unenclosed background click would flood the whole slice. Undo it
      // rather than leaving someone to work out what just happened.
      if(n > VOL.nx*VOL.ny*0.35){
        edApplySnapshot(ED.undo, ED.redo);
        toast('That area is not enclosed — nothing filled', true);
        return;
      }
      ED.dirty.add(SLICE); edRepaint();
      toast(`${ED.subtract ? 'Removed' : 'Filled'} ${n} voxels`);
      return;
    }

    edPushUndo(); ED.painting = true; ED.last = p;
    // Holding Alt inverts the tool. Far quicker than going to the toolbar and
    // back for a two-voxel fix, which is most of what correction actually is.
    const erase = ED.tool === 'scalpel' ? true : (ED.tool==='eraser') !== e.altKey;
    if(ED.tool === 'scalpel')      edCut(p[0], p[1], p[0], p[1]);
    else if(ED.tool === 'adaptive') edAdaptive(p[0], p[1], erase);
    else                            edStamp(p[0], p[1], erase);
    ED.dirty.add(SLICE); edRepaint();
  });

  cv.addEventListener('pointermove', e => {
    if(!ED.painting || !editable()) return;
    const p = paneVoxel(plane, e);

    if(ED.tool === 'ruler'){ ED.ruler.b = p; drawPaneOverlay('axial'); return; }

    if(ED.tool === 'freehand'){
      const last = ED.poly[ED.poly.length-1];
      if(!last || Math.abs(p[0]-last[0]) > 0 || Math.abs(p[1]-last[1]) > 0)
        ED.poly.push(p);
      polyDraw();
      return;
    }
    if(ED.tool === 'polygon'){
      // Dragging straight after placing a point traces freehand from it;
      // dragging an existing point moves it.
      if(ED.polyFresh && ED.polyDrag === ED.poly.length-1){
        const last = ED.poly[ED.poly.length-1];
        if(Math.abs(p[0]-last[0]) > 1 || Math.abs(p[1]-last[1]) > 1) ED.poly.push(p);
      } else if(ED.polyDrag >= 0){
        ED.poly[ED.polyDrag] = p;
      }
      polyDraw();
      return;
    }
    if(ED.tool === 'scalpel')       edCut(ED.last[0], ED.last[1], p[0], p[1]);
    else if(ED.tool === 'adaptive') edAdaptive(p[0], p[1], (ED.tool==='eraser') !== e.altKey);
    else edStroke(ED.last[0], ED.last[1], p[0], p[1],
                  (ED.tool==='eraser') !== e.altKey);
    ED.last = p; edRepaint();
  });

  const stop = e => {
    if(cv._click){
      const c0 = cv._click; cv._click = null;
      if(e && Math.hypot(e.clientX-c0[0], e.clientY-c0[1]) < 4)
        moveCrosshair(c0[2], c0[3], c0[4]);
      return;
    }
    if(ED.tool === 'ruler' && ED.ruler){
      const r = ED.ruler; ED.ruler = null;
      if(Math.hypot(r.b[0]-r.a[0], r.b[1]-r.a[1]) >= 2){
        const k = rulerKey('axial');
        if(!RULERS.has(k)) RULERS.set(k, []);
        RULERS.get(k).push(r);
        toast(`${rulerLen('axial', r).toFixed(2)} mm`);
      }
      drawPaneOverlay('axial');
    }
    // A freehand trace is finished when the button comes up. ITK-SNAP still
    // asks for Accept; here that is a preference, default off, because "trace
    // it and it fills" is what people expect from a lasso.
    if(ED.tool === 'freehand' && ED.tracing){
      ED.tracing = false;
      if(PREFS.freehandAuto) polyAccept(true);
      else polyHint();
    }
    ED.painting = false; ED.last = null;
    ED.polyDrag = -1; ED.polyFresh = false;
  };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);

  // Scrolling a reformat moves the plane it shows, so you can sweep through the
  // volume from the side. The axial pane keeps its own handler, which also
  // owns cmd-scroll zoom.
  if(plane !== 'axial'){
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const d = e.deltaY > 0 ? 1 : -1;
      if(plane === 'coronal') CUR.y = Math.max(0, Math.min(VOL.ny-1, CUR.y+d));
      else                    CUR.x = Math.max(0, Math.min(VOL.nx-1, CUR.x+d));
      renderAllPanes();
    }, {passive:false});
  }
}

// Index of the polygon edge that point p lies closest to, or -1.
function nearestSegment(p, tol){
  const pts = ED.poly || [];
  if(pts.length < 2) return -1;
  let best = -1, bestD = tol;
  for(let i=0;i<pts.length;i++){
    const a = pts[i], b = pts[(i+1)%pts.length];
    const vx = b[0]-a[0], vy = b[1]-a[1];
    const len2 = vx*vx+vy*vy;
    if(!len2) continue;
    let t = ((p[0]-a[0])*vx + (p[1]-a[1])*vy)/len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p[0]-(a[0]+t*vx), p[1]-(a[1]+t*vy));
    if(d < bestD){ bestD = d; best = i; }
  }
  return best;
}

function bindEditorToolbar(){
  const pick = t => () => {
    ED.tool = t;
    if(t!=='polygon' && t!=='freehand') polyReset();
    PREFS.tool = t; savePrefs(); renderDetail();
  };
  const on = (id, fn) => { const el = $(id); if(el) el.onclick = fn; };
  on('#tFree',  pick('freehand'));
  on('#tPoly',  pick('polygon'));
  on('#tBrush', pick('brush'));
  on('#tAdapt', pick('adaptive'));
  on('#tErase', pick('eraser'));
  on('#tFill',  pick('fill'));
  on('#tCut',   pick('scalpel'));
  on('#tRuler', pick('ruler'));
  on('#tCross', pick('cross'));
  on('#tMode',  () => { ED.subtract = !ED.subtract; renderDetail(); });
  on('#tShape', () => { ED.square = !ED.square; PREFS.square = ED.square;
                        savePrefs(); renderDetail(); });
  on('#t3d',    () => { ED.brush3d = !ED.brush3d; PREFS.brush3d = ED.brush3d;
                        savePrefs(); renderDetail(); });
  on('#tInterp', edInterpolate);
  on('#pAccept', () => polyAccept());
  on('#pCancel', () => { polyReset(); toast('Outline discarded'); });
  on('#pPaste',  polyPaste);
  on('#pUndoPt', () => { (ED.poly||[]).pop(); polyDraw(); });
  on('#tUndo',   () => edApplySnapshot(ED.undo, ED.redo));
  on('#tRedo',   () => edApplySnapshot(ED.redo, ED.undo));
  on('#tClear',  () => { edPushUndo(); sliceMask(SLICE).fill(0);
                         ED.dirty.add(SLICE); edRepaint(); });
  on('#tCopyPrev', () => edCopyFrom(SLICE-1));
  on('#tCopyNext', () => edCopyFrom(SLICE+1));
  on('#tDiscard', () => { if(edConfirmLeave()) edExit(); });
  on('#tSave', edSave);
  on('#tRulerClear', () => {
    RULERS.delete(rulerKey('axial')); drawPaneOverlay('axial');
    toast('Rulers cleared on this slice');
  });
  const sz = $('#tSize');
  if(sz) sz.oninput = e => {
    ED.radius = +e.target.value; PREFS.radius = ED.radius; savePrefs();
    const s = $('#edSize'); if(s) s.textContent = brushLabel();
  };
  const tol = $('#tTol');
  if(tol) tol.oninput = e => {
    ED.adaptTol = +e.target.value; PREFS.adaptTol = ED.adaptTol; savePrefs();
    const s = $('#edTol'); if(s) s.textContent = ED.adaptTol+'%';
  };
  const fa = $('#tFreeAuto');
  if(fa) fa.onchange = e => { PREFS.freehandAuto = e.target.checked; savePrefs();
                              polyHint(); };
}

// The brush size in voxels means little on its own -- 6 voxels is 0.97 mm here.
// Printing both, plus how far a 3D brush actually reaches, stops the toolbar
// number from being a mystery.
function brushLabel(){
  const mm = (ED.radius*VOL.sx).toFixed(2);
  const rz = brushReachZ();
  return `${ED.radius} vx · ${mm} mm` + (ED.brush3d ? ` · ±${rz} slice${rz===1?'':'s'}` : '');
}

function edCopyFrom(j){
  if(j < 0 || j > VOL.nz-1) return toast('No slice there', true);
  edPushUndo();
  sliceMask(SLICE).set(sliceMask(j));
  ED.dirty.add(SLICE); edRepaint();
  toast(`Copied the mask from slice ${j+1}`);
}

async function edSave(){
  if(!ED.dirty.size) return toast('Nothing to save');
  // Slices go across as raw bytes now rather than base64. The Flask build had
  // to encode them because they travelled through JSON; nothing here does.
  const slices = {};
  for(const i of ED.dirty) slices[i] = sliceMask(i).slice();
  try{
    const j = await Backend.saveMaskSlices(SEL, slices);
    toast(`Saved ${j.n_slices_written} slice(s) — volume now ${
      (+j.corrected_volume_mm3).toFixed(2)} mm³`);
    ED.dirty.clear();
    VOL.base = countOn(VOL.mask);
    await refresh();
  }catch(e){ toast(e.message, true); }
}

/* ======================= detail ======================= */
function paneHTML(plane, id, innerId, extra){
  const P = PLANES[plane];
  return `<div class="pane" id="${id}" style="aspect-ratio:${P.PW()}/${P.PH()}">
      <div class="pinner"${innerId?` id="${innerId}"`:''}>
        <canvas class="px" id="${P.ids}Img"></canvas
        ><canvas class="px" id="${P.ids}Msk"></canvas
        ><canvas id="${P.ids}Ovr"></canvas>
      </div>
      ${extra||''}
      <div class="plab" id="${P.ids}Lab"></div>
    </div>`;
}

function toolbarHTML(){
  const b = (id, key, label, tool, title) =>
    `<button id="${id}" class="${ED.tool===tool?'on':''}" title="${title}">${label}</button>`;
  const brushy = ['brush','eraser','adaptive'].includes(ED.tool);
  return `
    <div id="edBar">
      ${b('tFree','F','✎ Freehand','freehand','F — trace round the boundary and let go')}
      ${b('tPoly','P','◇ Polygon','polygon','P — click points, adjust them, then Accept')}
      ${b('tBrush','B','● Brush','brush','B — paint voxels')}
      ${b('tAdapt','A','◐ Adaptive','adaptive','A — paint only what matches the intensity under the cursor')}
      ${b('tErase','E','⌫ Erase','eraser','E')}
      ${b('tFill','G','◉ Fill','fill','G — fill an enclosed area, or remove a whole blob')}
      ${b('tCut','X','✂ Cut','scalpel','X — draw a line to cut the mask in two')}
      ${b('tRuler','R','↔ Ruler','ruler','R — drag to measure a distance in mm')}
      ${b('tCross','C','✛ Navigate','cross','C — move the crosshair without painting')}
      <span class="sep"></span>
      <button id="tMode" title="M — whether the outline and fill tools add or take away"
        >${ED.subtract ? '− subtract' : '+ add'}</button>
      ${brushy ? `
      <span class="sep"></span>
      <button id="tShape" title="Round or square brush">${ED.square?'▪ square':'● round'}</button>
      <button id="t3d" class="${ED.brush3d?'on':''}"
        title="Paint a ball through neighbouring slices instead of a disc on this one">3D</button>
      <label>size</label>
      <input type="range" id="tSize" min="1" max="40" value="${ED.radius}">
      <span id="edSize" class="ednum">${brushLabel()}</span>` : ''}
      ${ED.tool==='adaptive' ? `
      <label>tolerance</label>
      <input type="range" id="tTol" min="1" max="60" value="${ED.adaptTol}">
      <span id="edTol" class="ednum">${ED.adaptTol}%</span>` : ''}
      ${ED.tool==='ruler' ? `
      <button id="tRulerClear">Clear rulers on this slice</button>` : ''}
      <span class="sep"></span>
      <button id="tUndo" title="⌘Z">↶</button>
      <button id="tRedo" title="⇧⌘Z">↷</button>
      <span class="sep"></span>
      <button id="tCopyPrev" title="Copy the mask from the slice above">↑ copy</button>
      <button id="tCopyNext" title="Copy the mask from the slice below">↓ copy</button>
      <button id="tInterp" title="Fill in the slices between this one and the last one you drew">⇅ Interpolate</button>
      <button id="tClear">Clear slice</button>
      <span class="spacer"></span>
      <span id="edStats2"></span>
      <span class="sep"></span>
      <button id="tDiscard">Discard</button>
      <button id="tSave" class="primary">Save mask</button>
    </div>
    ${(ED.tool==='polygon' || ED.tool==='freehand') ? `
    <div id="polyBar">
      <span id="polyHint"></span>
      <span class="spacer"></span>
      ${ED.tool==='freehand' ? `<label class="chk"><input type="checkbox"
         id="tFreeAuto" ${PREFS.freehandAuto?'checked':''}> fill when I let go</label>` : ''}
      <button id="pPaste" title="Reuse the last outline you accepted — V">Paste last</button>
      ${ED.tool==='polygon' ? `<button id="pUndoPt" title="Backspace">Remove point</button>` : ''}
      <button id="pCancel" title="Esc">Cancel</button>
      <button id="pAccept" class="primary" title="Enter">Accept ⏎</button>
    </div>` : ''}`;
}

function renderDetail(){
  const c = STATE.cases.find(x=>x.case===SEL);
  if(!c){ $('#detail').innerHTML='<div class="empty">Select a scan.</div>'; return; }
  const r = c.review || {reasons:[],score:0,band:'low'};
  const tsl = c.tumor_slices || [];
  // Open on the middle of the tumour, not the middle of the volume. On an
  // 18-slice stack where the tumour spans three, the middle slice is usually
  // empty and the reviewer has to hunt for what they came to look at.
  if(SLICE===0) SLICE = tsl.length ? tsl[Math.floor(tsl.length/2)]
                                   : Math.floor(c.n_slices/2);

  const volBlock = c.edited
    ? `<div class="big">${fmt(c.corrected_volume_mm3)}</div>
       <div class="meta">corrected by hand · was
         <span class="strike">${fmt(c.auto_volume_mm3)}</span></div>`
    : `<div class="big">${c.tumor_present ? fmt(c.auto_volume_mm3) : 'No tumour'}</div>
       <div class="meta">${c.tumor_present ? 'automated' :
         'the model found nothing — confirm it is genuinely tumour-free'}</div>`;

  // The panes need the volume's real dimensions to size themselves. Before it
  // arrives, fall back to the record so the layout does not jump.
  if(!VOL.img || VOL.name !== SEL){
    VOL.nx = c.size_xyz[0]; VOL.ny = c.size_xyz[1]; VOL.nz = c.n_slices;
    const sp = c.spacing || [1,1,1];
    VOL.sx = sp[0]; VOL.sy = sp[1]; VOL.sz = sp[2];
  }

  $('#detail').innerHTML = `
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap">
      <h2 style="margin:0;font-size:17px">${c.case}</h2>
      <span class="meta">${c.mouse_from_dicom||''} · ${c.study_date||''} ·
        series ${c.series} · ${c.size_xyz.join('×')}</span>
      <span class="spacer"></span>
      <span class="meta">${ED.on
        ? `<kbd>F</kbd> freehand · <kbd>B</kbd> brush · <kbd>[</kbd><kbd>]</kbd> size ·
           <kbd>⌘Z</kbd> undo · <kbd>⌘S</kbd> save · <kbd>alt</kbd> invert`
        : `<kbd>↑</kbd><kbd>↓</kbd> scans · <kbd>←</kbd><kbd>→</kbd> slices ·
           <kbd>A</kbd> accept · <kbd>F</kbd> flag`}
        · <kbd>+</kbd><kbd>−</kbd><kbd>0</kbd> zoom · <kbd>space</kbd> pan</span>
    </div>
    <div class="viewer">
      <div>
        ${ED.on ? toolbarHTML() : ''}
        <div id="panes">
          ${paneHTML('axial', 'canvas', 'axWrap', `
            <div id="hasMask">tumour on this slice</div>
            <div id="posRead"></div>
            <div id="brushDot"></div>
            <div id="zoomBar">
              <button id="zOut" title="Zoom out (−)">−</button>
              <span id="zoomPct">100%</span>
              <button id="zIn" title="Zoom in (+)">+</button>
              <button id="zReset" title="Reset zoom (0)">⟲</button>
            </div>`)}
          <div id="reformats" style="display:${PREFS.threeUp?'grid':'none'}">
            ${paneHTML('coronal','paneCo')}
            ${paneHTML('sagittal','paneSa')}
          </div>
        </div>
        <input type="range" id="scrub" min="0" max="${c.n_slices-1}" value="${SLICE}"
               style="margin-top:10px">
        <div class="ticks ${tsl.length?'':'none'}">${
          tsl.map(i=>`<i style="left:${c.n_slices>1?100*i/(c.n_slices-1):50}%"
             title="slice ${i+1}"></i>`).join('')}</div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap">
          ${ED.on ? '' : `<button id="btnOverlay">${OVERLAY?'Hide':'Show'} mask</button>`}
          ${(!ED.on && tsl.length)?`<button id="btnJump">Jump to tumour</button>`:''}
          <button id="btnEdit" class="${ED.on?'primary':''}">${
            ED.on ? 'Stop editing' : 'Edit mask here'}</button>
          <button id="btnThree" class="${PREFS.threeUp?'primary':''}"
            title="Show the coronal and sagittal reformats (T)">Three planes</button>
          <button id="btnCross" title="Show or hide the linked crosshair (H)"
            >${PREFS.crosshair===false?'Show':'Hide'} crosshair</button>
          <span class="spacer"></span>
          <span class="meta">scroll to change slice · click any pane to move the crosshair</span>
        </div>

        <div class="ctrls">
          <div class="ctrl">
            <label for="ctLevel">Level</label>
            <input type="range" id="ctLevel" min="0" max="65535" value="0">
          </div>
          <div class="ctrl">
            <label for="ctWindow">Window</label>
            <input type="range" id="ctWindow" min="8" max="65535" value="0">
            <output id="outWL"></output>
          </div>
          <div class="ctrl">
            <label for="ctOpacity">Mask</label>
            <input type="range" id="ctOpacity" min="0" max="100" value="${PREFS.opacity}">
            <output id="outOpacity">${PREFS.opacity}%</output>
          </div>
          <button id="ctReset" class="ghost" style="font-size:11.5px">Auto window</button>
          <span class="meta" style="flex:1;text-align:right">display only — never
            changes the mask or the volume</span>
        </div>
        <details style="margin-top:16px" id="qcBox">
          <summary class="meta" style="cursor:pointer">All slices at once</summary>
          <img id="qcImg" alt="QC montage"
               style="width:100%;margin-top:10px;border:1px solid var(--line);border-radius:8px">
        </details>
      </div>

      <div>
        <div class="card" style="margin-bottom:12px;padding:16px">
          ${volBlock}
          <dl class="kv" style="margin-top:12px">
            <dt>Voxels</dt><dd>${c.auto_voxels}</dd>
            <dt>Components</dt><dd>${c.n_components}</dd>
            <dt>Tumour slices</dt><dd>${c.n_tumor_slices} of ${c.n_slices}</dd>
            <dt>Voxel vol</dt><dd>${c.voxel_volume_mm3} mm³</dd>
          </dl>
        </div>

        <div class="card" style="margin-bottom:12px;padding:16px">
          <div class="row" style="justify-content:space-between">
            <strong style="font-size:13px">Needs review</strong>
            <span class="chip ${r.band}" style="text-transform:capitalize">${r.band}</span>
          </div>
          <ul class="reasons">${(r.reasons||[]).map(x=>`<li>${x}</li>`).join('')}</ul>
        </div>

        <div class="card" style="padding:16px">
          <strong style="font-size:13px">Your call</strong>
          <div class="row" style="margin:10px 0">
            <button id="btnAccept" class="${c.review_status==='accepted'?'primary':''}"
              style="flex:1">Looks right</button>
            <button id="btnFlag" class="${c.review_status==='flagged'?'primary':''}"
              style="flex:1">Flag</button>
          </div>
          <textarea id="note" rows="3" style="width:100%"
            placeholder="Note (optional)">${c.review_note||''}</textarea>
          <button id="btnItk" style="width:100%;margin-top:10px">Download for ITK-SNAP</button>
          ${c.edited ? `<button id="btnRevert" style="width:100%;margin-top:8px">
            Revert to the model's mask</button>` : ''}
          <p class="hint" style="margin:8px 0 0;font-size:11.5px;color:var(--muted)">
            Edit here, or download this scan and use ITK-SNAP for the 3D render
            and the snake tool — then bring the mask back with <em>Import
            corrected masks</em> at the top. Either way the original automated
            mask is kept, so corrections stay separable.</p>
          <div id="itkMsg"></div>
        </div>
      </div>
    </div>`;

  // Changing slice no longer re-renders anything but the canvases, because the
  // whole volume is already here. That is what makes scrubbing instant, and it
  // is also why an edit in progress survives a slice change now.
  const setSlice = i => {
    SLICE = Math.max(0, Math.min(i, VOL.nz-1));
    if(ED.on && (ED.poly||[]).length){
      // An outline belongs to the slice it was drawn on, so leaving without
      // accepting discards it -- carrying it over would fill the wrong slice.
      // `lastPoly` survives, so Paste still works.
      ED.poly = [];
      toast('Outline discarded — it was not accepted before changing slice');
    }
    renderAllPanes();
  };
  window._setSlice = setSlice;
  $('#scrub').oninput = e => setSlice(+e.target.value);
  if($('#btnOverlay')) $('#btnOverlay').onclick = () => {
    OVERLAY = !OVERLAY;
    $('#btnOverlay').textContent = (OVERLAY?'Hide':'Show') + ' mask';
    refreshOverlayOpacity();
  };
  if($('#btnJump')) $('#btnJump').onclick =
    () => setSlice(tsl[Math.floor(tsl.length/2)]);
  $('#btnEdit').onclick = () => {
    if(ED.on){ if(edConfirmLeave()) edExit(); }
    else edEnter();
  };
  $('#btnThree').onclick = () => {
    PREFS.threeUp = !PREFS.threeUp; savePrefs(); renderDetail();
  };
  $('#btnCross').onclick = () => {
    PREFS.crosshair = PREFS.crosshair === false; savePrefs(); renderDetail();
  };

  // Scroll wheel / two-finger scroll moves through slices, the way it works in
  // every radiology viewer. deltaY is accumulated rather than acted on
  // directly: a mouse wheel sends one large notch (~100) but a trackpad sends
  // a stream of tiny values, so stepping per event would make the trackpad fly
  // through the whole stack in an instant.
  let wheelAcc = 0;
  const STEP_PX = 30;
  $('#canvas').addEventListener('wheel', e => {
    e.preventDefault();                       // do not scroll the page as well
    if(e.ctrlKey || e.metaKey){
      // Trackpad pinch arrives as ctrl+wheel too, so this covers both.
      zoomAt(e.clientX, e.clientY, Math.pow(1.0035, -e.deltaY));
      return;
    }
    let d = e.deltaY;
    if(e.deltaMode === 1) d *= 16;            // deltas given in lines
    else if(e.deltaMode === 2) d *= 100;      // deltas given in pages
    wheelAcc += d;
    while(Math.abs(wheelAcc) >= STEP_PX){
      const dir = wheelAcc > 0 ? 1 : -1;
      wheelAcc -= dir * STEP_PX;
      const next = SLICE + dir;
      if(next < 0 || next > VOL.nz-1){ wheelAcc = 0; break; }
      setSlice(next);
    }
  }, {passive:false});

  zoomBind();      // zoom survives slice changes; only a new case resets it
  bindPointerReadout();
  if(ED.on) bindEditorToolbar();

  $('#canvas').classList.add('loading');
  loadVolume(SEL).then(() => {
    $('#canvas').classList.remove('loading');
    bindPane('axial');
    if(PREFS.threeUp){ bindPane('coronal'); bindPane('sagittal'); }
    renderAllPanes();
    bindDisplay();
  }).catch(e => {
    $('#canvas').classList.remove('loading');
    toast(e.message, true);
  });

  // The QC montage is a stored blob rather than a URL a server can serve, so an
  // object URL is minted on demand -- and revoked when you move to another
  // scan. Without the revoke, clicking through a cohort holds every montage in
  // memory until the tab is closed.
  const qcImg = $('#qcImg');
  if(qcImg){
    $('#qcBox').addEventListener('toggle', async e => {
      if(!e.target.open || qcImg.src) return;
      const url = await Backend.qcUrl(c.case);
      if(url){ releaseQC(); QC_URL = url; qcImg.src = url; }
      else qcImg.replaceWith(Object.assign(document.createElement('p'),
        {className:'meta', textContent:'No QC image was stored for this scan.'}));
    });
  }

  $('#btnAccept').onclick = () => review('accepted');
  $('#btnFlag').onclick = () => review('flagged');
  $('#note').onchange = e => review(null, e.target.value);

  /* A web page cannot start a program, so this cannot open ITK-SNAP. What it
     can do is put the files where ITK-SNAP will find them: straight into the
     linked folder if there is one, otherwise as a zip to unpack. Both end with
     the same workspace file, which is verified to resolve its layers when
     opened from the folder it sits in. */
  $('#btnItk').onclick = async () => {
    try{
      if(FOLDER.linked){
        const j = await Backend.exportToFolder([SEL]);
        $('#itkMsg').innerHTML =
          `<div class="meta">Written to <code>${j.folder}/${SEL}/</code>. Open `
          + `<code>${fileNames(SEL).workspace}</code> there in ITK-SNAP, correct the `
          + `mask, save it, then press <strong>Check folder for edits</strong>.</div>`;
        toast(`Written to ${j.folder}/${SEL}/`);
        return;
      }
      toast('Packaging this scan…');
      const blob = await Backend.bundleBlob([SEL]);
      download(blob, `${fileNames(SEL).workspace.replace(/\.itksnap$/, '')}_for_itksnap.zip`);
      $('#itkMsg').innerHTML =
        `<div class="meta">Downloaded. Unzip it and open the <code>.itksnap</code> `
        + `workspace in ITK-SNAP (File &gt; Open Workspace — macOS does not `
        + `associate the extension). Correct the mask, save it, then use `
        + `<strong>Import corrected masks</strong> at the top.</div>`;
    }catch(e){ toast(e.message, true); }
  };

  if($('#btnRevert')) $('#btnRevert').onclick = async () => {
    if(!confirm('Discard every correction to this scan and restore the mask '
                + 'the model produced? This cannot be undone.')) return;
    try{
      const j = await Backend.revert(SEL);
      if(ED.on) edExit();
      invalidateMask();
      toast(`Reverted to the model's mask (${(+j.auto_volume_mm3).toFixed(2)} mm³)`);
      await refresh();
    }catch(e){ toast(e.message, true); }
  };
}

async function review(status, note){
  const was = SEL;
  const prev = (STATE.cases.find(x=>x.case===was)||{}).review_status || 'pending';
  const body = {};
  if(status) body.status = status;
  if(note!==undefined && note!==null) body.note = note;
  await Backend.review(was, body);

  if(status){
    // Decisions are one keystroke, so they are easy to make by accident.
    // Offering the way back costs nothing and saves re-reviewing a scan.
    toastUndo(status==='accepted' ? 'Marked as correct' : 'Flagged for follow-up',
      async () => {
        await Backend.review(was, {status:prev});
        await refresh();
        toast('Undone');
      });
  }
  await refresh();
  if(status && PREFS.autoNext) advanceToNextUnreviewed(was);
}

// After a decision, land on the next scan still waiting on one. Falls back to
// simply moving down the list, and says so when the queue is empty rather than
// leaving you wondering why nothing moved.
function advanceToNextUnreviewed(after){
  const cs = visibleCases();
  const i = cs.findIndex(c => c.case === after);
  const rest = cs.slice(i+1).concat(cs.slice(0, Math.max(0,i)));
  const next = rest.find(c => c.review_status === 'pending');
  if(next) select(next.case);
  else toast('Every scan in this view has been reviewed');
}

function renderReviewProgress(){
  const cs = STATE.cases;
  const el = $('#reviewProg');
  if(!el) return;
  if(!cs.length){ el.style.display='none'; return; }
  const done = cs.filter(c => c.review_status !== 'pending').length;
  el.style.display = 'flex';
  $('#reviewBar').style.width = (100*done/cs.length) + '%';
  $('#reviewTxt').textContent = `${done} of ${cs.length} reviewed`;
}

/* ======================= chrome ======================= */
$('#search').oninput = e => { QUERY = e.target.value.toLowerCase(); renderList(); };
$('#sort').onchange = e => { SORT = e.target.value; renderList(); };
$('#btnNew').onclick = () => {
  $('#main').style.display='none'; $('#setup').style.display='block';
};
$('#btnReload').onclick = async () => {
  try{
    const j = await Backend.reload();
    if(!j.loaded) return toast('Nothing is stored in this browser yet', true);
    toast(`Reopened ${j.loaded} scans`); refresh();
  }catch(e){ toast(e.message, true); }
};

/* ======================= the model =======================
   Three states worth telling apart, because they mean very different things
   for whether a number on screen can be written down:

     a trained model is loaded    -- real predictions
     no model is available        -- the stub, and the banner says so
     a model exists but failed    -- also the stub, but for a reason the user
                                     can act on, so the reason is shown

   The picker also offers the trained model without test-time mirroring. That
   is a real speed/accuracy trade (four network passes per slice instead of
   one) and it belongs to the person waiting, not to the code. */
function renderModelCard(){
  const el = $('#modelState'); if(!el) return;
  const info = STATE.model_info;
  const pick = $('#modelPick');

  // `data-state` is the signal the self-test waits on. The card passes through
  // "loading" on every startup, and a test that read the text at the wrong
  // moment would be flaky in a way that looks like a real failure.
  el.dataset.state = info ? 'loaded'
    : STATE.model_loading ? 'loading'
    : STATE.model_error ? 'error' : 'none';

  if(STATE.model_loading && !info){
    el.innerHTML = 'Starting the model…';
  } else if(info){
    const mb = (info.bytes/1e6).toFixed(0);
    const backend = info.backend === 'webgpu'
      ? 'running on the GPU (WebGPU)'
      : 'running on the CPU (WebAssembly) — slower; Chrome or Edge will use the GPU';
    const which = info.config ? ` <code>${info.config}</code>` : '';
    el.innerHTML = `<strong style="color:var(--ok)">Trained model loaded.</strong>`
      + `${which} ${info.precision}, ${mb} MB, ${backend}.`
      + (info.trainer ? ` <span class="meta">${info.trainer}, fold ${info.fold},`
                      + ` epoch ${info.epoch}.</span>` : '');
  } else if(STATE.model_error){
    el.innerHTML = `<strong style="color:var(--bad)">The model could not be `
      + `loaded.</strong> ${STATE.model_error}`;
  } else {
    el.innerHTML = `<strong>No trained model is loaded</strong>, so the tool is `
      + `running on the stub and its masks are synthetic. Load a model folder `
      + `to get real predictions.`;
  }
  if(pick && STATE.model) {
    const v = STATE.model.startsWith('onnx')
      ? (STATE.model.includes('no-tta') ? 'onnx:no-tta' : 'onnx') : 'stub';
    pick.value = v;
    // Offering the trained model when none is loaded would just throw on the
    // next run. Disable rather than let it be picked.
    for(const o of pick.options) if(o.value.startsWith('onnx')) o.disabled = !info;
  }
  renderNetPick();
  const forget = $('#btnForgetModel');
  if(forget) forget.style.display = info ? '' : 'none';
}

// Which network, as opposed to which predictor. A site can serve more than one
// -- a 2D and a 3D model usually differ more in how they fail than in how well
// they score -- so this is a real choice and the note under it says what the
// trade is. With one model served, or none, the whole row stays hidden.
function renderNetPick(){
  const row = $('#netPickRow'), sel = $('#netPick'), note = $('#netNote');
  if(!row || !sel) return;
  const choices = STATE.model_choices || [];
  if(choices.length < 2){ row.style.display = 'none'; if(note) note.style.display='none'; return; }

  const want = choices.map(c => c.id).join('|');
  if(sel.dataset.built !== want){
    sel.innerHTML = '';
    for(const c of choices){
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.label || c.id}  (${(c.bytes/1e6).toFixed(0)} MB)`;
      sel.appendChild(o);
    }
    sel.dataset.built = want;
  }
  row.style.display = '';
  if(STATE.model_id) sel.value = STATE.model_id;
  sel.disabled = !!STATE.model_loading;

  const cur = choices.find(c => c.id === (STATE.model_id || sel.value));
  if(note){
    note.textContent = cur && cur.note ? cur.note : '';
    note.style.display = cur && cur.note ? '' : 'none';
  }
}


$('#netPick').onchange = async e => {
  const id = e.target.value;
  const label = (STATE.model_choices || []).find(c => c.id === id);
  // The first switch downloads tens of megabytes. Say so, because otherwise the
  // card just sits on "Starting the model…" for a while and looks stuck.
  toast(`Loading ${label ? label.label : id}…`);
  try{
    STATE = await Backend.setModelId(id, (done, total) => {
      const el = $('#modelState');
      if(el) el.innerHTML = `Downloading ${(done/1e6).toFixed(0)} of ${(total/1e6).toFixed(0)} MB…`;
    });
    refresh(); renderModelCard();
    toast(`${label ? label.label : id} ready.`);
  }catch(err){ toast(err.message, true); renderModelCard(); }
};

$('#modelPick').onchange = async e => {
  try{ STATE = await Backend.setModel(e.target.value); refresh(); }
  catch(err){ toast(err.message, true); renderModelCard(); }
};

$('#btnLoadModel').onclick = () => $('#modelPicker').click();

$('#modelPicker').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if(!files.length) return;
  const el = $('#modelState');
  el.innerHTML = 'Reading and checking the model…';
  try{
    // Joining ~67 MB of shards and verifying the checksum takes a moment, and
    // starting the runtime takes a few seconds more. Say so rather than look
    // frozen.
    const info = await Backend.loadModelFromFiles(files);
    STATE = Backend.state();
    refresh();
    toast(`Loaded the trained model (${(info.bytes/1e6).toFixed(0)} MB, ${info.backend})`);
  }catch(err){
    toast(err.message, true);
    STATE = Backend.state();
    renderModelCard();
  }
};

$('#btnForgetModel').onclick = async () => {
  if(!confirm('Remove the downloaded model from this browser? '
            + 'The tool will fall back to the stub until you load one again.')) return;
  STATE = await Backend.forgetModel();
  refresh();
  toast('Model removed from this browser');
};

/* There is no undo and, unless a bundle was downloaded, no copy anywhere else.
   So this asks for the word rather than an OK button -- a confirm() dialog is
   one stray Enter away from deleting a week of review. */
$('#btnWipe').onclick = async () => {
  const n = STATE?.cases?.length || 0;
  if(!n) return toast('Nothing is stored here');
  const typed = prompt(
    `Delete all ${n} scan(s) stored in this browser? This cannot be undone, `
    + `and anything you have not downloaded is gone.\n\nType DELETE to confirm.`);
  if(typed !== 'DELETE') return toast('Nothing was deleted');
  await Backend.clearWorkspace();
  SEL = null;
  await refresh();
  toast(`Deleted ${n} scan(s)`);
};

/* ==================== the ITK-SNAP round trip ====================
   A page cannot launch ITK-SNAP -- see the note above $('#btnItk') and
   lib/fsaccess.js. The next best thing is a folder both programs can see, and
   on Chrome and Edge the File System Access API provides exactly that: pick a
   directory once, cases get written into it, ITK-SNAP saves back over the same
   mask file, and "Check for edits" reads the folder.

   Firefox and Safari have not shipped showDirectoryPicker, so everything below
   degrades to the zip download plus a file picker, which works everywhere. The
   button hides itself rather than offering something that cannot work. */
let FOLDER = {supported:false, linked:false, name:null};

async function refreshFolder(){
  FOLDER = await Backend.folderStatus();
  const b = $('#btnFolder');
  if(!b) return;
  b.style.display = FOLDER.supported ? '' : 'none';
  b.textContent = FOLDER.linked ? `Folder: ${FOLDER.name}` : 'ITK-SNAP folder…';
  b.title = FOLDER.linked
    ? `Cases are written to "${FOLDER.name}". Click to change it.`
    : 'Share a folder on disk with ITK-SNAP, so corrections come back automatically';
  $('#btnRescan').textContent = FOLDER.linked ? 'Check folder for edits'
                                              : 'Import corrected masks';
}

$('#btnFolder').onclick = async () => {
  try{
    if(FOLDER.linked && !confirm(
        `Cases are currently written to "${FOLDER.name}". Choose a different folder?`)) return;
    const j = await Backend.linkFolder();
    await refreshFolder();
    toast(`Linked "${j.name}". Use "Download for ITK-SNAP" on a scan to write it there.`);
  }catch(e){
    // An AbortError is the user closing the picker, which is not a failure.
    if(e.name !== 'AbortError') toast(e.message, true);
  }
};

$('#btnRescan').onclick = async () => {
  if(!FOLDER.linked) return $('#maskPicker').click();
  try{
    showProgress('Checking the folder', FOLDER.name, null);
    const j = await Backend.syncFromFolder();
    hideProgress();
    await refresh();
    toast(j.changed.length
      ? `${j.changed.length} mask(s) changed: ${j.changed.join(', ')}`
      : `Checked ${j.checked} scan(s) in "${j.folder}" — nothing has changed.`);
    if(j.failed.length){
      toast(`${j.failed.length} could not be read`, true);
      console.warn('failed:', j.failed);
    }
  }catch(e){ hideProgress(); toast(e.message, true); }
};
$('#maskPicker').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if(!files.length) return;
  try{
    showProgress('Importing corrected masks', `${files.length} file(s)`, null);
    const j = await Backend.importMasks(files);
    hideProgress();
    await refresh();
    if(j.imported.length) toast(`Imported ${j.imported.length} corrected mask(s)`);
    if(j.skipped.length){
      toast(`${j.skipped.length} file(s) did not match a scan here`, true);
      console.warn('skipped:', j.skipped);
    }
    if(!j.imported.length && !j.skipped.length) toast('Nothing to import');
  }catch(err){ hideProgress(); toast(err.message, true); }
};

$('#btnCsv').onclick = () => {
  try{ download(Backend.csvBlob(), 'volumes.csv'); }
  catch(e){ toast(e.message, true); }
};
$('#btnZip').onclick = async () => {
  try{
    toast('Packaging everything — this takes a moment for a big cohort…');
    download(await Backend.bundleBlob(), 'segmentation_results.zip');
  }catch(e){ toast(e.message, true); }
};

const helpOpen = o => $('#help').classList.toggle('open', o);
$('#btnHelp').onclick = () => helpOpen(true);
$('#helpClose').onclick = () => helpOpen(false);
$('#help').onclick = e => { if(e.target.id==='help') helpOpen(false); };

$('#autoNext').checked = PREFS.autoNext;
$('#autoNext').onchange = e => { PREFS.autoNext = e.target.checked; savePrefs();
  toast(PREFS.autoNext ? 'Will jump to the next unreviewed scan'
                       : 'Will stay on the current scan'); };

// The brush size lives in prefs so it survives a reload; a reviewer who likes a
// 3-voxel brush should not have to set it again every session.
ED.radius = PREFS.radius;

document.addEventListener('keyup', e => { if(e.code==='Space') SPACE_DOWN=false; });

// Shortcuts must not fire while someone is typing -- but a range slider is not
// typing. Blocking every INPUT meant that once you touched the slice scrubber
// it kept focus, and from then on every shortcut silently died. Only text-entry
// controls should swallow keys.
const TYPING_TYPES = ['text','search','number','password','email','url','tel'];
function isTypingTarget(t){
  const tag = t.tagName;
  if(tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  return tag === 'INPUT' && TYPING_TYPES.includes((t.type || 'text').toLowerCase());
}
const isRange = t => t.tagName === 'INPUT' && t.type === 'range';

document.addEventListener('keydown', e => {
  if(isTypingTarget(e.target)) return;
  if($('#main').style.display==='none') return;
  const k = e.key.toLowerCase();

  if(e.key==='?'){ e.preventDefault(); helpOpen(true); return; }
  if(e.key==='Escape' && $('#help').classList.contains('open')){
    helpOpen(false); return; }
  // Space is hold-to-pan, so it must not also scroll the page.
  if(e.code==='Space'){ SPACE_DOWN=true; e.preventDefault(); return; }
  if(e.key==='+' || e.key==='='){ e.preventDefault(); zoomStep(1.25); return; }
  if(e.key==='-' || e.key==='_'){ e.preventDefault(); zoomStep(1/1.25); return; }
  if(e.key==='0'){ e.preventDefault(); zoomReset(); return; }
  // Layout keys work in both modes, so T and H rather than a letter the editor
  // already wants for a tool.
  if(k==='t' && SEL){ e.preventDefault();
    PREFS.threeUp = !PREFS.threeUp; savePrefs(); renderDetail(); return; }
  if(k==='h' && SEL){ e.preventDefault();
    PREFS.crosshair = PREFS.crosshair === false; savePrefs(); renderDetail(); return; }

  if(ED.on){
    // Editing shortcuts take priority, and A/F are NOT bound here -- typing
    // them mid-edit should not silently mark a half-finished mask as accepted.
    if((e.metaKey||e.ctrlKey) && k==='z'){
      e.preventDefault();
      e.shiftKey ? edApplySnapshot(ED.redo, ED.undo)
                 : edApplySnapshot(ED.undo, ED.redo);
      return;
    }
    if((e.metaKey||e.ctrlKey) && k==='s'){ e.preventDefault(); edSave(); return; }

    // Outline keys come first: Enter/Backspace/Esc mean something specific
    // while an outline is open.
    if(ED.tool==='polygon' || ED.tool==='freehand'){
      if(e.key==='Enter'){ e.preventDefault(); polyAccept(); return; }
      if(e.key==='Backspace'){ e.preventDefault(); (ED.poly||[]).pop(); polyDraw(); return; }
      if(e.key==='Escape' && (ED.poly||[]).length){
        e.preventDefault(); polyReset(); toast('Outline discarded'); return; }
      if(k==='v'){ polyPaste(); return; }
    }
    const tk = {f:'freehand', p:'polygon', b:'brush', a:'adaptive', e:'eraser',
                g:'fill', x:'scalpel', r:'ruler', c:'cross'}[k];
    if(tk){ ED.tool=tk; if(tk!=='polygon' && tk!=='freehand') polyReset();
            PREFS.tool=tk; savePrefs(); renderDetail(); return; }
    if(k==='m'){ ED.subtract=!ED.subtract; renderDetail(); return; }
    if(e.key==='[' || e.key===']'){
      ED.radius = e.key==='[' ? Math.max(1, ED.radius-1) : Math.min(40, ED.radius+1);
      PREFS.radius = ED.radius; savePrefs();
      const s=$('#tSize'); if(s) s.value=ED.radius;
      const l=$('#edSize'); if(l) l.textContent=brushLabel();
      return;
    }
    if(e.key==='Escape'){ if(edConfirmLeave()) edExit(); return; }
  }

  // With focus on a slider the browser already moves it, and for the scrubber
  // that fires oninput and changes the slice. Handling the arrow here as well
  // would advance two slices per press.
  if(!isRange(e.target)){
    if(e.key==='ArrowRight' && window._setSlice){ e.preventDefault(); window._setSlice(SLICE+1); }
    if(e.key==='ArrowLeft'  && window._setSlice){ e.preventDefault(); window._setSlice(SLICE-1); }
    if(e.key==='ArrowDown'){ e.preventDefault(); step(1); }
    if(e.key==='ArrowUp'){ e.preventDefault(); step(-1); }
  }
  if(ED.on) return;
  if(k==='a' && SEL) review('accepted');
  if(k==='f' && SEL) review('flagged');
});

// Losing hand-drawn work to a stray click or a closed tab would be
// unforgivable, so every route out of the editor is guarded.
window.addEventListener('beforeunload', e => {
  if(edUnsaved()){ e.preventDefault(); e.returnValue = ''; }
});

/* ======================= start ======================= */
// Everything this build needs is either present or it is not, and finding out
// halfway through segmenting a cohort would be much worse than finding out now.
function unsupported(){
  const missing = [];
  if(typeof CompressionStream === 'undefined') missing.push('CompressionStream (.nii.gz files)');
  if(typeof indexedDB === 'undefined') missing.push('IndexedDB (storing results)');
  if(!window.crypto?.subtle) missing.push('Web Crypto (change detection)');
  if(!window.crypto?.subtle && location.protocol === 'http:'
     && !['localhost','127.0.0.1'].includes(location.hostname)) {
    // The commonest cause by far, and it looks like a browser problem.
    missing.push('— Web Crypto is only available over https or on localhost');
  }
  return missing;
}

(async () => {
  const missing = unsupported();
  if(missing.length){
    document.body.innerHTML =
      `<div style="max-width:60ch;margin:80px auto;font:15px/1.6 system-ui">
        <h1 style="font-size:20px">This browser cannot run the tool</h1>
        <p>It is missing:</p><ul><li>${missing.join('</li><li>')}</li></ul>
        <p>Chrome 80+, Firefox 113+ or Safari 16.4+ all work. If you are
        opening this over plain <code>http://</code> on a machine other than
        your own, serve it over <code>https</code> instead.</p>
       </div>`;
    return;
  }
  try{
    await Backend.init();
    await refreshFolder();
    await refresh();
    // The model finishes starting a second or two later. Re-render then, so
    // the card stops saying "Starting…" without the user having to click.
    Backend.modelReady().then(s => { STATE = s; renderModelCard(); });
  }catch(e){
    console.error(e);
    toast(e.message, true);
    setStorageWarning(`Could not open local storage: ${e.message}`);
  }
})();
