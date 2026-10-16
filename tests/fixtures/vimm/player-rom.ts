/** Original minimal NES homebrew fixture: green VAULT tiles, changing palette, A advances color.
 * Generated in tests only; no commercial ROMs or external downloads. */
export function playerTestRom(): Uint8Array {
  const rom = new Uint8Array(16 + 16384 + 8192);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1]);
  const code: number[] = [],
    labels: Record<string, number> = {},
    fixups: [number, string, boolean][] = [];
  const emit = (...b: number[]) => code.push(...b);
  const mark = (n: string) => {
    labels[n] = 0x8000 + code.length;
  };
  const branch = (op: number, label: string) => {
    emit(op, 0);
    fixups.push([code.length - 1, label, true]);
  };
  const jump = (label: string) => {
    emit(0x4c, 0, 0);
    fixups.push([code.length - 2, label, false]);
  };
  mark("reset");
  emit(
    0x78,
    0xd8,
    0xa2,
    0xff,
    0x9a,
    0xe8,
    0x8e,
    0,
    0x20,
    0x8e,
    1,
    0x20,
    0x8e,
    0x10,
    0x40,
  );
  mark("vblank1");
  emit(0x2c, 2, 0x20);
  branch(0x10, "vblank1");
  mark("vblank2");
  emit(0x2c, 2, 0x20);
  branch(0x10, "vblank2");
  emit(
    0xa9,
    0,
    0x85,
    0,
    0x85,
    1,
    0xa9,
    0x3f,
    0x8d,
    6,
    0x20,
    0xa9,
    0,
    0x8d,
    6,
    0x20,
  );
  for (let i = 0; i < 8; i++)
    for (const c of [0x0f, 0x2a, 0x30, 0x21]) emit(0xa9, c, 0x8d, 7, 0x20);
  emit(0xa9, 0x20, 0x8d, 6, 0x20, 0xa9, 0, 0x8d, 6, 0x20, 0xa2, 0, 0xa0, 4);
  mark("fill");
  emit(0xa9, 0, 0x8d, 7, 0x20, 0xe8);
  branch(0xd0, "fill");
  emit(0x88);
  branch(0xd0, "fill");
  for (const row of [0x218b, 0x21cb, 0x220b]) {
    emit(0xa9, row >> 8, 0x8d, 6, 0x20, 0xa9, row & 255, 0x8d, 6, 0x20);
    for (let t = 1; t <= 5; t++) emit(0xa9, t, 0x8d, 7, 0x20);
  }
  emit(
    0xa9,
    0,
    0x8d,
    5,
    0x20,
    0x8d,
    5,
    0x20,
    0xa9,
    0x80,
    0x8d,
    0,
    0x20,
    0xa9,
    0x0a,
    0x8d,
    1,
    0x20,
  );
  mark("loop");
  jump("loop");
  mark("nmi");
  emit(0x48, 0xe6, 0, 0xa5, 0, 0xc9, 60);
  branch(0xd0, "input");
  emit(0xa9, 0, 0x85, 0, 0xe6, 1);
  mark("input");
  emit(
    0xa9,
    1,
    0x8d,
    0x16,
    0x40,
    0xa9,
    0,
    0x8d,
    0x16,
    0x40,
    0xad,
    0x16,
    0x40,
    0x29,
    1,
  );
  branch(0xf0, "palette");
  emit(0xe6, 1);
  mark("palette");
  emit(
    0xad,
    2,
    0x20,
    0xa9,
    0x3f,
    0x8d,
    6,
    0x20,
    0xa9,
    1,
    0x8d,
    6,
    0x20,
    0xa5,
    1,
    0x29,
    0x0f,
    0x09,
    0x20,
    0x8d,
    7,
    0x20,
    // Palette addressing changes the PPU's temporary nametable bits.
    // Restore nametable 0 before restoring the scroll for the next frame.
    0xa9,
    0x80,
    0x8d,
    0,
    0x20,
    0xa9,
    0,
    0x8d,
    5,
    0x20,
    0x8d,
    5,
    0x20,
    0x68,
    0x40,
  );
  for (const [offset, label, relative] of fixups) {
    const address = labels[label];
    code[offset] = relative
      ? (address - (0x8000 + offset + 1)) & 255
      : address & 255;
    if (!relative) code[offset + 1] = address >> 8;
  }
  rom.set(code, 16);
  for (const [offset, label] of [
    [0x3ffa, "nmi"],
    [0x3ffc, "reset"],
    [0x3ffe, "nmi"],
  ] as const)
    rom.set([labels[label] & 255, labels[label] >> 8], 16 + offset);
  const glyphs = [
    [0x42, 0x42, 0x42, 0x42, 0x24, 0x24, 0x18, 0],
    [0x18, 0x24, 0x42, 0x7e, 0x42, 0x42, 0x42, 0],
    [0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x3c, 0],
    [0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x7e, 0],
    [0x7e, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0],
  ];
  glyphs.forEach((glyph, i) => rom.set(glyph, 16 + 16384 + (i + 1) * 16));
  return rom;
}
