#!/usr/bin/env node
// Structural "ears" for a Vamp song: prints per-track and per-bar facts and
// flags common composition problems. Read-only; no dependencies.
// Usage: node analyze-song.mjs song.json [--melody trackId[,trackId]] [--section name:startBar ...]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('usage: node analyze-song.mjs song.json [--melody id,id] [--section intro:0 --section a:2 ...]');
  process.exit(2);
}
const song = JSON.parse(readFileSync(args[0], 'utf8'));
const melodyIds = new Set();
const sections = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--melody') args[++i].split(',').forEach((id) => melodyIds.add(id));
  else if (args[i] === '--section') {
    const [name, bar] = args[++i].split(':');
    sections.push({ name, bar: Number(bar) });
  }
}

const { bpm, timeSignature: ts } = song.meta;
const barBeats = (ts.numerator * 4) / ts.denominator;
const sec = (beats) => (beats * 60) / bpm;
const patterns = new Map((song.patterns ?? []).map((p) => [p.id, p]));
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pname = (p) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

function expand(track) {
  const out = (track.notes ?? []).map((n) => ({ ...n }));
  for (const pl of track.placements ?? []) {
    const pat = patterns.get(pl.pattern);
    if (!pat) continue;
    const len = pat.lengthBeats ?? Math.max(...pat.notes.map((n) => n.start + n.duration));
    for (let r = 0; r < (pl.repeat ?? 1); r++)
      for (const n of pat.notes) out.push({ ...n, start: pl.start + r * len + n.start });
  }
  return out
    .map((n) => ({ ...n, velocity: n.velocity ?? 100 }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

const tracks = song.tracks.filter((t) => !t.mute).map((t) => ({ t, notes: expand(t) }));
const lastBeat = Math.max(...tracks.flatMap(({ notes }) => notes.map((n) => n.start + n.duration)));
const bars = Math.ceil(lastBeat / barBeats);
const issues = [];
const sectionOf = (bar) => [...sections].reverse().find((s) => bar >= s.bar)?.name ?? '';

console.log(`${song.meta.title} | ${bpm} BPM ${ts.numerator}/${ts.denominator} | ${song.meta.key.tonic} ${song.meta.key.mode}`);
console.log(`content ends beat ${lastBeat.toFixed(2)} = ${sec(lastBeat).toFixed(2)} s (${bars} bars); hint ${sec(song.meta.durationHint).toFixed(2)} s\n`);

console.log('TRACKS  notes  range            velocity (min-max, spread)  unique bars');
for (const { t, notes } of tracks) {
  if (!notes.length) continue;
  const ps = notes.map((n) => n.pitch);
  const vs = notes.map((n) => n.velocity);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const barKeys = new Map();
  for (const n of notes) {
    const b = Math.floor(n.start / barBeats);
    const key = `${n.pitch}@${(n.start - b * barBeats).toFixed(3)}/${n.duration}`;
    barKeys.set(b, (barKeys.get(b) ?? '') + key + ';');
  }
  const unique = new Set(barKeys.values()).size;
  const range = t.kind === 'drums' ? 'drums' : `${pname(lo)}-${pname(hi)} (${hi - lo} st)`;
  console.log(
    `${t.id.padEnd(16)}${String(notes.length).padStart(5)}  ${range.padEnd(17)}${`${vmin}-${vmax} (${vmax - vmin})`.padEnd(28)}${unique}/${barKeys.size}`,
  );
  const durs = notes.map((n) => n.duration).sort((a, b) => a - b);
  const sustained = durs[Math.floor(durs.length / 2)] >= 2;
  if (!sustained && notes.length >= 16 && vmax - vmin < 12) issues.push(`${t.id}: velocity spread ${vmax - vmin} is flat; vary accents and phrase dynamics`);
  if (barKeys.size >= 8 && unique / barKeys.size < 0.25)
    issues.push(`${t.id}: only ${unique} distinct bars out of ${barKeys.size}; write variants`);
  if (t.kind === 'midi' && /bass/i.test(t.id + t.name) && hi > 55) issues.push(`${t.id}: bass reaches ${pname(hi)}; keep bass below ~G3`);
}

console.log('\nBARS  section   sounding tracks (notes)');
const layersPerBar = [];
for (let b = 0; b < bars; b++) {
  const s = b * barBeats, e = s + barBeats;
  const active = tracks
    .map(({ t, notes }) => [t.id, notes.filter((n) => n.start < e && n.start + n.duration > s).length])
    .filter(([, c]) => c > 0);
  layersPerBar.push(active.length);
  console.log(`${String(b + 1).padStart(4)}  ${sectionOf(b).padEnd(9)} ${active.length}: ${active.map(([id, c]) => `${id}(${c})`).join(' ')}`);
}
const maxLayers = Math.max(...layersPerBar);
if (new Set(layersPerBar).size === 1 && bars > 8) issues.push('texture never changes: same number of parts in every bar; build and thin sections');
if (maxLayers > 7) issues.push(`up to ${maxLayers} parts at once; check that every part has its own register and job`);

for (const id of melodyIds) {
  const entry = tracks.find(({ t }) => t.id === id);
  if (!entry) continue;
  const mel = entry.notes;
  const ps = mel.map((n) => n.pitch);
  const hi = Math.max(...ps);
  const peaks = mel.filter((n) => n.pitch === hi);
  let steps = 0, leaps = 0, recovered = 0, bigLeaps = 0, intervals = 0;
  for (let i = 1; i < mel.length; i++) {
    const prev = mel[i - 1];
    if (mel[i].start - (prev.start + prev.duration) > 1 || mel[i].start === prev.start) continue;
    intervals++;
    const iv = mel[i].pitch - prev.pitch;
    if (Math.abs(iv) <= 2) steps++;
    if (Math.abs(iv) >= 5) {
      leaps++;
      if (Math.abs(iv) > 7) bigLeaps++;
      const next = mel[i + 1];
      if (next && Math.sign(next.pitch - mel[i].pitch) === -Math.sign(iv) && Math.abs(next.pitch - mel[i].pitch) <= 2) recovered++;
    }
  }
  let run = 1, maxRun = 1;
  for (let i = 1; i < mel.length; i++) {
    run = mel[i].pitch === mel[i - 1].pitch ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  intervals ||= 1;
  const strong = mel.filter((n) => n.start % (barBeats / 2) === 0).length;
  console.log(`\nMELODY ${id}: ${mel.length} notes, ${pname(Math.min(...ps))}-${pname(hi)}`);
  console.log(`  peak ${pname(hi)} x${peaks.length} at bar(s) ${peaks.map((n) => (n.start / barBeats + 1).toFixed(2)).join(', ')}`);
  console.log(`  steps ${Math.round((steps / intervals) * 100)}%  leaps(>=4th) ${leaps}, recovered by contrary step ${recovered}, > 5th ${bigLeaps}`);
  console.log(`  longest same-pitch run ${maxRun}; notes on strong beats ${strong}/${mel.length}`);
  if (steps / intervals < 0.45) issues.push(`${id}: mostly leaps (${Math.round((steps / intervals) * 100)}% steps); favour stepwise motion`);
  if (steps / intervals > 0.9) issues.push(`${id}: almost all steps; add a purposeful leap toward the climax`);
  if (leaps && recovered / leaps < 0.5) issues.push(`${id}: ${leaps - recovered} of ${leaps} leaps not followed by a contrary step`);
  if (maxRun > 4) issues.push(`${id}: ${maxRun} repeated pitches in a row; reads as static unless it is intentional`);
}

console.log(issues.length ? `\nCHECK\n- ${issues.join('\n- ')}` : '\nCHECK\n- no structural flags (still review against the direction card)');
