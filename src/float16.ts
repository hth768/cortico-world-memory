/**
 * IEEE 754 半精度(fp16)编解码 —— 对齐 E:/qq_bot/vector_memory.py 的向量存储格式:
 * `base64(fp16 little-endian bytes)`。编解码算法与 numpy 的 float16 互转语义一致
 * (含 ±0、±Inf、NaN、次正规数与溢出饱和到 ±Inf),因此本扩展的 vector-memory.json
 * 可以直接导入 qq_bot 侧的数据,反之亦然。
 */

/** fp32 → fp16(Uint16 位型)。非数值保守处理:NaN→NaN,±Inf→±Inf,超范围饱和。 */
export function f32ToF16(value: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = value;
  const x = u[0]!;
  const sign = (x >>> 16) & 0x8000;
  const rest = x & 0x7fffffff;
  if (rest >= 0x7f800000) {
    // NaN / Inf:保持 NaN 位型(qNaN 尾声截断)
    return sign | 0x7c00 | (rest > 0x7f800000 ? 0x0200 : 0);
  }
  if (rest > 0x477fe000) return sign | 0x7c00; // 溢出 → ±Inf(对齐 numpy 就近舍入上界)
  if (rest < 0x33000000) return sign; // 太小 → ±0
  let exp = (rest >>> 23) - 127 + 15;
  let mant = rest & 0x007fffff;
  if (exp <= 0) {
    // 次正规数:右移并对齐舍入
    mant = (rest & 0x007fffff) | 0x00800000;
    const shift = 14 - exp;
    const half = 1 << (shift - 1);
    mant = (mant + half) >> shift;
    return sign | mant;
  }
  // 就近舍入( ties to even )
  mant = mant + 0x00000fff + ((mant >>> 13) & 1);
  if (mant & 0x00800000) { mant = 0; exp += 1; } // 进位到新指数
  return sign | (exp << 10) | (mant >>> 13);
}

/** fp16(Uint16 位型) → fp32。 */
export function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exp = (h & 0x7c00) >>> 10;
  const mant = h & 0x03ff;
  let out: number;
  if (exp === 0) {
    // 次正规 / 零:按规格化公式还原
    if (mant === 0) out = 0;
    else {
      let e = -1;
      let m = mant;
      while (!(m & 0x0400)) { m <<= 1; e -= 1; }
      m &= 0x03ff;
      out = (127 + 15 + e - 10) << 23 | m << 13;
    }
  } else if (exp === 0x1f) {
    out = mant ? 0x7fc00000 : 0x7f800000; // NaN / Inf
  } else {
    out = (exp - 15 + 127) << 23 | mant << 13;
  }
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  u[0] = (out | sign) >>> 0;
  return f[0]!;
}

/** float 列表 → base64(fp16 LE)。对齐 `_encode_vector_fp16`。 */
export function encodeVectorFp16(vec: readonly number[]): string {
  const bytes = new Uint8Array(vec.length * 2);
  for (let i = 0; i < vec.length; i++) {
    const h = f32ToF16(vec[i]!);
    bytes[i * 2] = h & 0xff;
    bytes[i * 2 + 1] = (h >>> 8) & 0xff;
  }
  return Buffer.from(bytes).toString('base64');
}

/** base64(fp16 LE) → Float32Array。对齐 `_decode_vector_fp16`(解码后转 fp32)。 */
export function decodeVectorFp16(encoded: string): Float32Array {
  const raw = Buffer.from(encoded, 'base64');
  const out = new Float32Array(raw.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = f16ToF32(raw[i * 2]! | (raw[i * 2 + 1]! << 8));
  }
  return out;
}
