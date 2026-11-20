/**
 * Gestalt Explorer + Color Lab — GenAI sederhana (Google Apps Script + Gemini)
 * Satu backend untuk dua aplikasi: body {app:'colorlab', ...} → Color Lab, selain itu → Gestalt Explorer.
 * Script Properties: GEMINI_API_KEY = API key dari Google AI Studio
 * Uji: pilih fungsi tesGemini → Run.  Publikasi: Deploy → Web app → Anyone.
 */
const KEYS = ['proximity', 'similarity', 'closure', 'continuity', 'figure-ground'];

function doPost(e) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) return out_({ error: 'GEMINI_API_KEY belum diisi' });
    if (!allow_()) return out_({ error: 'Terlalu banyak permintaan', code: 'rate_limited' });
    let body = {};
    try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) {}
    if (body.app === 'colorlab') return out_(colorLab_(key.trim(), body));
    const target = KEYS.indexOf(body.target) >= 0 ? body.target : KEYS[Math.floor(Math.random() * 5)];
    const spec = ask_(key.trim(), target);
    spec.principle = target;
    return out_(spec);
  } catch (err) {
    return out_({ error: String(err.message || err) });
  }
}

function doGet() { return out_({ ok: true, service: 'gestalt-explorer-ai' }); }

/* ---------- Color Lab ---------- */
const CL_CHARS = ['Tenang', 'Energik', 'Mewah', 'Ramah', 'Profesional', 'Alami', 'Playful', 'Minimalis'];
function colorLab_(key, b) {
  const ch = CL_CHARS.indexOf(b.character) >= 0 ? b.character : CL_CHARS[Math.floor(Math.random() * CL_CHARS.length)];
  if (b.task === 'palette') {
    const base = /^#[0-9a-fA-F]{6}$/.test(b.base || '') ? b.base : '#2A71B0';
    return gemini_(key, 'Kamu membantu mahasiswa Desain Komunikasi Visual. Buat 3 palet warna berbeda, masing-masing 5 warna, berdasarkan warna utama ' + base + ' dan karakter visual "' + ch + '". ' +
      'Setiap palet memakai skema harmoni berbeda (analog, komplementer, triadik, split-komplementer, atau monokromatik). Peran warna: latar, dominan, sekunder, aksen, teks. ' +
      'Pastikan warna teks kontras terhadap latar (rasio WCAG minimal 4.5:1). Jangan memakai unsur budaya lokal. Bahasa Indonesia. Balas HANYA JSON: ' +
      '{"palettes":[{"name":"maks 4 kata","harmony":"nama skema","colors":[{"hex":"#RRGGBB","name":"nama warna","role":"latar|dominan|sekunder|aksen|teks"}],"rationale":"2 kalimat alasan cocok dengan karakter ' + ch + '"}]}');
  }
  const recent = (Array.isArray(b.recent) ? b.recent : []).slice(-4).map(r => String(r).slice(0, 60)).join('; ') || '-';
  return gemini_(key, 'Buat 1 latihan penerapan palet warna untuk mahasiswa DKV: brief desain sederhana (poster atau kartu promosi) dengan karakter visual "' + ch + '". ' +
    'Berikan 3 opsi palet, masing-masing 5 warna HEX berurutan: latar, dominan, sekunder, aksen, teks. Tepat SATU opsi paling sesuai; dua lainnya kurang sesuai dengan alasan jelas (karakter berlawanan, atau kontras teks terhadap latar terlalu rendah). ' +
    'Jangan memakai unsur budaya lokal. Bahasa Indonesia. Hindari mengulang: ' + recent + '. Balas HANYA JSON: ' +
    '{"title":"judul poster maks 3 kata","sub":"subjudul maks 6 kata","cta":"teks tombol maks 2 kata","brief":"1-2 kalimat","character":"' + ch + '","options":[{"colors":["#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB","#RRGGBB"],"why":"1 kalimat"}],"answer":0,"explanation":"2 kalimat"}');
}

function tesColorLab() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY').trim();
  let t = Date.now();
  const pal = colorLab_(key, { task: 'palette', base: '#2A71B0', character: 'Tenang' });
  Logger.log('Palet (' + ((Date.now() - t) / 1000).toFixed(1) + ' detik):\n' + JSON.stringify(pal, null, 2));
  t = Date.now();
  const sc = colorLab_(key, { task: 'scenario', character: 'Energik' });
  Logger.log('Skenario (' + ((Date.now() - t) / 1000).toFixed(1) + ' detik):\n' + JSON.stringify(sc, null, 2));
}

