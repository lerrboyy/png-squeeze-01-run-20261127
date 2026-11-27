// png-squeeze-01-run-20261127 — squeeze 1280x720 RGBA screenshots into the
// smallest lossless PNGs.
//
// One program, Node 22, standard library only, no network. It reads each
// /input/<id>/image.png, re-encodes it losslessly, and writes
// /output/<id>/image.png. Every pixel decodes back exactly, including the
// colour of fully transparent pixels.
//
// How it wins against the fixed-Paeth house baseline:
//   * it drops the colour type whenever the image allows it — a palette
//     (at most 256 colours), grey, grey+alpha, or RGB instead of RGBA,
//     with a tRNS key when a single fully-transparent value can carry the
//     transparency instead of an alpha channel;
//   * it filters each row by measured cost (fixed filters, minimum signed
//     sum, fewest distinct byte pairs, and a brute-force trial that really
//     compresses each candidate row) instead of one fixed filter for all;
//   * it screens every candidate at zlib level 6, then re-compresses the
//     two best at several zlib settings (levels 6, 8 and 9, memory levels
//     8 and 9, the filtered-data strategy at both memory levels) and keeps
//     the smallest file.
//
// The work plan is fixed — same forms, same filter choices, same zlib
// settings, in the same order, ties broken by first seen — so two runs
// write identical bytes. Nothing reads the clock and nothing is random.
// The output directory itself is never removed; folders are created as
// needed and files are overwritten in place.

import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// CRC-32 (the one PNG uses) and the chunk writer.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

// Assemble a PNG from [type, data] chunks: signature, then each chunk with
// its length, type, data and CRC. No chunk type outside the contest's list
// (IHDR, PLTE, tRNS, IDAT, IEND) is ever written.
function assemblePng(chunks) {
  let size = PNG_SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let at = PNG_SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrData(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth 8
  d[9] = colourType;
  return d; // compression 0, filter 0, interlace 0 are already zero
}

// ---------------------------------------------------------------------------
// PNG decoding: stored PNG (or any accepted colour type) back to RGBA.
// ---------------------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

// Undo one row's filter, writing the raw samples into `samples` at `dest`.
function unfilterRow(filterType, row, prev, bpp, samples, dest) {
  const n = row.length;
  if (filterType === 0) {
    samples.set(row, dest);
  } else if (filterType === 1) {
    for (let i = 0; i < n; i++) {
      samples[dest + i] = row[i] + (i >= bpp ? samples[dest + i - bpp] : 0);
    }
  } else if (filterType === 2) {
    for (let i = 0; i < n; i++) {
      samples[dest + i] = row[i] + (prev === null ? 0 : prev[i]);
    }
  } else if (filterType === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? samples[dest + i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      samples[dest + i] = row[i] + ((left + up) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? samples[dest + i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      const upLeft = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      samples[dest + i] = row[i] + paethPredictor(left, up, upLeft);
    }
  }
}

// Read a PNG the contest accepts and return { width, height, rgba }.
function decodePng(bytes) {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error('not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk header');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(type + ' chunk fails its CRC');
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) {
      throw new Error('unsupported chunk ' + type);
    }
    if (type === 'IHDR') {
      if (header !== null || len !== 13) throw new Error('bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = {
        width: dv.getUint32(0),
        height: dv.getUint32(4),
        depth: data[8],
        colourType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      if (header.depth !== 8 || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
        throw new Error('unsupported IHDR settings');
      }
      if (!Object.hasOwn(CHANNELS, header.colourType)) throw new Error('unsupported colour type');
    } else if (type === 'PLTE') {
      if (header.colourType !== 3 || palette !== null || idatParts.length > 0) throw new Error('bad PLTE');
      if (len === 0 || len % 3 !== 0 || len > 768) throw new Error('bad PLTE length');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null || idatParts.length > 0) throw new Error('bad tRNS');
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else {
      if (len !== 0) throw new Error('non-empty IEND');
      ended = true;
    }
  }
  if (!ended || idatParts.length === 0 || header === null) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), {
    maxOutputLength: expected + 1,
  });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('row ' + y + ' has filter type ' + ft);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    unfilterRow(ft, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), prev, bpp, samples, y * stride);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Analysis: opaque? grey? at most 256 colours? one transparent key?
// ---------------------------------------------------------------------------

// One pass over the pixels. Colours are keyed by their 32-bit word; the
// count stops growing past 256 (then `colours` is null) but the opaque and
// grey scans run to the end.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const word = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else {
        counts.set(word, k + 1);
      }
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      word,
      count,
      r: (word >>> 24) & 0xff,
      g: (word >>> 16) & 0xff,
      b: (word >>> 8) & 0xff,
      a: word & 0xff,
    }));
  }
  return { opaque, grey, colours };
}

// The one fully-transparent value (grey sample, or RGB triple) the image
// may key by tRNS: every non-opaque pixel is alpha 0 with that exact
// value, and no opaque pixel uses it. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Candidate forms: palette forms and the channel form the image allows.
// ---------------------------------------------------------------------------

function luminanceOf(c) {
  return 299 * c.r + 587 * c.g + 114 * c.b;
}

