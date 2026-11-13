'use strict';
// Reads the old binary Excel format (.xls, BIFF8 inside an OLE2 compound file) into rows of text. Only what an
// import needs: sheet names and cell values (text, numbers, dates, booleans, formula results). Styles, merged
// cells, charts and macros are ignored. Excel 5/95 files and password-protected files are refused with a clear message.

// ---------- OLE2 compound file ----------
function readCfb(buf, ImportError) {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (buf.length < 512 || sig.some((b, i) => buf[i] !== b)) throw new ImportError('This is not a valid .xls file');
  const secSize = 1 << buf.readUInt16LE(30), miniSize = 1 << buf.readUInt16LE(32);
  const sector = (n) => buf.subarray((n + 1) * secSize, (n + 2) * secSize);
  const END = 0xfffffffe, FREE = 0xffffffff;

  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = buf.readUInt32LE(76 + i * 4); if (s !== FREE && s !== END) fatSectors.push(s); }
  let dif = buf.readUInt32LE(68);
  for (let n = buf.readUInt32LE(72); n > 0 && dif !== END && dif !== FREE; n--) {
    const d = sector(dif);
    for (let i = 0; i < secSize / 4 - 1; i++) { const s = d.readUInt32LE(i * 4); if (s !== FREE && s !== END) fatSectors.push(s); }
    dif = d.readUInt32LE(secSize - 4);
  }
  const fat = [];
  for (const s of fatSectors) { const d = sector(s); for (let i = 0; i < d.length; i += 4) fat.push(d.readUInt32LE(i)); }

  const chain = (start, table) => { const out = []; const seen = new Set(); for (let s = start; s !== END && s !== FREE && s < table.length + 1; s = table[s]) { if (seen.has(s)) throw new ImportError('The .xls file is damaged'); seen.add(s); out.push(s); } return out; };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));

  const dir = readChain(buf.readUInt32LE(48));
  const entries = [];
  for (let i = 0; i + 128 <= dir.length; i += 128) {
    const len = dir.readUInt16LE(i + 64);
    entries.push({ name: dir.toString('utf16le', i, i + Math.max(0, len - 2)), type: dir[i + 66], start: dir.readUInt32LE(i + 116), size: dir.readUInt32LE(i + 120) });
  }
  const root = entries.find((e) => e.type === 5);
  const cutoff = buf.readUInt32LE(56);
  let mini = null, miniFat = null;
  const stream = (e) => {
    if (e.size < cutoff && root) {
      if (!mini) {
        mini = readChain(root.start);
        const mf = readChain(buf.readUInt32LE(60));
        miniFat = []; for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
      }
      return Buffer.concat(chain(e.start, miniFat).map((s) => mini.subarray(s * miniSize, (s + 1) * miniSize))).subarray(0, e.size);
    }
    return readChain(e.start).subarray(0, e.size);
  };
  const wb = entries.find((e) => e.type === 2 && (e.name === 'Workbook' || e.name === 'Book'));
  if (!wb) throw new ImportError('No workbook found in this .xls file');
  return stream(wb);
}

// ---------- BIFF8 records ----------
const REC = { BOF: 0x0809, EOF: 0x000a, BOUNDSHEET: 0x0085, SST: 0x00fc, CONTINUE: 0x003c, LABELSST: 0x00fd, LABEL: 0x0204, NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd,
  FORMULA: 0x0006, STRING: 0x0207, BOOLERR: 0x0205, XF: 0x00e0, FORMAT: 0x041e, DATEMODE: 0x0022, FILEPASS: 0x002f };

function records(buf) {
  const out = [];
  for (let p = 0; p + 4 <= buf.length;) {
    const type = buf.readUInt16LE(p), len = buf.readUInt16LE(p + 2);
    if (p + 4 + len > buf.length) break;
    if (type === REC.CONTINUE && out.length) out[out.length - 1].continues.push(buf.subarray(p + 4, p + 4 + len));
    else out.push({ type, pos: p, data: buf.subarray(p + 4, p + 4 + len), continues: [] });
    p += 4 + len;
  }
  return out;
}

