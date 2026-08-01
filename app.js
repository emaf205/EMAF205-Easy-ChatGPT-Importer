(() => {
'use strict';

const APP_VERSION='4.0.0';
const DB_NAME='emaf205-easy-chatgpt-importer';
const DB_VERSION=3;
const STATE_STORE='vault';
const SNAPSHOT_STORE='snapshots';
const TEXT_EXT=new Set(['md','markdown','txt','json','csv','html','htm','css','js','mjs','cjs','ts','tsx','jsx','py','xml','yaml','yml','ini','log','sql','sh','bat','toml','env','rtf']);
const DESTINATIONS={chatgpt:'https://chatgpt.com/',gemini:'https://gemini.google.com/app',claude:'https://claude.ai/new',drive:'https://drive.google.com/drive/my-drive'};

let db,saveTimer,snapshotTimer,editingId=null,actionFileId=null,pendingSendIds=[],deferredInstallPrompt=null;
let draggedId=null,dragMouseAllowed=false,touchDrag=null,longPressTimer=null,suppressClick=false,lastDeleted=null,toastAction=null;

const defaultState={
  schemaVersion:4,appVersion:APP_VERSION,
  categories:[{id:'all',name:'TUTTI',system:true},{id:'favorites',name:'★ PREFERITI',system:true},{id:'main',name:'PRINCIPALE',system:true}],
  files:[],activeCategory:'all',selected:[],query:'',selectionMode:false,dirty:false,lastBackupAt:null,changeCount:0
};
let state=structuredClone(defaultState);

const $=s=>document.querySelector(s);
const el={
  menuBtn:$('#menuBtn'),favoriteFilterBtn:$('#favoriteFilterBtn'),uploadBtn:$('#uploadBtn'),searchInput:$('#searchInput'),categoryRail:$('#categoryRail'),
  fileList:$('#fileList'),fileCount:$('#fileCount'),selectModeBtn:$('#selectModeBtn'),selectionBar:$('#selectionBar'),dirtyDot:$('#dirtyDot'),toast:$('#toast'),
  drawer:$('#drawer'),overlay:$('#overlay'),storageInfo:$('#storageInfo'),backupInfo:$('#backupInfo'),installMenuBtn:$('#installMenuBtn'),
  fileInput:$('#fileInput'),restoreInput:$('#restoreInput'),editorDialog:$('#editorDialog'),editorTitle:$('#editorTitle'),editorArea:$('#editorArea'),
  actionDialog:$('#actionDialog'),actionFavoriteBtn:$('#actionFavoriteBtn'),actionEditBtn:$('#actionEditBtn'),sendDialog:$('#sendDialog'),
  categoriesDialog:$('#categoriesDialog'),categoryManager:$('#categoryManager'),moveDialog:$('#moveDialog'),moveList:$('#moveList'),snapshotDialog:$('#snapshotDialog'),snapshotInfo:$('#snapshotInfo')
};

function uid(){return crypto.randomUUID?crypto.randomUUID():`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function ext(name=''){const p=String(name).split('.');return p.length>1?p.pop().toLowerCase():'';}
function isText(f){return f.kind==='text'||TEXT_EXT.has(ext(f.name))||String(f.type||'').startsWith('text/');}
function safePath(name){return String(name).replace(/[\\/:*?"<>|]/g,'_').replace(/^_+/,'')||'FILE';}
function categoryName(id){return state.categories.find(c=>c.id===id)?.name||'PRINCIPALE';}
function realCategories(){return state.categories.filter(c=>!['all','favorites'].includes(c.id));}
function humanSize(n=0){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`;}
function formatDate(v){if(!v)return'MAI';return new Intl.DateTimeFormat('it-IT',{dateStyle:'short',timeStyle:'short'}).format(new Date(v));}
function selectedFiles(){return state.selected.map(id=>state.files.find(f=>f.id===id)).filter(Boolean);}
function fileBlob(f){return isText(f)?new Blob([f.content||''],{type:f.type||'text/plain'}):(f.blob instanceof Blob?f.blob:new Blob([f.blob||''],{type:f.type||'application/octet-stream'}));}
function categoryFiles(id){return state.files.filter(f=>f.category===id).sort((a,b)=>(a.order??0)-(b.order??0)||(b.modified??0)-(a.modified??0));}
function visibleFiles(){
  const q=state.query.trim().toLowerCase();let files;
  if(state.activeCategory==='favorites')files=state.files.filter(f=>f.favorite).sort((a,b)=>(b.modified??0)-(a.modified??0));
  else if(state.activeCategory==='all')files=[...state.files].sort((a,b)=>(b.modified??0)-(a.modified??0));
  else files=categoryFiles(state.activeCategory);
  return files.filter(f=>!q||f.name.toLowerCase().includes(q)||(isText(f)&&String(f.content||'').toLowerCase().includes(q)));
}
function nextOrder(categoryId){const values=state.files.filter(f=>f.category===categoryId).map(f=>Number(f.order)||0);return values.length?Math.max(...values)+1:0;}
function uniqueFileName(name,categoryId,excludeId=null){
  const existing=new Set(state.files.filter(f=>f.category===categoryId&&f.id!==excludeId).map(f=>f.name.toLowerCase()));
  if(!existing.has(name.toLowerCase()))return name;
  const dot=name.lastIndexOf('.'),base=dot>0?name.slice(0,dot):name,suffix=dot>0?name.slice(dot):'';let i=2,candidate;
  do{candidate=`${base}-${i++}${suffix}`;}while(existing.has(candidate.toLowerCase()));return candidate;
}
function dateStamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1800);}
function flash(ids){const set=new Set(ids);el.fileList.querySelectorAll('[data-file-id]').forEach(card=>{if(set.has(card.dataset.fileId)){card.classList.add('copied');setTimeout(()=>card.classList.remove('copied'),650);}});}
function toast(message,actionLabel=null,action=null){
  toastAction=action;el.toast.innerHTML=`<span>${esc(message)}</span>${actionLabel?`<button id="toastActionBtn">${esc(actionLabel)}</button>`:''}`;
  el.toast.classList.add('show');clearTimeout(el.toast._t);el.toast._t=setTimeout(()=>{el.toast.classList.remove('show');toastAction=null;},3200);
  $('#toastActionBtn')?.addEventListener('click',()=>{const fn=toastAction;el.toast.classList.remove('show');toastAction=null;if(fn)fn();});
}

