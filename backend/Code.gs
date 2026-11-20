/**
 * Gestalt Explorer — backend GenAI (Google Apps Script)
 * ------------------------------------------------------------------
 * Menerima permintaan dari halaman Gestalt Explorer (GitHub Pages),
 * menyusun prompt DI SERVER, memanggil Gemini API dengan API key yang
 * disimpan di Script Properties, lalu mengembalikan spesifikasi
 * tantangan visual (JSON).
 *
 * Keamanan:
 * - API key tidak pernah dikirim ke browser.
 * - Prompt disusun di server: endpoint ini tidak bisa dipakai sebagai chatbot bebas.
 * - Batas pemakaian: 30 permintaan/menit dan 800 permintaan/hari (bisa diubah di bawah).
 *
 * Pengaturan (Project Settings → Script Properties):
 *   GEMINI_API_KEY : API key dari Google AI Studio (wajib)
 *   GEMINI_MODEL   : (opsional) paksa ID model tertentu; kosongkan agar dipilih otomatis
 */

const KEYS = ['proximity', 'similarity', 'closure', 'continuity', 'figure-ground'];
const PER_MINUTE = 30;
const PER_DAY = 800;

/* ---------- endpoint ---------- */
function doGet() {
  try {
    const key = apiKey_();
    return out_({ ok: true, service: 'gestalt-explorer-ai', models: key ? models_(key) : 'GEMINI_API_KEY belum diisi' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const key = apiKey_();
    if (!key) return out_({ error: 'GEMINI_API_KEY belum diisi di Script Properties', code: 'config' });
    if (!allow_()) return out_({ error: 'Batas permintaan tercapai. Coba lagi beberapa saat lagi.', code: 'rate_limited' });

    let body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) {}
    const target = KEYS.indexOf(body.target) >= 0 ? body.target : 'random';
    const recent = (Array.isArray(body.recent) ? body.recent : []).slice(-4).map(r => clean_(r, 80));
    const weak = (Array.isArray(body.weak) ? body.weak : []).filter(k => KEYS.indexOf(k) >= 0);

    const spec = callGemini_(key, buildPrompt_(target, recent, weak));
    if (KEYS.indexOf(spec.principle) < 0) return out_({ error: 'Prinsip dari model tidak valid', code: 'upstream' });
    if (target !== 'random' && spec.principle !== target) return out_({ error: 'Prinsip dari model tidak sesuai target', code: 'upstream' });
    return out_(spec);
  } catch (err) {
    return out_({ error: String(err && err.message || err), code: 'upstream' });
  }
}

/* ---------- jalankan sekali dari editor untuk menguji & memberi izin ---------- */
function tesGemini() {
  const key = apiKey_();
  if (!key) throw new Error('Isi GEMINI_API_KEY dulu di Project Settings → Script Properties.');
  Logger.log('Model yang dipakai (urutan prioritas): ' + models_(key).join(', '));
  const t0 = Date.now();
  const spec = callGemini_(key, buildPrompt_('random', [], []));
  Logger.log('Waktu membuat 1 tantangan: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' detik');
  Logger.log('Contoh tantangan dari GenAI:\n' + JSON.stringify(spec, null, 2));
}

/* ---------- helpers ---------- */
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function apiKey_() {
  return (PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '').trim();
}
function clean_(v, n) {
  return String(v || '').replace(/[^\p{L}\p{N}\s:,.\-–]/gu, '').slice(0, n);
}
function allow_() {
  const lock = LockService.getScriptLock();
  lock.tryLock(3000);
  try {
    const cache = CacheService.getScriptCache();
    const props = PropertiesService.getScriptProperties();
    const mKey = 'm' + Math.floor(Date.now() / 60000);
    const dKey = 'count_' + new Date().toISOString().slice(0, 10);
    const nm = Number(cache.get(mKey) || 0), nd = Number(props.getProperty(dKey) || 0);
    if (nm >= PER_MINUTE || nd >= PER_DAY) return false;
    cache.put(mKey, String(nm + 1), 120);
    props.setProperty(dKey, String(nd + 1));
    return true;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/** Daftar model Gemini yang tersedia untuk API key ini, diurutkan otomatis (Flash stabil terbaru lebih dulu). */
function models_(key) {
  const forced = (PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || '').trim();
  if (forced) return [forced];
  const cache = CacheService.getScriptCache();
  const hit = cache.get('models');
  if (hit) return JSON.parse(hit);
  const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('Gagal membaca daftar model (' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 200));
  const names = (JSON.parse(r.getContentText()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => String(m.name).replace(/^models\//, ''))
    .filter(n => /^gemini-/.test(n));
  const score = n => {
    let s = 0;
    if (/flash/.test(n)) s += 100;
    if (/lite/.test(n)) s -= 5;
    if (/latest/.test(n)) s += 2;
    if (/preview|exp|tts|image|audio|live|thinking|embedding|native|computer|robotics/.test(n)) s -= 200;
    const v = (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
    return s + (v ? parseFloat(v) * 10 : 0);
  };
  const ranked = names.sort((a, b) => score(b) - score(a)).slice(0, 5);
  if (!ranked.length) throw new Error('Tidak ada model Gemini yang tersedia untuk API key ini.');
  cache.put('models', JSON.stringify(ranked), 21600);
  return ranked;
}

function callGemini_(key, prompt) {
  const models = models_(key);
  let lastErr = '';
  for (let i = 0; i < models.length; i++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[i]) + ':generateContent';
    const base = { responseMimeType: 'application/json', temperature: 1, maxOutputTokens: 2048 };
    const post = cfg => UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: cfg })
    });
    // Tugas ini sederhana: matikan mode "berpikir" agar respons cepat.
    // Jika model tidak mengenal pengaturan ini (HTTP 400), ulangi tanpa pengaturan tersebut.
    let r = post(Object.assign({}, base, { thinkingConfig: { thinkingBudget: 0 } }));
    if (r.getResponseCode() === 400) r = post(base);
    const code = r.getResponseCode();
    if (code !== 200) { lastErr = models[i] + ' → HTTP ' + code + ': ' + r.getContentText().slice(0, 160); continue; }
    const data = JSON.parse(r.getContentText());
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || '').join('');
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) { lastErr = models[i] + ' → respons tanpa JSON'; continue; }
    try { return JSON.parse(text.slice(a, b + 1)); } catch (_) { lastErr = models[i] + ' → JSON tidak valid'; }
  }
  CacheService.getScriptCache().remove('models');
  throw new Error('Semua model gagal. Terakhir: ' + lastErr);
}

