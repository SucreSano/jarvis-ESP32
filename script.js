import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { getDatabase, ref, onValue, update, set, push, remove, serverTimestamp, query, limitToLast } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const daysNames = ['D','L','M','M','J','V','S'];
const relayCount = 8;
let dataRelays = {};
let dataSchedules = {};
let dataHistory = {};
let deviceConnection = {};
let offListeners = [];
let toastHandle;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastHandle); toastHandle = setTimeout(() => el.classList.remove('visible'), 3600);
}
function setOnline(connected) {
  const box = $('connectionStatus');
  box.classList.toggle('connected', connected);
  box.querySelector('span').textContent = connected ? 'ESP32 conectado' : 'ESP32 sin conexión';
}
function deviceLastSeen() {
  const relayTimes = Object.values(dataRelays || {})
    .map(item => Number(item?.ultimaConexion || 0))
    .filter(n => Number.isFinite(n) && n > 0);
  return Math.max(Number(deviceConnection?.ultimaConexion || 0),
                  ...(relayTimes.length ? relayTimes : [0]));
}
function isDeviceOnline() {
  const last = deviceLastSeen();
  const age = Date.now() - last;
  // Latido nominal firmware v3.1: ~25 s. Margen para WiFi irregular.
  return last > 0 && age >= 0 && age < 90000;
}
function updateConnectionStatus() {
  const online = isDeviceOnline();
  setOnline(online);
  $('deviceStatus').textContent = online ? 'Conectado' : 'Sin conexión';
  // La falta de conexión no convierte el último estado conocido en "apagado".
  renderRelays();
}
setInterval(updateConnectionStatus, 10000);
function relayState(data) {
  if (typeof data?.estado === 'boolean') return data.estado;
  if (data?.estado === 'encendido') return true;
  if (data?.estado === 'apagado') return false;
  return null;
}
function relayIsPending(data) {
  // La confirmación de una orden web NO sustituye el estado físico.
  return typeof data?.solicitud === 'string' &&
         data.solicitud.length > 0 &&
         data.solicitud !== data.confirmacion;
}
let relaysLoaded = false;
let relaysReadError = '';
function setRelayDataStatus(message, isError = false) {
  const status = $('relayDataStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function newRequestId() {
  return 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}
function renderRelays() {
  const grid = $('relayGrid'); grid.replaceChildren();
  const online = isDeviceOnline();
  let enabled = 0;
  for (let index = 1; index <= relayCount; index++) {
    const key = `rele${index}`;
    const item = dataRelays[key] || {};
    const state = relayState(item);
    if (state === true) enabled++;
    const pending = relayIsPending(item);
    const container = document.createElement('article'); container.className = 'panel relay-card';
    const top = document.createElement('div'); top.className = 'relay-card-top';
    const ico = document.createElement('div'); ico.className = 'relay-icon'; ico.textContent = '⏻';
    const toggle = document.createElement('button'); toggle.className = 'switch'; toggle.type = 'button';
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `Cambiar relé ${index}`);
    toggle.setAttribute('aria-checked', String(state === true));
    toggle.disabled = !online || !relaysLoaded || Boolean(relaysReadError) || state === null || pending;
    toggle.title = !online ? 'ESP32 sin conexión: último estado conocido' :
      (toggle.disabled ? 'Orden pendiente o lectura no disponible' : `Cambiar relé ${index}`);
    toggle.onclick = () => changeRelay(index, !(state === true));
    top.append(ico,toggle);
    const name = document.createElement('h3'); name.textContent = `Relé ${index}`;
    const meta = document.createElement('div'); meta.className = 'relay-meta';
    const nameState = document.createElement('span'); nameState.textContent = 'CANAL ' + String(index).padStart(2,'0');
    const status = document.createElement('span');
    status.className = 'state' + (state === true ? ' on' : '');
    status.textContent = state === null ? 'Sin datos' :
      (!online ? `Último estado: ${state ? 'encendido' : 'apagado'}` :
                 (state ? 'Encendido' : 'Apagado'));
    meta.append(nameState,status);
    container.append(top,name,meta);
    if (pending) {
      const confirmation = document.createElement('div');
      confirmation.className = 'pending-note';
      confirmation.textContent = 'Orden web por confirmar';
      container.append(confirmation);
    }
    grid.append(container);
  }
  $('activeCount').innerHTML = `${enabled} <span>/ 8${online ? '' : ' (última lectura)'}</span>`;
  $('allOn').disabled = !online || !relaysLoaded || Boolean(relaysReadError);
  $('allOff').disabled = !online || !relaysLoaded || Boolean(relaysReadError);
}
async function changeRelay(index, value) {
  if (!isDeviceOnline() || !relaysLoaded || relaysReadError ||
      relayIsPending(dataRelays[`rele${index}`]) ||
      relayState(dataRelays[`rele${index}`]) === null) {
    toast('ESP32 sin conexión, orden pendiente o lectura no válida.');
    return;
  }
  try {
    await update(ref(database,`reles/rele${index}`), { orden: value, solicitud: newRequestId() });
    toast(`Orden enviada al relé ${index}. Esperando confirmación física.`);
  } catch (error) { toast('No se pudo enviar la orden: ' + error.message); }
}
async function changeAll(value) {
  if (!isDeviceOnline() || !relaysLoaded || relaysReadError) {
    toast('ESP32 sin conexión o lectura de Firebase no válida.');
    return;
  }
  const changes = {};
  for (let i = 1; i <= relayCount; i++) {
    changes[`reles/rele${i}/orden`] = value;
    changes[`reles/rele${i}/solicitud`] = newRequestId();
  }
  try { await update(ref(database),changes); toast('Ocho órdenes enviadas; esperando al ESP32.'); }
  catch (error) { toast('Error al enviar las órdenes: ' + error.message); }
}
function renderSchedules() {
  const rows = Object.entries(dataSchedules || {}).sort((a,b) => a[1].hora?.localeCompare(b[1].hora || '') || 0);
  $('scheduleCount').textContent = rows.filter(([,s])=>s.activo).length;
  const container = $('scheduleList'); container.replaceChildren();
  if (!rows.length) { const p=document.createElement('p'); p.className='muted'; p.textContent='Todavía no hay programaciones.';container.append(p);return; }
  for (const [id,s] of rows) {
    const row=document.createElement('div');row.className='schedule-item';
    const label=document.createElement('div');
    const strong=document.createElement('strong');
    const oneTime=s.tipo==='una_vez';
    strong.textContent=`${oneTime ? humanDate(Number(s.ejecutarEn)) : (s.hora || '--:--')} · Relé ${s.rele} · ${s.encendido ? 'Encender' : 'Apagar'}`;
    const small=document.createElement('small');
    const detail = oneTime ? 'Una sola vez' : (s.dias || []).map(d=>daysNames[d]||'?').join(' · ');
    small.textContent = `${detail} · ${s.estado || (s.activo ? 'pendiente' : 'inactiva')}`;
    label.append(strong,small);
    const actions=document.createElement('div');actions.className='schedule-actions';
    const toggle=document.createElement('button');toggle.className='subtle-button';toggle.textContent=s.activo ? 'Pausar' : 'Activar';toggle.onclick=async()=>{try{await update(ref(database,`programaciones/${id}`),{activo:!s.activo})}catch(e){toast(e.message)}};
    const del=document.createElement('button');del.className='subtle-button';del.textContent='Cancelar';del.onclick=async()=>{if(!confirm('¿Cancelar esta programación?'))return;try{await update(ref(database,`programaciones/${id}`),{activo:false,estado:'cancelada'})}catch(e){toast(e.message)}};
    actions.append(toggle,del);row.append(label,actions);container.append(row);
  }
}
function humanDate(timestamp) {
  if (typeof timestamp !== 'number') return 'Sin fecha';
  return new Intl.DateTimeFormat('es-BO',{dateStyle:'short',timeStyle:'short',timeZone:'America/La_Paz'}).format(new Date(timestamp));
}
function renderHistory() {
  const entries = Object.entries(dataHistory || {}).map(([key,val])=>({key,...val})).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  const count = Array(8).fill(0);
  for (const entry of entries) if (entry.encendido === true && Number.isInteger(entry.rele) && entry.rele >= 1 && entry.rele <= 8) count[entry.rele - 1]++;
  const max = Math.max(1,...count), barBox=$('bars');barBox.replaceChildren();
  for(let i=0;i<8;i++) {
    const row=document.createElement('div'); row.className='bar-line';
    const n=document.createElement('span');n.textContent=`Relé ${i+1}`;
    const track=document.createElement('div');track.className='bar-track';
    const fill=document.createElement('div');fill.className='bar-fill';fill.style.width=`${count[i]/max*100}%`;track.append(fill);
    const total=document.createElement('b');total.textContent=count[i];row.append(n,track,total);barBox.append(row);
  }
  const events=$('events');events.replaceChildren();
  if(!entries.length){const p=document.createElement('p');p.className='muted';p.textContent='Sin eventos confirmados por ESP32.';events.append(p);return;}
  for(const e of entries.slice(0,12)){
    const row=document.createElement('div');row.className='event';
    const name=document.createElement('span');name.textContent=`Relé ${e.rele} · ${e.encendido?'Encendido':'Apagado'}`;
    const when=document.createElement('small');when.textContent=humanDate(e.timestamp);
    row.append(name,when);events.append(row);
  }
}
function watch(path, callback, constraint) {
  const dbref = constraint ? query(ref(database, path), limitToLast(constraint)) : ref(database, path);
  offListeners.push(onValue(dbref, snap => callback(snap.val()), error => {
    console.error(`[Jarvis] Falló la lectura de /${path}`, error);
    if (path === 'reles') {
      relaysLoaded = false;
      relaysReadError = error.code || error.message || 'error desconocido';
      dataRelays = {};
      setRelayDataStatus(`ERROR al leer /reles: ${relaysReadError}. Comprueba el UID del administrador y las reglas de Realtime Database.`, true);
      renderRelays();
    }
    toast(`Error Firebase /${path}: ${error.code || error.message}`);
  }));
}
function watchData() {
  watch('reles', v => {
    relaysLoaded = true;
    relaysReadError = '';
    dataRelays = v || {};
    const count = Object.keys(dataRelays).filter(key => /^rele[1-8]$/.test(key)).length;
    setRelayDataStatus(count > 0
      ? `Lectura de Firebase correcta: ${count} relé(s) encontrados en /reles.`
      : 'Firebase respondió, pero la ruta /reles no tiene registros.');
    renderRelays();
    updateConnectionStatus();
  });
  watch('dispositivo', v => {deviceConnection = v || {}; updateConnectionStatus();});
  watch('programaciones', v => {dataSchedules = v || {}; renderSchedules();});
  watch('historial', v => {dataHistory = v || {}; renderHistory();}, 200);
}
function resetData() {
  offListeners.forEach(off => off());
  offListeners = [];
  dataRelays = {}; dataSchedules = {}; dataHistory = {}; deviceConnection = {};
  relaysLoaded = false; relaysReadError = '';
  setOnline(false);
  setRelayDataStatus('Esperando respuesta de Firebase para /reles…');
  renderRelays();
}