function migrateState(raw){
  if(!raw)return structuredClone(defaultState);
  const s={...structuredClone(defaultState),...raw,selected:[],query:'',selectionMode:false};
  s.categories=(s.categories||[]).map(c=>c.id==='inbox'?{...c,id:'main',name:'PRINCIPALE',system:true}:c).filter((c,i,a)=>a.findIndex(x=>x.id===c.id)===i);
  s.files=(s.files||[]).map((f,i)=>({...f,category:f.category==='inbox'?'main':(f.category||'main'),favorite:Boolean(f.favorite),order:Number.isFinite(f.order)?f.order:i}));
  if(!s.categories.find(c=>c.id==='all'))s.categories.unshift({id:'all',name:'TUTTI',system:true});
  if(!s.categories.find(c=>c.id==='favorites'))s.categories.splice(1,0,{id:'favorites',name:'★ PREFERITI',system:true});
  if(!s.categories.find(c=>c.id==='main'))s.categories.push({id:'main',name:'PRINCIPALE',system:true});
  s.schemaVersion=4;s.appVersion=APP_VERSION;return s;
}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STATE_STORE))d.createObjectStore(STATE_STORE);if(!d.objectStoreNames.contains(SNAPSHOT_STORE))d.createObjectStore(SNAPSHOT_STORE);};r.onsuccess=()=>{db=r.result;resolve();};r.onerror=()=>reject(r.error);});}
function idbGet(store,key){if(!db)return Promise.resolve(null);return new Promise(resolve=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>resolve(null);});}
function idbPut(store,key,value){if(!db)return Promise.resolve();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>idbPut(STATE_STORE,'state',state).catch(console.error),120);}
function markDirty(){state.dirty=true;state.changeCount=(state.changeCount||0)+1;save();scheduleSnapshot();renderStatus();}
function scheduleSnapshot(){clearTimeout(snapshotTimer);snapshotTimer=setTimeout(()=>createSnapshot(false),20000);}
async function createSnapshot(show=true){
  if(!db)return;const list=(await idbGet(SNAPSHOT_STORE,'list'))||[];const snapshot={createdAt:Date.now(),state:structuredClone(state)};
  await idbPut(SNAPSHOT_STORE,'list',[snapshot,...list].slice(0,5));state.changeCount=0;save();await updateSnapshotInfo();if(show)toast('SNAPSHOT CREATO');
}
async function updateSnapshotInfo(){const list=(await idbGet(SNAPSHOT_STORE,'list'))||[];el.snapshotInfo.textContent=list.length?`${list.length} SNAPSHOT · ${formatDate(list[0].createdAt)}`:'NESSUNO SNAPSHOT';}
async function restoreLatestSnapshot(){const list=(await idbGet(SNAPSHOT_STORE,'list'))||[];if(!list.length)return toast('NESSUNO SNAPSHOT');if(!confirm(`RIPRISTINARE ${formatDate(list[0].createdAt)}?`))return;state=migrateState(structuredClone(list[0].state));state.dirty=true;closeDialog(el.snapshotDialog);render();toast('SNAPSHOT RIPRISTINATO');}

