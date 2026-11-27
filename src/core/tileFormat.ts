/**
 * NY3D tile container — a tiny, versioned binary format shared by the data
 * pipeline (writer) and the viewer workers (reader).
 *
 *   bytes 0..3   ASCII "NY3D"
 *   u32          format version
 *   u32          header length (bytes, UTF-8 JSON, padded with spaces to 4)
 *   header JSON  TileHeader
 *   sections     raw little-endian typed arrays, each 4-byte aligned
 *
 * Polygon layers always contain the sections
 *   featRings  u32[featureCount+1]   index of first ring of each feature
 *   ringVerts  u32[ringCount+1]      index of first vertex of each ring
 *   coords     f32[2*vertexCount]    x,z pairs relative to header.origin
 * Ring 0 of each feature is the outer ring (CCW seen from above), the rest
 * are holes (CW). Rings are open (first vertex is not repeated).
 * Line layers (header.meta.geometry === 'line') use the same three sections
 * with exactly one open polyline "ring" per feature.
 * Point layers (header.meta.geometry === 'point') contain only
 *   coords     f32[2*featureCount]
 * Any other section is a per-feature attribute (length == featureCount).
 */
export const TILE_MAGIC = 0x4433594e; // "NY3D" little-endian
export const TILE_VERSION = 1;

export type SectionType = 'f32' | 'u32' | 'i32' | 'u16' | 'u8';
export type TypedArray = Float32Array | Uint32Array | Int32Array | Uint16Array | Uint8Array;

export interface SectionInfo { name: string; type: SectionType; offset: number; length: number }

export interface TileHeader {
  layer: string;
  region: string;
  tile: [number, number] | null;       // null for untiled (context) files
  origin: [number, number];            // scene x,z the coords are relative to
  featureCount: number;
  sections: SectionInfo[];
  meta?: Record<string, unknown>;
}

const CTORS: Record<SectionType, any> = {
  f32: Float32Array, u32: Uint32Array, i32: Int32Array, u16: Uint16Array, u8: Uint8Array,
};
const typeOf = (a: TypedArray): SectionType =>
  a instanceof Float32Array ? 'f32' : a instanceof Uint32Array ? 'u32' : a instanceof Int32Array ? 'i32'
    : a instanceof Uint16Array ? 'u16' : 'u8';

export function encodeTile(
  base: Omit<TileHeader, 'sections'>,
  sections: Record<string, TypedArray>,
): Uint8Array {
  const infos: SectionInfo[] = [];
  let off = 0;
  for (const [name, arr] of Object.entries(sections)) {
    infos.push({ name, type: typeOf(arr), offset: off, length: arr.length });
    off += Math.ceil(arr.byteLength / 4) * 4;
  }
  const header: TileHeader = { ...base, sections: infos };
  let json = JSON.stringify(header);
  while (new TextEncoder().encode(json).length % 4) json += ' ';
  const hbytes = new TextEncoder().encode(json);
  const out = new Uint8Array(12 + hbytes.length + off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, TILE_MAGIC, true);
  dv.setUint32(4, TILE_VERSION, true);
  dv.setUint32(8, hbytes.length, true);
  out.set(hbytes, 12);
  const start = 12 + hbytes.length;
  Object.values(sections).forEach((arr, i) => {
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), start + infos[i].offset);
  });
  return out;
}

export interface DecodedTile { header: TileHeader; sections: Record<string, TypedArray> }

export function decodeTile(buf: ArrayBuffer): DecodedTile {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== TILE_MAGIC) throw new Error('Not an NY3D tile');
  const version = dv.getUint32(4, true);
  if (version > TILE_VERSION) throw new Error(`Unsupported tile version ${version}`);
  const hlen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen))) as TileHeader;
  const start = 12 + hlen;
  const sections: Record<string, TypedArray> = {};
  for (const s of header.sections) {
    sections[s.name] = new CTORS[s.type](buf, start + s.offset, s.length);
  }
  return { header, sections };
}