// Reads strings that may run on into CONTINUE records. At the start of each continuation inside character data
// there is a fresh flag byte saying whether the rest is 8 or 16 bit.
class Chunked {
  constructor(first, rest) { this.chunks = [first, ...rest]; this.i = 0; this.p = 0; }
  more() { while (this.i < this.chunks.length && this.p >= this.chunks[this.i].length) { this.i++; this.p = 0; } return this.i < this.chunks.length; }
  u8() { if (!this.more()) return 0; return this.chunks[this.i][this.p++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) { while (n > 0 && this.more()) { const take = Math.min(n, this.chunks[this.i].length - this.p); this.p += take; n -= take; } }
  chars(count, wide) {
    let s = '';
    while (count > 0) {
      if (this.i >= this.chunks.length) break;
      if (this.p >= this.chunks[this.i].length) { this.i++; this.p = 0; if (this.i >= this.chunks.length) break; wide = (this.chunks[this.i][this.p++] & 1) === 1; }
      const c = this.chunks[this.i], size = wide ? 2 : 1;
      const fit = Math.min(count, Math.floor((c.length - this.p) / size));
      if (fit <= 0) { this.p = c.length; continue; }
      s += wide ? c.toString('utf16le', this.p, this.p + fit * 2) : c.toString('latin1', this.p, this.p + fit);
      this.p += fit * size; count -= fit;
    }
    return s;
  }
  // a string as stored in the shared string table
  sstString() {
    const count = this.u16(), flags = this.u8();
    const runs = flags & 8 ? this.u16() : 0, ext = flags & 4 ? this.u32() : 0;
    const s = this.chars(count, !!(flags & 1));
    this.skip(runs * 4 + ext);
    return s;
  }
}

// An unformatted string field in a LABEL, STRING, FORMAT record: u16 length, flags byte, characters.
function plainString(data, at) {
  const count = data.readUInt16LE(at), wide = data[at + 2] & 1;
  return wide ? data.toString('utf16le', at + 3, at + 3 + count * 2) : data.toString('latin1', at + 3, at + 3 + count);
}

const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };
const errorText = (code) => ERRORS[code] || '#ERROR';