function render(){renderCategories();renderFiles();renderStatus();save();}
function renderStatus(){
  document.body.classList.toggle('selection-mode',state.selectionMode);el.selectionBar.classList.toggle('show',state.selected.length>0);el.dirtyDot.classList.toggle('hidden',!state.dirty);
  el.favoriteFilterBtn.classList.toggle('active',state.activeCategory==='favorites');el.backupInfo.textContent=`BACKUP: ${formatDate(state.lastBackupAt)}`;
}
function renderCategories(){
  el.categoryRail.innerHTML=state.categories.map(c=>{const count=c.id==='all'?state.files.length:c.id==='favorites'?state.files.filter(f=>f.favorite).length:state.files.filter(f=>f.category===c.id).length;const droppable=!['all','favorites'].includes(c.id);return`<button class="category-chip ${state.activeCategory===c.id?'active':''}" data-category="${c.id}" ${droppable?`data-category-drop="${c.id}"`:''}>${esc(c.name)} · ${count}</button>`;}).join('');
}
function renderFiles(){
  const files=visibleFiles();el.fileCount.textContent=`${files.length} FILE`;el.selectModeBtn.textContent=state.selectionMode?'FINE':'SELEZIONA';
  if(!files.length){el.fileList.innerHTML='<div class="empty-state">ZERO<br>FILE</div>';return;}
  el.fileList.innerHTML=files.map(f=>`<article class="file-card" draggable="true" data-file-id="${f.id}">
    <input class="file-check" data-check="${f.id}" type="checkbox" ${state.selected.includes(f.id)?'checked':''} aria-label="Seleziona ${esc(f.name)}">
    <button class="drag-handle" data-drag-handle="${f.id}" aria-label="Trascina ${esc(f.name)}">↕</button>
    <div class="file-main" data-open="${f.id}"><div class="file-name">${esc(f.name)}</div><div class="file-meta">${esc(categoryName(f.category))} · ${humanSize(f.size||0)}</div></div>
    <div class="card-actions"><button class="star-button ${f.favorite?'active':''}" data-favorite="${f.id}" aria-label="Preferito">${f.favorite?'★':'☆'}</button><button class="more-button" data-more="${f.id}" aria-label="Azioni">•••</button></div>
  </article>`).join('');
}

async function copyText(text){try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}}catch(e){}const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();let ok=false;try{ok=document.execCommand('copy');}catch(e){}ta.remove();return ok;}
function combinedText(files){return files.length===1?(files[0].content||''):files.map(f=>`--- FILE: ${f.name} ---\n${f.content||''}`).join('\n\n');}
async function openFile(f){if(!f)return;if(state.selectionMode){toggleSelection(f.id);return;}if(isText(f)){const ok=await copyText(f.content||'');if(ok)flash([f.id]);toast(ok?'COPIATO':'COPIA NON RIUSCITA');}else{downloadBlob(fileBlob(f),f.name);toast('FILE ESPORTATO');}}
function toggleFavorite(id){const f=state.files.find(x=>x.id===id);if(!f)return;f.favorite=!f.favorite;f.modified=Date.now();markDirty();render();}
function toggleSelection(id){state.selected=state.selected.includes(id)?state.selected.filter(x=>x!==id):[...state.selected,id];state.selectionMode=state.selected.length>0||state.selectionMode;render();}
function clearSelection(){state.selected=[];state.selectionMode=false;render();}
async function copySelected(){const files=selectedFiles();if(!files.length)return;if(!files.every(isText)){await exportFiles(files);return toast('ZIP PRONTO');}const ok=await copyText(combinedText(files));if(ok)flash(files.map(f=>f.id));toast(ok?'COPIATO':'COPIA NON RIUSCITA');}

async function importFiles(list){const files=[...list];if(!files.length)return;const category=!['all','favorites'].includes(state.activeCategory)?state.activeCategory:'main';for(const file of files){const text=TEXT_EXT.has(ext(file.name))||file.type.startsWith('text/');state.files.push({id:uid(),name:uniqueFileName(file.name,category),category,type:file.type||'',kind:text?'text':'binary',content:text?await file.text():null,blob:text?null:file,size:file.size,modified:file.lastModified||Date.now(),favorite:false,order:nextOrder(category)});}markDirty();render();toast(`${files.length} FILE CARICATI`);}
function newTextFile(){const raw=prompt('NOME FILE','NUOVO.md');if(!raw?.trim())return;const category=!['all','favorites'].includes(state.activeCategory)?state.activeCategory:'main';const f={id:uid(),name:uniqueFileName(raw.trim(),category),category,type:'text/markdown',kind:'text',content:'',blob:null,size:0,modified:Date.now(),favorite:false,order:nextOrder(category)};state.files.push(f);markDirty();render();openEditor(f.id);}
function openEditor(id){const f=state.files.find(x=>x.id===id);if(!f||!isText(f))return;editingId=id;el.editorTitle.textContent=f.name;el.editorArea.value=f.content||'';openDialog(el.editorDialog);setTimeout(()=>el.editorArea.focus(),0);}
function saveEditor(){const f=state.files.find(x=>x.id===editingId);if(!f)return;f.content=el.editorArea.value;f.size=new Blob([f.content]).size;f.modified=Date.now();markDirty();closeDialog(el.editorDialog);render();toast('SALVATO');}
function renameFile(id){const f=state.files.find(x=>x.id===id);if(!f)return;const raw=prompt('NUOVO NOME',f.name);if(!raw?.trim())return;f.name=uniqueFileName(raw.trim(),f.category,f.id);f.modified=Date.now();markDirty();render();if(editingId===id)el.editorTitle.textContent=f.name;}
function moveFilesToCategory(files,categoryId){if(!files.length||!realCategories().some(c=>c.id===categoryId))return;for(const f of files){if(f.category!==categoryId){f.category=categoryId;f.order=nextOrder(categoryId);f.modified=Date.now();}}markDirty();clearSelection();toast('FILE SPOSTATI');}
function openMoveDialog(ids){pendingSendIds=[];const files=ids.map(id=>state.files.find(f=>f.id===id)).filter(Boolean);if(!files.length)return;el.moveList.innerHTML=realCategories().map(c=>`<button data-move-category="${c.id}">${esc(c.name)}</button>`).join('');el.moveDialog.dataset.fileIds=files.map(f=>f.id).join(',');openDialog(el.moveDialog);}
function reorderByDrop(sourceId,targetId){const source=state.files.find(f=>f.id===sourceId),target=state.files.find(f=>f.id===targetId);if(!source||!target||source.category!==target.category)return;const files=categoryFiles(source.category),from=files.findIndex(f=>f.id===sourceId),to=files.findIndex(f=>f.id===targetId);if(from<0||to<0)return;const[item]=files.splice(from,1);files.splice(to,0,item);files.forEach((f,i)=>f.order=i);markDirty();render();}
function deleteFiles(ids){const set=new Set(ids),removed=state.files.filter(f=>set.has(f.id));if(!removed.length)return;const indexes=removed.map(f=>({file:f,index:state.files.findIndex(x=>x.id===f.id)}));state.files=state.files.filter(f=>!set.has(f.id));state.selected=[];state.selectionMode=false;lastDeleted=indexes;markDirty();render();toast('ELIMINATO','ANNULLA',()=>{if(!lastDeleted)return;for(const item of [...lastDeleted].sort((a,b)=>a.index-b.index))state.files.splice(Math.min(item.index,state.files.length),0,item.file);lastDeleted=null;markDirty();render();toast('RIPRISTINATO');});}

