// pvx.js — decoder for the .pvx voxel volume format, v1 (little-endian).
// The layout is a wire contract shared with the server encoder at
// Features/PoVoxelStrike/PvxSerializer.cs — change both together:
//
//   magic 'PVX1' (4B) | version u16 | dimX u16 | dimY u16 | dimZ u16 | flags u16
//   paletteCount u16  | per entry: R u8, G u8, B u8, A u8, materialId u8
//   materialCount u8  | per entry: density f32, compressiveStr f32, tensileStr f32
//   payloadLength u32 | RLE runs of (count u16, paletteIndex u8), X→Y→Z cell order
//
// Cell order: cells[x + y*dimX + z*dimX*dimY], palette indices are 1-based (0 = empty).

const MAGIC = 0x31585650; // 'PVX1' read as LE u32

/**
 * @param {ArrayBuffer} buffer
 * @returns {{dims:[number,number,number], palette:Uint8Array, paletteMaterial:Uint8Array,
 *            materials:{density:number,compressive:number,tensile:number}[], cells:Uint8Array}}
 *   palette is RGBA, 4 bytes per entry, entry i describes cell value i+1.
 */
export function decodePvx(buffer) {
  const view = new DataView(buffer);
  let o = 0;

  if (view.getUint32(o, true) !== MAGIC) throw new Error('not a PVX1 payload');
  o += 4;
  const version = view.getUint16(o, true); o += 2;
  if (version !== 1) throw new Error(`unsupported PVX version ${version}`);

  const dimX = view.getUint16(o, true); o += 2;
  const dimY = view.getUint16(o, true); o += 2;
  const dimZ = view.getUint16(o, true); o += 2;
  o += 2; // flags, unused in v1

  const paletteCount = view.getUint16(o, true); o += 2;
  const palette = new Uint8Array(paletteCount * 4);
  const paletteMaterial = new Uint8Array(paletteCount);
  for (let i = 0; i < paletteCount; i++) {
    palette[i * 4] = view.getUint8(o++);
    palette[i * 4 + 1] = view.getUint8(o++);
    palette[i * 4 + 2] = view.getUint8(o++);
    palette[i * 4 + 3] = view.getUint8(o++);
    paletteMaterial[i] = view.getUint8(o++);
  }

  const materialCount = view.getUint8(o++);
  const materials = [];
  for (let i = 0; i < materialCount; i++) {
    materials.push({
      density: view.getFloat32(o, true),
      compressive: view.getFloat32(o + 4, true),
      tensile: view.getFloat32(o + 8, true),
    });
    o += 12;
  }

  const payloadLength = view.getUint32(o, true); o += 4;
  const cells = new Uint8Array(dimX * dimY * dimZ);
  let cell = 0;
  const end = o + payloadLength;
  while (o < end) {
    const count = view.getUint16(o, true); o += 2;
    const value = view.getUint8(o++);
    if (value !== 0) cells.fill(value, cell, cell + count);
    cell += count;
  }
  if (cell !== cells.length) {
    throw new Error(`PVX payload decoded ${cell} cells, expected ${cells.length}`);
  }

  return { dims: [dimX, dimY, dimZ], palette, paletteMaterial, materials, cells };
}
