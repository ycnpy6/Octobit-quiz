'use strict';
// Validates questions/*.json. Exits 1 on any error; warnings don't fail.
// Usage: node scripts/validate-questions.js [file ...]   (default: every level)
const fs = require('fs');
const path = require('path');
const { LEVELS, domainOf } = require('../game');

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : LEVELS.map((l) => path.join(__dirname, '..', 'questions', `${l}.json`));
const errors = [];
const warnings = [];
const ids = new Map();
const texts = new Map();
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

for (const file of files) {
  const name = path.basename(file);
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push(`${name}: ${e.message}`); continue; }
  if (!Array.isArray(list)) { errors.push(`${name}: must be a JSON array`); continue; }
  const counts = [0, 0, 0, 0];
  list.forEach((q, i) => {
    const at = `${name} #${i + 1}${q && q.id ? ` (${q.id})` : ''}`;
    if (!q || typeof q !== 'object') return errors.push(`${at}: not an object`);
    for (const f of ['id', 'category', 'text']) if (!nonEmpty(q[f])) errors.push(`${at}: empty or missing "${f}"`);
    if (nonEmpty(q.category) && !domainOf(q.category)) errors.push(`${at}: category "${q.category}" is in no domain (see DOMAINS in game.js)`);
    if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(`${at}: needs exactly 4 options`);
    else {
      if (!q.options.every(nonEmpty)) errors.push(`${at}: empty option`);
      if (new Set(q.options.map((o) => String(o).trim().toLowerCase())).size !== 4) errors.push(`${at}: options are not distinct`);
      if (q.options.some((o) => /all of the above|none of the above/i.test(o))) warnings.push(`${at}: avoid "all/none of the above"`);
    }
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) errors.push(`${at}: "correct" must be 0-3`);
    else counts[q.correct]++;
    if (nonEmpty(q.id)) {
      if (ids.has(q.id)) errors.push(`${at}: duplicate id (also in ${ids.get(q.id)})`);
      ids.set(q.id, name);
    }
    if (q.code !== undefined) {
      if (!nonEmpty(q.code)) errors.push(`${at}: "code" must be a non-empty string`);
      else {
        const lines = q.code.split('\n');
        if (lines.length > 12) warnings.push(`${at}: code is ${lines.length} lines (aim for 12 or fewer)`);
        if (lines.some((l) => l.length > 60)) warnings.push(`${at}: a code line is over 60 chars`);
      }
    }
    if (nonEmpty(q.text)) {
      const key = `${q.text.trim().toLowerCase()}\n${q.code || ''}`; // same prompt is fine with different code
      if (texts.has(key)) errors.push(`${at}: duplicate text (also in ${texts.get(key)})`);
      texts.set(key, at);
      if (q.text.length > 140) warnings.push(`${at}: text is ${q.text.length} chars (aim for < 140)`);
    }
  });
  const max = Math.max(...counts);
  if (list.length && max / list.length > 0.4) errors.push(`${name}: correct-index skew ${counts.join('/')} (max ${Math.round((100 * max) / list.length)}% > 40%)`);
  if (list.length < 30) warnings.push(`${name}: only ${list.length} questions (aim for 30+)`);
  console.log(`${name}: ${list.length} questions, correct index A/B/C/D = ${counts.join('/')}`);
}

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `\n${errors.length} error(s).` : '\nAll question files are valid.');
process.exit(errors.length ? 1 : 0);