function addCategory(){const raw=prompt('NOME CATEGORIA');if(!raw?.trim())return;const name=raw.trim().toUpperCase();if(state.categories.some(c=>c.name.toUpperCase()===name))return toast('GIÀ PRESENTE');state.categories.push({id:uid(),name,system:false});markDirty();render();renderCategoryManager();}
function renameCategory(id){const c=state.categories.find(x=>x.id===id);if(!c||['all','favorites'].includes(id))return;const raw=prompt('NUOVO NOME',c.name);if(!raw?.trim())return;const name=raw.trim().toUpperCase();if(state.categories.some(x=>x.id!==id&&x.name.toUpperCase()===name))return toast('GIÀ PRESENTE');c.name=name;markDirty();render();renderCategoryManager();}
function deleteCategory(id){if(id==='main')return toast('PRINCIPALE NON ELIMINABILE');const c=state.categories.find(x=>x.id===id);if(!c||!confirm(`ELIMINARE ${c.name}?`))return;state.files.forEach(f=>{if(f.category===id){f.category='main';f.order=nextOrder('main');}});state.categories=state.categories.filter(x=>x.id!==id);if(state.activeCategory===id)state.activeCategory='all';markDirty();render();renderCategoryManager();}
function renderCategoryManager(){el.categoryManager.innerHTML=realCategories().map(c=>`<div class="category-row"><strong>${esc(c.name)}</strong><button data-rename-category="${c.id}">✎</button><button data-delete-category="${c.id}" ${c.id==='main'?'disabled':''}>×</button></div>`).join('');}

function openActionDialog(id){const f=state.files.find(x=>x.id===id);if(!f)return;actionFileId=id;el.actionFavoriteBtn.textContent=f.favorite?'TOGLI PREFERITO':'AGGIUNGI PREFERITO';el.actionEditBtn.classList.toggle('hidden',!isText(f));openDialog(el.actionDialog);}
function openSendDialog(ids){const files=ids.map(id=>state.files.find(f=>f.id===id)).filter(Boolean);if(!files.length)return toast('SELEZIONA FILE');pendingSendIds=files.map(f=>f.id);closeDialog(el.actionDialog);openDialog(el.sendDialog);}
function getPendingFiles(){return pendingSendIds.map(id=>state.files.find(f=>f.id===id)).filter(Boolean);}
function popupNow(url){const w=window.open(url,'_blank','noopener');return w;}
async function shareNative(files){
  try{
    if(!navigator.share)return false;
    if(files.every(isText)){await navigator.share({title:'EMAF205',text:combinedText(files)});return true;}
    const shareFiles=files.map(f=>new File([fileBlob(f)],f.name,{type:f.type||'application/octet-stream'}));
    if(navigator.canShare&&!navigator.canShare({files:shareFiles}))return false;await navigator.share({title:'EMAF205',files:shareFiles});return true;
  }catch(err){if(err.name==='AbortError')return true;return false;}
}
async function sendFiles(destination){
  const files=getPendingFiles();if(!files.length)return;
  if(destination==='share'){const ok=await shareNative(files);if(!ok){if(files.every(isText))await copyText(combinedText(files));else await exportFiles(files);toast(ok?'CONDIVISO':'PRONTO DA CONDIVIDERE');}closeDialog(el.sendDialog);return;}
  if(destination==='email'){
    const allText=files.every(isText),subject=encodeURIComponent(`EMAF205: ${files.map(f=>f.name).join(', ')}`);let body='';
    if(allText){const text=combinedText(files);await copyText(text);body=encodeURIComponent(text.slice(0,1800)+(text.length>1800?'\n\n[Testo completo copiato negli appunti]':''));}
    else{await exportFiles(files);body=encodeURIComponent('Allega i file appena scaricati.');}
    popupNow(`mailto:?subject=${subject}&body=${body}`);toast(allText?'TESTO COPIATO':'FILE SCARICATI');closeDialog(el.sendDialog);return;
  }
  if(destination==='drive'){
    if(await shareNative(files)){closeDialog(el.sendDialog);return;}
    popupNow(DESTINATIONS.drive);if(files.every(isText)){await copyText(combinedText(files));toast('TESTO COPIATO');}else{await exportFiles(files);toast('FILE SCARICATI');}closeDialog(el.sendDialog);return;
  }
  const popup=popupNow(DESTINATIONS[destination]);
  if(files.every(isText)){await copyText(combinedText(files));toast('TESTO COPIATO');}
  else{await exportFiles(files);toast('FILE SCARICATI');}
  if(!popup)toast('APRI IL SERVIZIO E INCOLLA');closeDialog(el.sendDialog);
}