function rk(v) {
  let n;
  if (v & 2) n = v >> 2; // a 30 bit signed integer
  else { const b = Buffer.alloc(8); b.writeUInt32LE((v & 0xfffffffc) >>> 0, 4); n = b.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}

function parseXls(buf, sheetIdx, { isDateCode, serialToText, ImportError, MAX_ROWS, BUILTIN_DATE_FMT }) {
  const book = readCfb(buf, ImportError);
  const recs = records(book);
  const first = recs[0];
  if (!first || first.type !== REC.BOF) throw new ImportError('This is not a valid .xls file');
  if (first.data.readUInt16LE(0) < 0x0600) throw new ImportError('This .xls file is from Excel 5/95, which is too old to read. Save it as .xlsx or CSV and try again.');

  // ----- workbook globals -----
  const sheets = [], shared = [], formats = new Map(), xfFormat = [];
  let date1904 = false, i = 0;
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === REC.FILEPASS) throw new ImportError('This .xls file is password protected. Remove the password in Excel, then try again.');
    if (r.type === REC.DATEMODE) date1904 = r.data.readUInt16LE(0) === 1;
    else if (r.type === REC.BOUNDSHEET) {
      const cch = r.data[6], wide = r.data[7] & 1;
      sheets.push({ offset: r.data.readUInt32LE(0), kind: r.data[5], name: wide ? r.data.toString('utf16le', 8, 8 + cch * 2) : r.data.toString('latin1', 8, 8 + cch) });
    } else if (r.type === REC.SST) {
      const rd = new Chunked(r.data, r.continues);
      rd.u32(); const unique = rd.u32();
      for (let n = 0; n < unique && rd.more(); n++) shared.push(rd.sstString());
    } else if (r.type === REC.FORMAT) formats.set(r.data.readUInt16LE(0), plainString(r.data, 2));
    else if (r.type === REC.XF) xfFormat.push(r.data.readUInt16LE(2));
    else if (r.type === REC.EOF) { i++; break; }
  }
  const worksheets = sheets.filter((s) => s.kind === 0);
  if (!worksheets.length) throw new ImportError('Workbook has no worksheets');
  const sheet = Math.min(Math.max(Number(sheetIdx) || 0, 0), worksheets.length - 1);
  const dateXf = xfFormat.map((id) => (formats.has(id) ? isDateCode(formats.get(id)) : BUILTIN_DATE_FMT.has(id)));

  // ----- the chosen sheet -----
  const start = recs.findIndex((r) => r.pos === worksheets[sheet].offset);
  if (start < 0) throw new ImportError('The .xls file is damaged');
  const cells = new Map(); // row -> [] of values
  const put = (row, col, value) => { if (row >= 65536 || col > 500) return; let r = cells.get(row); if (!r) cells.set(row, (r = [])); r[col] = value; };
  const number = (xf, n) => (dateXf[xf] ? serialToText(n, date1904) ?? String(n) : String(Number(n.toPrecision(15))));
  let pending = null; // a formula whose text result arrives in the STRING record that follows
  for (let k = start + 1; k < recs.length; k++) {
    const r = recs[k], d = r.data;
    if (r.type === REC.EOF) break;
    if (r.type === REC.BOF) { // an embedded chart or macro sheet: skip to its end
      for (let depth = 1; depth > 0 && ++k < recs.length;) { if (recs[k].type === REC.BOF) depth++; else if (recs[k].type === REC.EOF) depth--; }
      continue;
    }
    if (r.type === REC.STRING && pending) { put(pending.row, pending.col, plainString(d, 0)); pending = null; continue; }
    pending = null;
    if (r.type === REC.LABELSST) put(d.readUInt16LE(0), d.readUInt16LE(2), shared[d.readUInt32LE(6)] ?? '');
    else if (r.type === REC.LABEL) put(d.readUInt16LE(0), d.readUInt16LE(2), plainString(d, 6));
    else if (r.type === REC.NUMBER) put(d.readUInt16LE(0), d.readUInt16LE(2), number(d.readUInt16LE(4), d.readDoubleLE(6)));
    else if (r.type === REC.RK) put(d.readUInt16LE(0), d.readUInt16LE(2), number(d.readUInt16LE(4), rk(d.readUInt32LE(6))));
    else if (r.type === REC.MULRK) {
      const row = d.readUInt16LE(0), c0 = d.readUInt16LE(2), n = (d.length - 6) / 6;
      for (let j = 0; j < n; j++) put(row, c0 + j, number(d.readUInt16LE(4 + j * 6), rk(d.readUInt32LE(6 + j * 6))));
    } else if (r.type === REC.BOOLERR) put(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? errorText(d[6]) : d[6] ? 'TRUE' : 'FALSE');
    else if (r.type === REC.FORMULA) {
      const row = d.readUInt16LE(0), col = d.readUInt16LE(2), xf = d.readUInt16LE(4);
      if (d[12] === 0xff && d[13] === 0xff) { // not a number: a string follows, or a boolean, error or empty text
        if (d[6] === 0) pending = { row, col };
        else if (d[6] === 1) put(row, col, d[8] ? 'TRUE' : 'FALSE');
        else if (d[6] === 2) put(row, col, errorText(d[8]));
        else put(row, col, '');
      } else put(row, col, number(xf, d.readDoubleLE(6)));
    }
  }
  const rows = [];
  const last = Math.max(-1, ...cells.keys());
  for (let rn = 0; rn <= last && rows.length <= MAX_ROWS + 1; rn++) rows.push(Array.from(cells.get(rn) || [], (x) => x ?? ''));
  return { rows, sheets: worksheets.map((s) => s.name), sheet };
}

module.exports = { parseXls };
