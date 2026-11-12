// probe.js - browser side of the iOS Safari probe (Vikunja #4060). Runs the checks on one tap and renders PASS/FAIL.
// Uses the REAL app modules (static/lib.js, voice.js, durability.js) so a pass here means the app code path works.
// Nothing is uploaded: results stay on the page and in the clipboard when "Copy report" is tapped.
import { mixToMono, trimSilence, encodeWav } from '../../static/lib.js';
import { pickVoice, loadVoices, speak, langOf } from '../../static/voice.js';
import { requestPersistence, isInstalled, platformOf } from '../../static/durability.js';
import { runCheck, validateWav, buildReport } from './report.js';

const $ = (id) => document.getElementById(id);
const RATE = 22050;
let lastReport = null;
let wavBytes = null; // the 3 s recording, reused by the IndexedDB check

/** Record 3 s with MediaRecorder, decode with AudioContext, encode with lib.js, validate the WAV. */
async function checkRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) return { status: 'fail', detail: 'MediaRecorder or getUserMedia missing' };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((res) => { mr.onstop = res; });
    mr.start();
    await new Promise((r) => setTimeout(r, 3000));
    mr.stop();
    await stopped;
    const blob = new Blob(chunks, { type: mr.mimeType });
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, RATE);
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = mixToMono(Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)));
    const len = Math.max(1, Math.ceil((mono.length * RATE) / decoded.sampleRate));
    const off = new OfflineAudioContext(1, len, RATE);
    const buf = off.createBuffer(1, mono.length, decoded.sampleRate);
    buf.copyToChannel(mono, 0);
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    const samples = (await off.startRendering()).getChannelData(0);
    void trimSilence; // imported to prove the module loads; the probe keeps the full 3 s
    wavBytes = new Uint8Array(encodeWav(samples, RATE));
    const v = validateWav(wavBytes, { rate: RATE });
    // Playback: an <audio> element must accept the blob URL and report a duration.
    const url = URL.createObjectURL(new Blob([wavBytes], { type: 'audio/wav' }));
    const a = new Audio(url);
    const dur = await new Promise((res) => { a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(NaN); a.load(); });
    URL.revokeObjectURL(url);
    return {
      status: v.ok && dur > 1 ? 'pass' : 'fail',
      detail: v.ok ? `mimeType ${mr.mimeType || '(none)'}, wav ${wavBytes.length} bytes, playable duration ${Number(dur).toFixed(2)} s` : v.reason,
      data: { mimeType: mr.mimeType, wavBytes: wavBytes.length, decodedRate: decoded.sampleRate, duration: dur },
    };
  } finally { stream.getTracks().forEach((t) => t.stop()); }
}

/** Store the WAV as a Blob in IndexedDB, read it back, compare sizes. */
async function checkIndexedDb() {
  if (!wavBytes) return { status: 'skip', detail: 'no recording to store (recording check failed)' };
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('ios-probe', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const put = () => new Promise((res, rej) => { const t = db.transaction('clips', 'readwrite'); t.objectStore('clips').put(new Blob([wavBytes], { type: 'audio/wav' }), 'k'); t.oncomplete = res; t.onerror = () => rej(t.error); });
  const get = () => new Promise((res, rej) => { const r = db.transaction('clips').objectStore('clips').get('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await put();
  const back = await get();
  const bytes = back ? new Uint8Array(await back.arrayBuffer()) : null;
  db.close();
  indexedDB.deleteDatabase('ios-probe');
  const same = bytes && bytes.length === wavBytes.length && validateWav(bytes, { rate: RATE }).ok;
  return { status: same ? 'pass' : 'fail', detail: back ? `read back ${bytes.length} bytes (${back.type})` : 'nothing read back' };
}

async function checkPersist() {
  const p = await requestPersistence();
  // persist() is allowed to say no; that is a finding, not a probe failure. Fail only if the API is missing.
  return { status: p.supported ? 'pass' : 'fail', detail: `persisted=${p.persisted}, usage=${p.usage}, quota=${p.quota}`, data: p };
}

async function checkVoice() {
  const synth = window.speechSynthesis;
  if (!synth) return { status: 'fail', detail: 'speechSynthesis missing' };
  const voices = await loadVoices(synth, 2500);
  const gb = voices.filter((v) => langOf(v) === 'en-gb').map((v) => v.name);
  const chosen = pickVoice(voices);
  if (!chosen) return { status: 'fail', detail: `no usable en-GB voice (${voices.length} voices total)`, data: { total: voices.length, gb } };
  const ok = [await speak(synth, chosen, 'which'), await speak(synth, chosen, 'their')];
  return { status: ok.every(Boolean) ? 'pass' : 'fail', detail: `pickVoice -> ${chosen.name}; spoke which=${ok[0]}, their=${ok[1]}`, data: { chosen: chosen.name, gb, spoke: ok } };
}

async function checkShare() {
  const file = new File([new Uint8Array([83, 80, 76, 76])], 'probe.spellings', { type: 'application/octet-stream' });
  const can = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  return { status: can ? 'pass' : 'fail', detail: `navigator.canShare({files}) = ${can} (the share sheet itself is not opened)` };
}

async function runAll() {
  $('run').disabled = true; $('copy').disabled = true;
  const out = $('out');
  out.textContent = '';
  const results = [];
  const env = {
    userAgent: navigator.userAgent,
    platform: platformOf(navigator.userAgent, navigator.maxTouchPoints),
    standalone: isInstalled(window),
    secureContext: window.isSecureContext,
    when: new Date().toISOString(),
  };
  const checks = [
    ['install-mode', 'Home Screen (standalone) detection', async () => ({ status: 'pass', detail: env.standalone ? 'running from Home Screen' : 'running in a Safari tab' })],
    ['recording', 'MediaRecorder 3 s -> 22.05 kHz mono WAV, plays back', checkRecording],
    ['indexeddb', 'WAV Blob stored and read from IndexedDB', checkIndexedDb],
    ['persist', 'navigator.storage persist() and estimate()', checkPersist],
    ['voice', 'en-GB voice picked and speaks "which", "their"', checkVoice],
    ['share', 'navigator.canShare({files}) with a .spellings file', checkShare],
  ];
  for (const [id, title, fn] of checks) {
    const li = document.createElement('li');
    li.textContent = `${title}: running...`;
    out.appendChild(li);
    const r = await runCheck(id, title, fn);
    results.push(r);
    li.textContent = '';
    const b = document.createElement('b');
    b.className = r.status;
    b.textContent = r.status.toUpperCase();
    const s = document.createElement('small');
    s.textContent = r.detail;
    li.append(b, ` ${title}`, s);
  }
  lastReport = buildReport(env, results);
  $('json').hidden = false;
  $('json').textContent = JSON.stringify(lastReport, null, 2);
  $('run').disabled = false; $('copy').disabled = false;
}

$('run').addEventListener('click', runAll);
$('copy').addEventListener('click', async () => {
  const text = JSON.stringify(lastReport, null, 2);
  try { await navigator.clipboard.writeText(text); $('copy').textContent = 'Copied'; }
  catch { $('json').hidden = false; window.getSelection().selectAllChildren($('json')); $('copy').textContent = 'Select and copy the text below'; }
});