function uniqueZipName(name,used){const safe=safePath(name),dot=safe.lastIndexOf('.'),base=dot>0?safe.slice(0,dot):safe,suffix=dot>0?safe.slice(dot):'';const count=used.get(safe)||0;used.set(safe,count+1);return count?`${base}-${count+1}${suffix}`:safe;}
async function exportFiles(files){if(!files.length)return;if(files.length===1){downloadBlob(fileBlob(files[0]),files[0].name);return;}const entries=[],used=new Map();for(const f of files)entries.push({name:uniqueZipName(f.name,used),data:new Uint8Array(await fileBlob(f).arrayBuffer())});downloadBlob(makeZip(entries),'EMAF205-FILES.zip');}
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function u16(n){return[n&255,(n>>>8)&255];}function u32(n){return[n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];}
function makeZip(entries){const enc=new TextEncoder(),locals=[],centrals=[];let offset=0;for(const e of entries){const name=enc.encode(e.name),data=e.data,crc=crc32(data),size=data.length,flags=0x0800;const local=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(flags),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(size),...u32(size),...u16(name.length),...u16(0),...name,...data]);locals.push(local);const central=new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(flags),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(size),...u32(size),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset),...name]);centrals.push(central);offset+=local.length;}const centralSize=centrals.reduce((a,b)=>a+b.length,0),end=new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(entries.length),...u16(entries.length),...u32(centralSize),...u32(offset),...u16(0)]);return new Blob([...locals,...centrals,end],{type:'application/zip'});}
function readU16(v,o){return v.getUint16(o,true);}function readU32(v,o){return v.getUint32(o,true);}
async function readStoredZip(file){const buffer=await file.arrayBuffer(),view=new DataView(buffer),bytes=new Uint8Array(buffer);let eocd=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(readU32(view,i)===0x06054b50){eocd=i;break;}}if(eocd<0)throw new Error('ZIP NON VALIDO');const total=readU16(view,eocd+10),centralOffset=readU32(view,eocd+16),dec=new TextDecoder(),result=new Map();let pos=centralOffset;for(let i=0;i<total;i++){if(readU32(view,pos)!==0x02014b50)throw new Error('ZIP NON VALIDO');const method=readU16(view,pos+10),size=readU32(view,pos+20),nameLen=readU16(view,pos+28),extraLen=readU16(view,pos+30),commentLen=readU16(view,pos+32),localOffset=readU32(view,pos+42);if(method!==0)throw new Error('ZIP COMPRESSO NON SUPPORTATO');const name=dec.decode(bytes.slice(pos+46,pos+46+nameLen)),localNameLen=readU16(view,localOffset+26),localExtraLen=readU16(view,localOffset+28),start=localOffset+30+localNameLen+localExtraLen;result.set(name,bytes.slice(start,start+size));pos+=46+nameLen+extraLen+commentLen;}return result;}
async function buildVaultEntries(prefix=''){const enc=new TextEncoder(),entries=[],manifestFiles=[];for(const f of state.files){const internalPath=`${prefix}FILES/${safePath(categoryName(f.category))}/${safePath(f.id)}--${safePath(f.name)}`;entries.push({name:internalPath,data:new Uint8Array(await fileBlob(f).arrayBuffer())});manifestFiles.push({id:f.id,name:f.name,category:f.category,type:f.type||'',kind:isText(f)?'text':'binary',size:f.size||0,modified:f.modified||Date.now(),favorite:Boolean(f.favorite),order:f.order??0,internalPath});}entries.unshift({name:`${prefix}manifest.json`,data:enc.encode(JSON.stringify({app:'EMAF205 - Easy ChatGPT Importer',schemaVersion:4,appVersion:APP_VERSION,createdAt:new Date().toISOString(),categories:state.categories,files:manifestFiles},null,2))});return entries;}
async function verifyBackup(blob,manifestPath){const entries=await readStoredZip(blob);if(!entries.has(manifestPath))throw new Error('BACKUP NON VERIFICABILE');JSON.parse(new TextDecoder().decode(entries.get(manifestPath)));return true;}
function sourceText(id){return document.getElementById(id)?.textContent||'';}
function cleanIndexSource(){const clone=document.documentElement.cloneNode(true);clone.querySelector('#categoryRail').innerHTML='';clone.querySelector('#fileList').innerHTML='';clone.querySelector('#toast').innerHTML='';clone.querySelectorAll('dialog').forEach(d=>d.removeAttribute('open'));clone.querySelector('#drawer').classList.remove('show');clone.querySelector('#overlay').classList.remove('show');clone.querySelector('#selectionBar').classList.remove('show');clone.querySelector('#dirtyDot').classList.add('hidden');return'<!doctype html>\n'+clone.outerHTML;}
async function makeIcon(size){const c=document.createElement('canvas');c.width=c.height=size;const x=c.getContext('2d');x.fillStyle='#dfff00';x.fillRect(0,0,size,size);x.fillStyle='#000';x.font=`900 ${Math.round(size*.22)}px Arial`;x.textAlign='center';x.textBaseline='middle';x.fillText('EMAF',size/2,size*.42);x.fillText('205',size/2,size*.66);return new Uint8Array(await(await new Promise(r=>c.toBlob(r,'image/png'))).arrayBuffer());}
async function backupVault(){try{const entries=await buildVaultEntries(''),blob=makeZip(entries);await verifyBackup(blob,'manifest.json');downloadBlob(blob,`EMAF205-VAULT-${dateStamp()}.zip`);finishBackup('BACKUP VERIFICATO');}catch(e){alert(`ERRORE: ${e.message}`);}}
async function backupFull(){try{const entries=await buildVaultEntries('VAULT/');const sources={
  'APP/index.html':cleanIndexSource(),'APP/style.css':sourceText('sourceStyle'),'APP/app.js':sourceText('sourceApp'),'APP/manifest.webmanifest':sourceText('sourceManifest'),'APP/service-worker.js':sourceText('sourceWorker'),'APP/README.txt':sourceText('sourceReadme'),'APP/VERSION.txt':APP_VERSION+'\n'
};for(const[name,text]of Object.entries(sources))entries.push({name,data:new TextEncoder().encode(text)});entries.push({name:'APP/icons/icon-192.png',data:await makeIcon(192)},{name:'APP/icons/icon-512.png',data:await makeIcon(512)});entries.push({name:'BACKUP-INFO.txt',data:new TextEncoder().encode(`EMAF205 BACKUP COMPLETO\nVersione: ${APP_VERSION}\nCreato: ${new Date().toISOString()}\n`)});const blob=makeZip(entries);await verifyBackup(blob,'VAULT/manifest.json');downloadBlob(blob,`EMAF205-COMPLETO-${dateStamp()}.zip`);finishBackup('BACKUP COMPLETO VERIFICATO');}catch(e){alert(`ERRORE: ${e.message}`);}}
function finishBackup(msg){state.lastBackupAt=Date.now();state.dirty=false;save();renderStatus();toast(msg);closeDrawer();}
async function restoreBackup(file){if(!confirm('RIPRISTINARE IL BACKUP?'))return;try{await createSnapshot(false);if(file.name.toLowerCase().endsWith('.json')){const raw=JSON.parse(await file.text());state=migrateState(raw);state.dirty=true;render();return toast('BACKUP RIPRISTINATO');}const entries=await readStoredZip(file),manifestPath=entries.has('manifest.json')?'manifest.json':entries.has('VAULT/manifest.json')?'VAULT/manifest.json':null;if(!manifestPath)throw new Error('MANIFEST MANCANTE');const manifest=JSON.parse(new TextDecoder().decode(entries.get(manifestPath))),files=[];for(const m of manifest.files){const bytes=entries.get(m.internalPath);if(!bytes)throw new Error(`FILE MANCANTE: ${m.name}`);const blob=new Blob([bytes],{type:m.type||'application/octet-stream'});files.push({...m,content:m.kind==='text'?await blob.text():null,blob:m.kind==='text'?null:blob});delete files.at(-1).internalPath;}state=migrateState({categories:manifest.categories,files,activeCategory:'all',dirty:false,lastBackupAt:Date.now()});el.searchInput.value='';render();toast('BACKUP RIPRISTINATO');}catch(e){alert(`ERRORE: ${e.message}`);}}