function tesGemini() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Isi GEMINI_API_KEY dulu di Project Settings → Script Properties.');
  CacheService.getScriptCache().remove('models');
  const t = Date.now();
  const spec = ask_(key.trim(), 'closure');
  Logger.log('Model: ' + modelList_(key.trim()).join(', '));
  Logger.log('Waktu: ' + ((Date.now() - t) / 1000).toFixed(1) + ' detik\n' + JSON.stringify(spec, null, 2));
}

/* ---------- inti ---------- */
const PARAMS = {
  proximity: '{"variant":"row|column|grid","groups":2-5,"perGroup":2-6,"gap":1.2-3,"shape":"circle|square|triangle","color":"#hex"}',
  similarity: '{"variant":"rows|cols|checker|diagonal","rows":3-6,"cols":3-7,"mode":"color|shape|both","colors":["#hex","#hex"],"shapes":["circle|square|triangle","circle|square|triangle"]}',
  closure: '{"variant":"kanizsa|kanizsa-square|broken-circle|dashed-square","pieces":4-12,"gap":0.15-0.6,"color":"#hex"}',
  continuity: '{"variant":"crossing|occluded-wave|spiral","beads":14-40,"color":"#hex","occluderColor":"#hex"}',
  'figure-ground': '{"variant":"vase|negative-plus","figureColor":"#hex","groundColor":"#hex"}'
};

function ask_(key, target) {
  const prompt = 'Buat 1 soal latihan prinsip Gestalt "' + target + '" untuk mahasiswa DKV, Bahasa Indonesia, konteks desain umum (aplikasi, poster, logo, infografis), tanpa budaya lokal. ' +
    'Pilih params agar prinsip ini menjadi pembeda utama. Jangan sebut nama prinsip di title/scenario/question/hint. Balas HANYA JSON: ' +
    '{"principle":"' + target + '","title":"maks 6 kata","scenario":"1 kalimat","params":' + PARAMS[target] + ',"question":"1 kalimat","hint":"1 kalimat","explanation":"2 kalimat"}';
  return gemini_(key, prompt);
}

/** Panggil Gemini dan kembalikan objek JSON dari jawabannya. */
function gemini_(key, prompt) {
  const models = modelList_(key);
  let last = '';
  for (let i = 0; i < models.length; i++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent';
    const send = cfg => UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: cfg })
    });
    const cfg = { responseMimeType: 'application/json', temperature: 1, maxOutputTokens: 1600 };
    let r = send(Object.assign({ thinkingConfig: { thinkingBudget: 0 } }, cfg));
    if (r.getResponseCode() === 400) r = send(cfg);
    if (r.getResponseCode() !== 200) { last = models[i] + ' HTTP ' + r.getResponseCode(); continue; }
    try {
      const text = JSON.parse(r.getContentText()).candidates[0].content.parts.map(p => p.text || '').join('');
      return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch (_) { last = models[i] + ' JSON tidak valid'; }
  }
  CacheService.getScriptCache().remove('models');
  throw new Error('Gemini gagal: ' + last);
}

/** Pilih model otomatis: Flash-Lite terbaru dulu (paling cepat), lalu Flash. */
function modelList_(key) {
  const c = CacheService.getScriptCache(), hit = c.get('models');
  if (hit) return JSON.parse(hit);
  const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  const names = (JSON.parse(r.getContentText()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => m.name.replace('models/', ''))
    .filter(n => /^gemini-[\d.]+-flash/.test(n) && !/preview|exp|tts|image|audio|live|thinking/.test(n));
  const score = n => (/lite/.test(n) ? 1000 : 0) + parseFloat(n.match(/gemini-([\d.]+)/)[1]);
  const list = names.sort((a, b) => score(b) - score(a)).slice(0, 3);
  if (!list.length) throw new Error('Tidak ada model Gemini Flash untuk API key ini');
  c.put('models', JSON.stringify(list), 21600);
  return list;
}

function allow_() {
  const c = CacheService.getScriptCache(), k = 'm' + Math.floor(Date.now() / 60000), n = Number(c.get(k) || 0);
  if (n >= 30) return false;
  c.put(k, String(n + 1), 120);
  return true;
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
