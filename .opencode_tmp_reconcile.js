const fs = require('fs');
const RAW_PATH = 'C:/Users/Nakshatra V/Downloads/raw-export_V1.3_10Sept-18Sept2026.json';
const PROD_PATH = 'C:/Users/Nakshatra V/Downloads/Production_V1.3_10Sept-18Sept2026.json';

const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
const prod = JSON.parse(fs.readFileSync(PROD_PATH, 'utf8'));

const toStr = (x) => (x === undefined || x === null) ? undefined : String(x);
const pick = (o, ...ks) => { for (const k of ks) { const v = o && typeof o === 'object' ? o[k] : undefined; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };

const rawIds = raw.map(q => toStr(q.id));
const prodIds = prod.map(q => toStr(q.id));
const rawSet = new Set(rawIds);
const prodSet = new Set(prodIds);

const common = [...rawSet].filter(id => prodSet.has(id));
const rawOnly = [...rawSet].filter(id => !prodSet.has(id));
const prodOnly = [...prodSet].filter(id => !rawSet.has(id));

console.log('=== RAW V1.3  === ' + raw.length + ' records (' + rawSet.size + ' distinct)');
console.log('=== PROD V1.3 === ' + prod.length + ' records (' + prodSet.size + ' distinct)');
console.log('Common      = ' + common.length);
console.log('Raw-only    = ' + rawOnly.length);
console.log('Prod-only   = ' + prodOnly.length);

const rawMap = new Map(raw.map(q => [toStr(q.id), q]));
const prodMap = new Map(prod.map(q => [toStr(q.id), q]));

// ============ A. RAW-ONLY (51) — from RAW file metadata ============
console.log('\n========== A. RAW-ONLY = ' + rawOnly.length + ' ==========');
console.log('raw-only fields available:', Object.keys(rawMap.get(rawOnly[0]) || {}).join(', '));
const stB = {}, datB = {}, secB = {}, catB = {};
for (const id of rawOnly) {
  const q = rawMap.get(id);
  const st = pick(q, 'review_status', 'reviewStatus', 'status', 'validator_status', 'review_result', 'formation_ok_status') || '(none)';
  stB[st] = (stB[st] || 0) + 1;
  const dt = pick(q, 'created_at', 'createdAt') || pick(q, 'updated_at', 'updatedAt') || '';
  const k = dt ? String(dt).slice(0, 10) : '(none)'; datB[k] = (datB[k] || 0) + 1;
  const sec = pick(q, 'Section', 'section', 'sectionName') || '(none)'; secB[sec] = (secB[sec] || 0) + 1;
  const cat = pick(q, 'category', 'Category') || '(none)'; catB[cat] = (catB[cat] || 0) + 1;
}
console.log('  review_status :', JSON.stringify(stB));
console.log('  created/upd   :', JSON.stringify(datB));
console.log('  Section       :', JSON.stringify(secB));
console.log('  Category      :', JSON.stringify(catB));

// ============ B. PROD-ONLY (390) ============
console.log('\n========== B. PROD-ONLY = ' + prodOnly.length + ' ==========');
console.log('prod-only fields available (first):', Object.keys(prodMap.get(prodOnly[0]) || {}).join(', '));

// 1. exact content twins within COMMON set (same question+choices+correct_answer, different id)
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const contentKey = q => norm(pick(q, 'question', 'Question', 'QuestionText', 'stem') || '') + '||' + norm(JSON.stringify(pick(q, 'choices', 'Choices', 'choice') || {})) + '||' + norm(pick(q, 'correct_answer', 'correctAnswer', 'CorrectAnswer') || '');
const commonContent = new Map();
for (const id of common) {
  const q = rawMap.get(id);
  const k = contentKey(q);
  if (k && !commonContent.has(k)) commonContent.set(k, id);
}
let twins = 0; const twinList = [];
for (const id of prodOnly) {
  const k = contentKey(prodMap.get(id));
  const t = commonContent.get(k);
  if (t) { twins++; if (twinList.length < 15) twinList.push([id, t]); }
}
console.log('  prod-only = EXACT content twin of a common question (different id): ' + twins);
twinList.forEach(([a, b]) => console.log('     ' + a + ' <-> ' + b));

// 2. passage presence
let poPass = 0, coPass = 0;
for (const id of prodOnly) if (pick(prodMap.get(id), 'passage', 'Passage', 'stimulus', 'Stimulus')) poPass++;
for (const id of common) if (pick(rawMap.get(id), 'passage', 'Passage', 'stimulus', 'Stimulus')) coPass++;
console.log('  prod-only with passage/stimulus : ' + poPass + '/' + prodOnly.length);
console.log('  common    with passage/stimulus : ' + coPass + '/' + common.length);

// 3. section / difficulty / category on prod-only (lean schema may still carry difficulty + Section)
const pSec = {}, pDiff = {}, pCat = {};
for (const id of prodOnly) {
  const q = prodMap.get(id);
  const sec = pick(q, 'Section', 'section', 'section_name') || '(none)'; pSec[sec] = (pSec[sec] || 0) + 1;
  const d = pick(q, 'difficulty', 'Difficulty') || '(none)'; pDiff[d] = (pDiff[d] || 0) + 1;
  const c = pick(q, 'category', 'Category') || '(none)'; pCat[c] = (pCat[c] || 0) + 1;
}
console.log('  Section   :', JSON.stringify(pSec));
console.log('  Difficulty:', JSON.stringify(pDiff));
console.log('  Category  :', JSON.stringify(Object.keys(pCat).length));