$('loginForm').onsubmit=async(e)=>{e.preventDefault();$('loginFeedback').textContent='';try{await signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value)}catch(error){$('loginFeedback').textContent='No se pudo iniciar sesión. Revisa el correo, la contraseña y los permisos.';console.error(error.code)}};
$('logout').onclick=()=>signOut(auth).catch(e=>toast(e.message));
$('allOn').onclick=()=>changeAll(true);$('allOff').onclick=()=>changeAll(false);
for(let i=1;i<=8;i++){const option=document.createElement('option');option.value=String(i);option.textContent=`Relé ${i}`;$('scheduleRelay').append(option)}
$('scheduleForm').onsubmit=async(e)=>{
  e.preventDefault();const days=[...$('scheduleDays').querySelectorAll('input:checked')].map(x=>Number(x.value));
  if(!days.length){$('scheduleFeedback').textContent='Selecciona al menos un día.';return}
  try{
    await set(push(ref(database,'programaciones')),{rele:Number($('scheduleRelay').value),encendido:$('scheduleAction').value==='true',tipo:'semanal',origen:'web',estado:'pendiente',hora:$('scheduleTime').value,dias:days,activo:true,creadoEn:serverTimestamp()});
    $('scheduleFeedback').textContent='Programación guardada en Firebase.';
  }catch(error){$('scheduleFeedback').textContent='No se pudo guardar: '+error.message}
};
// Temporizador de una sola ejecucion; se ejecutara localmente cuando el ESP32 lo sincronice.
const onceRelay=$('onceRelay');
for(let i=1;i<=8;i++){const option=document.createElement('option');option.value=String(i);option.textContent=`Relé ${i}`;onceRelay.append(option)}
$('onceForm').onsubmit=async(e)=>{
  e.preventDefault();
  const seconds=Number($('onceMinutes').value)*60;
  if(!Number.isFinite(seconds)||seconds<60||seconds>86400){$('onceFeedback').textContent='Elige entre 1 y 1440 minutos.';return}
  try {
    await set(push(ref(database,'programaciones')),{rele:Number(onceRelay.value),encendido:$('onceAction').value==='true',tipo:'una_vez',origen:'web',estado:'pendiente',activo:true,ejecutarEn:Date.now()+seconds*1000,creadoEn:serverTimestamp()});
    $('onceFeedback').textContent='Temporizador enviado. Se aplicará cuando el ESP32 sincronice.';
  } catch(error){$('onceFeedback').textContent='Error: '+error.message}
};
for(const btn of document.querySelectorAll('.tab'))btn.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('selected',x===btn));document.querySelectorAll('.tab-panel').forEach(x=>x.hidden=x.id!==btn.dataset.tab)};
const theme=localStorage.getItem('jarvis-theme')||'dark';document.documentElement.classList.toggle('light',theme==='light');
$('themeToggle').onclick=()=>{const isLight=document.documentElement.classList.toggle('light');localStorage.setItem('jarvis-theme',isLight?'light':'dark')};
onAuthStateChanged(auth,user=>{resetData();$('loginPanel').hidden=!!user;$('dashboard').hidden=!user;$('logout').hidden=!user;if(user)watchData()});