function openDialog(d){if(!d.open)d.showModal();}
function closeDialog(d){if(d?.open)d.close();}
function openDrawer(){el.drawer.classList.add('show');el.overlay.classList.add('show');document.body.classList.add('locked');}
function closeDrawer(){el.drawer.classList.remove('show');el.overlay.classList.remove('show');document.body.classList.remove('locked');}
async function updateStorageInfo(){try{const est=await navigator.storage?.estimate?.(),used=est?.usage||0,quota=est?.quota||0;el.storageInfo.textContent=quota?`SPAZIO ${humanSize(used)} / ${humanSize(quota)}`:'STORAGE LOCALE';}catch(e){el.storageInfo.textContent='STORAGE LOCALE';}}
async function requestPersistentStorage(){try{if(navigator.storage?.persist){const ok=await navigator.storage.persist();el.storageInfo.textContent=ok?'STORAGE PROTETTO':'STORAGE LOCALE';setTimeout(updateStorageInfo,700);}}catch(e){updateStorageInfo();}}
async function registerServiceWorker(){if('serviceWorker'in navigator&&location.protocol!=='file:'){try{await navigator.serviceWorker.register('./service-worker.js');}catch(e){console.warn(e);}}}

function nativeDragStart(e){const card=e.target.closest('[data-file-id]');if(!card||!dragMouseAllowed){e.preventDefault();return;}draggedId=card.dataset.fileId;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedId);card.classList.add('dragging');}
function clearDropTargets(){document.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target'));}
function nativeDropCategory(e){const chip=e.target.closest('[data-category-drop]');if(!chip)return;e.preventDefault();const id=e.dataTransfer.getData('text/plain')||draggedId,f=state.files.find(x=>x.id===id);if(f)moveFilesToCategory([f],chip.dataset.categoryDrop);clearDropTargets();}
function startTouchDrag(e,id){if(e.pointerType==='mouse')return;clearTimeout(touchDrag?.timer);touchDrag={id,startX:e.clientX,startY:e.clientY,active:false,pointerId:e.pointerId,timer:setTimeout(()=>{const f=state.files.find(x=>x.id===id);if(!f)return;touchDrag.active=true;const ghost=document.createElement('div');ghost.className='drag-ghost';ghost.textContent=f.name;document.body.appendChild(ghost);touchDrag.ghost=ghost;positionGhost(e.clientX,e.clientY);navigator.vibrate?.(35);},250)};}
function positionGhost(x,y){if(touchDrag?.ghost){touchDrag.ghost.style.left=`${x}px`;touchDrag.ghost.style.top=`${y}px`;}}
function moveTouchDrag(e){if(!touchDrag)return;if(!touchDrag.active&&Math.hypot(e.clientX-touchDrag.startX,e.clientY-touchDrag.startY)>12){clearTimeout(touchDrag.timer);touchDrag=null;return;}if(!touchDrag.active)return;e.preventDefault();positionGhost(e.clientX,e.clientY);clearDropTargets();const target=document.elementFromPoint(e.clientX,e.clientY);target?.closest('[data-category-drop],[data-file-id]')?.classList.add('drop-target');}
function endTouchDrag(e){if(!touchDrag)return;clearTimeout(touchDrag.timer);if(touchDrag.active){const target=document.elementFromPoint(e.clientX,e.clientY),f=state.files.find(x=>x.id===touchDrag.id),cat=target?.closest('[data-category-drop]'),card=target?.closest('[data-file-id]');if(cat&&f)moveFilesToCategory([f],cat.dataset.categoryDrop);else if(card&&card.dataset.fileId!==touchDrag.id)reorderByDrop(touchDrag.id,card.dataset.fileId);touchDrag.ghost?.remove();suppressClick=true;setTimeout(()=>suppressClick=false,350);}touchDrag=null;clearDropTargets();}

el.menuBtn.onclick=openDrawer;el.overlay.onclick=closeDrawer;$('#closeDrawerBtn').onclick=closeDrawer;
el.uploadBtn.onclick=()=>el.fileInput.click();el.favoriteFilterBtn.onclick=()=>{state.activeCategory=state.activeCategory==='favorites'?'all':'favorites';clearSelection();render();};
$('#newFileMenuBtn').onclick=()=>{closeDrawer();newTextFile();};$('#categoriesMenuBtn').onclick=()=>{renderCategoryManager();closeDrawer();openDialog(el.categoriesDialog);};
$('#backupVaultMenuBtn').onclick=backupVault;$('#backupFullMenuBtn').onclick=backupFull;$('#restoreMenuBtn').onclick=()=>el.restoreInput.click();
$('#snapshotMenuBtn').onclick=async()=>{await updateSnapshotInfo();closeDrawer();openDialog(el.snapshotDialog);};$('#createSnapshotBtn').onclick=()=>createSnapshot(true);$('#restoreSnapshotBtn').onclick=restoreLatestSnapshot;
el.installMenuBtn.onclick=async()=>{if(deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;}else toast(location.protocol==='file:'?'INSTALLAZIONE SOLO ONLINE':'USA IL MENU DEL BROWSER');};
el.selectModeBtn.onclick=()=>{state.selectionMode=!state.selectionMode;if(!state.selectionMode)state.selected=[];render();};
$('#clearSelectionBtn').onclick=clearSelection;$('#copySelectedBtn').onclick=copySelected;$('#sendSelectedBtn').onclick=()=>openSendDialog(state.selected);$('#moveSelectedBtn').onclick=()=>openMoveDialog(state.selected);$('#deleteSelectedBtn').onclick=()=>deleteFiles(state.selected);
$('#saveEditorBtn').onclick=saveEditor;$('#editorRenameBtn').onclick=()=>editingId&&renameFile(editingId);
$('#addCategoryDialogBtn').onclick=addCategory;

el.fileInput.onchange=e=>{importFiles(e.target.files);e.target.value='';};el.restoreInput.onchange=e=>{const f=e.target.files?.[0];if(f)restoreBackup(f);e.target.value='';};el.searchInput.oninput=()=>{state.query=el.searchInput.value;renderFiles();};
el.categoryRail.addEventListener('click',e=>{const b=e.target.closest('[data-category]');if(!b)return;state.activeCategory=b.dataset.category;clearSelection();render();});
el.categoryRail.addEventListener('dragover',e=>{const chip=e.target.closest('[data-category-drop]');if(chip){e.preventDefault();clearDropTargets();chip.classList.add('drop-target');}});el.categoryRail.addEventListener('drop',nativeDropCategory);el.categoryRail.addEventListener('dragleave',e=>{if(!el.categoryRail.contains(e.relatedTarget))clearDropTargets();});
el.fileList.addEventListener('click',e=>{if(suppressClick)return;const check=e.target.closest('[data-check]');if(check){toggleSelection(check.dataset.check);return;}const favorite=e.target.closest('[data-favorite]');if(favorite){toggleFavorite(favorite.dataset.favorite);return;}const more=e.target.closest('[data-more]');if(more){openActionDialog(more.dataset.more);return;}const open=e.target.closest('[data-open]');if(open)openFile(state.files.find(f=>f.id===open.dataset.open));});
el.fileList.addEventListener('pointerdown',e=>{const handle=e.target.closest('[data-drag-handle]');if(handle){dragMouseAllowed=true;startTouchDrag(e,handle.dataset.dragHandle);return;}const card=e.target.closest('[data-file-id]');if(card&&e.pointerType!=='mouse'&&!e.target.closest('button,input')){clearTimeout(longPressTimer);longPressTimer=setTimeout(()=>{state.selectionMode=true;toggleSelection(card.dataset.fileId);navigator.vibrate?.(25);suppressClick=true;setTimeout(()=>suppressClick=false,350);},520);}});
el.fileList.addEventListener('pointermove',e=>{clearTimeout(longPressTimer);moveTouchDrag(e);});el.fileList.addEventListener('pointerup',e=>{clearTimeout(longPressTimer);endTouchDrag(e);setTimeout(()=>dragMouseAllowed=false,0);});el.fileList.addEventListener('pointercancel',e=>{clearTimeout(longPressTimer);endTouchDrag(e);dragMouseAllowed=false;});
el.fileList.addEventListener('dragstart',nativeDragStart);el.fileList.addEventListener('dragend',e=>{e.target.closest('[data-file-id]')?.classList.remove('dragging');draggedId=null;dragMouseAllowed=false;clearDropTargets();});el.fileList.addEventListener('dragover',e=>{const card=e.target.closest('[data-file-id]');if(card){e.preventDefault();clearDropTargets();card.classList.add('drop-target');}});el.fileList.addEventListener('drop',e=>{const card=e.target.closest('[data-file-id]');if(card){e.preventDefault();const id=e.dataTransfer.getData('text/plain')||draggedId;reorderByDrop(id,card.dataset.fileId);clearDropTargets();}});
el.actionDialog.addEventListener('click',e=>{const a=e.target.closest('[data-file-action]');if(!a||!actionFileId)return;const id=actionFileId;switch(a.dataset.fileAction){case'edit':closeDialog(el.actionDialog);openEditor(id);break;case'rename':renameFile(id);closeDialog(el.actionDialog);break;case'favorite':toggleFavorite(id);closeDialog(el.actionDialog);break;case'send':openSendDialog([id]);break;case'move':closeDialog(el.actionDialog);openMoveDialog([id]);break;case'export':exportFiles([state.files.find(f=>f.id===id)]);closeDialog(el.actionDialog);break;case'select':state.selectionMode=true;toggleSelection(id);closeDialog(el.actionDialog);break;case'delete':closeDialog(el.actionDialog);deleteFiles([id]);break;}});
el.sendDialog.addEventListener('click',e=>{const b=e.target.closest('[data-destination]');if(b)sendFiles(b.dataset.destination);});
el.moveList.addEventListener('click',e=>{const b=e.target.closest('[data-move-category]');if(!b)return;const ids=(el.moveDialog.dataset.fileIds||'').split(',').filter(Boolean),files=ids.map(id=>state.files.find(f=>f.id===id)).filter(Boolean);closeDialog(el.moveDialog);moveFilesToCategory(files,b.dataset.moveCategory);});
el.categoryManager.addEventListener('click',e=>{const r=e.target.closest('[data-rename-category]');if(r)return renameCategory(r.dataset.renameCategory);const d=e.target.closest('[data-delete-category]');if(d)return deleteCategory(d.dataset.deleteCategory);});

document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>{if(e.target.closest('[data-category-drop],#fileList'))return;e.preventDefault();if(e.dataTransfer.files?.length)importFiles(e.dataTransfer.files);});document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();el.searchInput.focus();}if(e.key==='Escape')closeDrawer();});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;el.installMenuBtn.textContent='INSTALLA APP';});

(async()=>{try{await openDB();state=migrateState(await idbGet(STATE_STORE,'state'));}catch(e){console.warn('IndexedDB non disponibile',e);db=null;}await requestPersistentStorage();await updateSnapshotInfo();render();registerServiceWorker();})();
})();