function buildPrompt_(target, recent, weak) {
  return 'Kamu adalah generator latihan visual untuk mahasiswa Desain Komunikasi Visual yang mempelajari prinsip Gestalt. Buat SATU tantangan identifikasi baru.\n\n' +
    'Prinsip target: ' + (target === 'random'
      ? 'pilih salah satu dari proximity, similarity, closure, continuity, figure-ground' + (weak.length ? '. Utamakan prinsip yang sering salah dijawab mahasiswa: ' + weak.join(', ') : '')
      : target) + '.\n' +
    'Hindari mengulang tantangan terakhir: ' + (recent.length ? recent.join('; ') : '-') + '.\n\n' +
    'Aturan:\n' +
    '- Bahasa Indonesia yang jelas dan akademis; nama prinsip tetap dalam bahasa Inggris (Proximity, Similarity, Closure, Continuity, Figure-Ground).\n' +
    '- Jangan memakai unsur budaya lokal/daerah; gunakan konteks desain umum (aplikasi, poster, infografis, logo, kemasan, signage).\n' +
    '- Komposisi digambar oleh renderer dari parameter. Pilih parameter sehingga prinsip target menjadi variabel pembeda yang paling dominan (contoh: proximity → bentuk & warna seragam, hanya jarak yang berbeda; similarity → jarak seragam, hanya atribut yang berbeda).\n' +
    '- Jangan menyebut nama prinsip jawaban di "title", "scenario", "question", atau "hint".\n\n' +
    'Skema "params" per prinsip (patuhi rentang):\n' +
    '- proximity: {"variant":"row"|"column"|"grid","groups":2-5,"perGroup":2-6,"gap":1.2-3.0,"shape":"circle"|"square"|"triangle","color":"#RRGGBB"}\n' +
    '- similarity: {"variant":"rows"|"cols"|"checker"|"diagonal","rows":3-6,"cols":3-7,"mode":"color"|"shape"|"both","colors":["#RRGGBB","#RRGGBB"],"shapes":["circle"|"square"|"triangle","circle"|"square"|"triangle"]}\n' +
    '- closure: {"variant":"kanizsa"|"kanizsa-square"|"broken-circle"|"dashed-square","pieces":4-12,"gap":0.15-0.6,"color":"#RRGGBB"}\n' +
    '- continuity: {"variant":"crossing"|"occluded-wave"|"spiral","beads":14-40,"color":"#RRGGBB","occluderColor":"#RRGGBB"}\n' +
    '- figure-ground: {"variant":"vase"|"negative-plus","figureColor":"#RRGGBB","groundColor":"#RRGGBB"} (kontras tinggi)\n' +
    'Palet yang disarankan: netral (#151515, #a8a196, #fffdf7) dengan aksen (#ff4757, #2e6bff, #ffbe0b, #8b5cf6, #10b981).\n\n' +
    'Balas HANYA dengan satu objek JSON valid, tanpa teks lain:\n' +
    '{"principle":"proximity|similarity|closure|continuity|figure-ground","title":"judul singkat ≤ 6 kata","scenario":"1 kalimat konteks desain nyata","params":{...},"question":"pertanyaan identifikasi","hint":"petunjuk tanpa membocorkan jawaban","explanation":"2–3 kalimat: mengapa prinsip ini dominan, variabel visual apa yang bekerja, dan kaitannya dengan skenario"}';
}