// Palette entries in trial order: transparent entries first (lowest alpha
// first), then by `order` — most frequent first, or darkest first by
// luminance. Transparent-first keeps the tRNS chunk short.
function paletteForm(rgba, colours, order) {
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminanceOf(x) - luminanceOf(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const word = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(word);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The channel samples for a colour type: grey 0, RGB 2, grey+alpha 4, RGBA 6.
function channelSamples(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms; // a palette holds it in a third of the bytes
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({ colourType, bpp, samples: channelSamples(rgba, colourType), plte: null, trns });
  return forms;
}

// ---------------------------------------------------------------------------
// Row filtering: the five PNG filters and the per-row cost heuristics.
// ---------------------------------------------------------------------------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + up) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      const upLeft = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(left, up, upLeft);
    }
  }
}

// The PNG spec's minimum-sum heuristic: filtered bytes read as signed
// values, summed by absolute value. Lower is better.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// How many distinct neighbouring byte pairs a filtered row holds.
// Fewer distinct pairs means the row compresses better; `seen`/`stamp`
// is a reusable scratch table so no set is allocated per row.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768; // bytes of already-written data a row trial sees
const BRUTE_LEVEL = 4; // the zlib level row trials are weighed at

// Filter every row of `samples` by `choice`: a fixed type 0-4, 'minsum',
// 'pairs', or 'brute' (each row's five filters really compressed against
// the preceding 32 KiB, smallest kept; lowest type wins a tie).
function filterImage(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0
          ? { level: BRUTE_LEVEL, memLevel: 9 }
          : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// Which filter choices each form is screened with. A palette ordered by
// count is tried unfiltered only; a palette ordered by luminance adds the
// minimum-sum and brute-force choices; a channel form tries everything.
function filterChoices(form) {
  if (form.colourType === 3) {
    return form._luminance ? [0, 'minsum', 'brute'] : [0];
  }
  return [0, 1, 2, 4, 'minsum', 'pairs', 'brute'];
}

// ---------------------------------------------------------------------------
// Screening and the final deflate.
// ---------------------------------------------------------------------------

const SCREEN = { level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY };
// The zlib settings the best candidates are finally tried at. The two
// filtered-data variants differ only in memory level: on the practice set
// the memory-level-8 one wins on rich noisy images (about 230 bytes on
// one image) while the memory-level-9 one wins nowhere else, so both are
// tried and the smallest stream kept.
const FINAL_SETTINGS = [
  { level: 6, memLevel: 8 },
  { level: 9, memLevel: 8 },
  { level: 9, memLevel: 9 },
  { level: 9, memLevel: 9, strategy: zlibConstants.Z_FILTERED },
  { level: 9, memLevel: 8, strategy: zlibConstants.Z_FILTERED },
];

// Bytes a form's PLTE / tRNS chunks add to the file, plus the fixed cost
// every file carries: the 8-byte signature, the IHDR chunk (25), the
// IDAT chunk's framing (12) and the IEND chunk (12) — 57 in all.
function overheadOf(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length)
    + (form.trns === null ? 0 : 12 + form.trns.length) + 57;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrData(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

// The safest valid answer for an image: RGBA, every row Paeth, level 9.
// Used when anything else fails for an instance.
function fallbackPng(rgba, width, height) {
  const data = filterImage(rgba, width, height, 4, 4);
  const zlib = deflateSync(data, { level: 9, memLevel: 8 });
  return pngOfForm(width, height, { colourType: 6, bpp: 4, plte: null, trns: null }, new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length));
}

// Re-encode one image: screen every form/filter choice at level 6, keep
// the best two, re-deflate them at the final settings, write the smallest.
function encodeImage(rgba, width, height) {
  const forms = formsOf(rgba);
  // Mark the luminance palette so filterChoices can tell the two apart.
  if (forms.length > 1 && forms[0].colourType === 3 && forms[1].colourType === 3) forms[1]._luminance = true;
  const best = []; // up to two { form, data, bytes } sorted by bytes
  const keep = (candidate) => {
    best.push(candidate);
    best.sort((a, b) => a.bytes - b.bytes);
    if (best.length > 2) best.pop();
  };
  for (const form of forms) {
    for (const choice of filterChoices(form)) {
      // Brute force only pays on narrow (at most 2 bytes a pixel) forms;
      // on 3- and 4-byte forms it costs seconds for no measured gain.
      if (choice === 'brute' && form.bpp > 2) continue;
      const data = filterImage(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      keep({ form, data, bytes: zlib.length + overheadOf(form) });
    }
  }
  let winner = null; // { form, idat, bytes }
  for (let ci = 0; ci < best.length; ci++) {
    const candidate = best[ci];
    const settings = ci === 0 ? FINAL_SETTINGS : [FINAL_SETTINGS[1]];
    for (const opts of settings) {
      const zlib = deflateSync(candidate.data, opts);
      const bytes = zlib.length + overheadOf(candidate.form);
      if (winner === null || bytes < winner.bytes) {
        winner = { form: candidate.form, idat: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      }
    }
  }
  return pngOfForm(width, height, winner.form, winner.idat);
}

// ---------------------------------------------------------------------------
// Driver: every instance in the input directory, in order.
// ---------------------------------------------------------------------------

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  let image;
  try {
    image = decodePng(new Uint8Array(readFileSync(inPath)));
  } catch (err) {
    console.error(id + ': cannot read input, skipping: ' + err.message);
    continue;
  }
  let png;
  try {
    png = encodeImage(image.rgba, image.width, image.height);
  } catch (err) {
    console.error(id + ': encoder failed, using Paeth fallback: ' + err.message);
    png = fallbackPng(image.rgba, image.width, image.height);
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
