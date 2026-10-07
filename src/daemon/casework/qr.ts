// Minimal QR code encoder (byte mode, error-correction level L, versions 1-40),
// a compact port of the public-domain algorithm from Nayuki's qrcodegen.
// Used for the Casework Desk pairing code; emits SVG so the UI needs no library.

const ECC_L_CODEWORDS_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const ECC_L_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
const FORMAT_BITS_L = 1;

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const numDataCodewords = (ver: number) => Math.floor(numRawDataModules(ver) / 8) - ECC_L_CODEWORDS_PER_BLOCK[ver] * ECC_L_BLOCKS[ver];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function addEccAndInterleave(ver: number, data: number[]): number[] {
  const numBlocks = ECC_L_BLOCKS[ver], blockEccLen = ECC_L_CODEWORDS_PER_BLOCK[ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  const div = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, div);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++)
    for (let j = 0; j < blocks.length; j++)
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
  return result;
}

/** Encode text (UTF-8) into a QR module matrix: rows of booleans, true = dark. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 40; ver++) {
    const capacityBits = numDataCodewords(ver) * 8;
    const needed = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= capacityBits) break;
    if (ver === 40) throw new Error("QR payload too long");
  }
  // Bit stream: mode (byte = 0100), count, data, terminator, padding.
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = numDataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  const codewords = addEccAndInterleave(ver, data);

  const size = ver * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { if (x >= 0 && x < size && y >= 0 && y < size) { modules[y][x] = dark; isFunction[y][x] = true; } };

  // Function patterns.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (x: number, y: number) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x + dx, y + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const alignPos: number[] = [];
  if (ver > 1) {
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    alignPos.push(6);
    for (let pos = size - 7; alignPos.length < numAlign; pos -= step) alignPos.splice(1, 0, pos);
  }
  for (let i = 0; i < alignPos.length; i++) for (let j = 0; j < alignPos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === alignPos.length - 1) || (i === alignPos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(alignPos[i] + dx, alignPos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormatBits = (mask: number) => {
    const d = (FORMAT_BITS_L << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormatBits(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const bit = ((vb >>> i) & 1) !== 0; const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, bit); set(b, a, bit); }
  }

  // Data placement in the zigzag order.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!isFunction[y][x] && i < codewords.length * 8) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }

  // Masking: pick the pattern with the lowest penalty (rules 1, 2, 4).
  const maskFn = [
    (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x]; };
  const penalty = () => {
    let p = 0;
    const runs = (line: boolean[]) => { let run = 1; for (let k = 1; k <= line.length; k++) { if (k < line.length && line[k] === line[k - 1]) run++; else { if (run >= 5) p += run - 2; run = 1; } } };
    for (let y = 0; y < size; y++) runs(modules[y]);
    for (let x = 0; x < size; x++) runs(modules.map((r) => r[x]));
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = modules[y][x]; if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3; }
    let dark = 0; for (const row of modules) for (const m of row) if (m) dark++;
    p += Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); drawFormatBits(m); const s = penalty(); if (s < bestScore) { bestScore = s; best = m; } applyMask(m); }
  applyMask(best); drawFormatBits(best);
  return modules;
}

/** Render a QR matrix as an SVG string (quiet zone of 2 modules). */
export function qrSvg(text: string, opts: { scale?: number; dark?: string; light?: string } = {}): string {
  const m = qrMatrix(text);
  const size = m.length, quiet = 2, total = size + quiet * 2, scale = opts.scale ?? 4;
  const path: string[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) path.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * scale}" height="${total * scale}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${opts.light ?? "#ffffff"}"/><path d="${path.join("")}" fill="${opts.dark ?? "#000000"}"/></svg>`;
}
