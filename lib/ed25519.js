// Strict Ed25519 encodings (attestations §5).
//
// Ed25519 libraries disagree on edge cases: small-order and mixed-order
// points, and non-canonical encodings. MOCA removes the disagreement before a
// library verifies anything: the public key A and the signature's R must each
// be the canonical encoding of a point of prime order L, and S must be less
// than L. With those, the cofactored and cofactorless verification equations
// agree, so every Reader reaches the same answer.

const P = 2n ** 255n - 19n;
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
const IDENTITY = [0n, 1n, 1n, 0n];

function add([x1, y1, z1, t1], [x2, y2, z2, t2]) {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * t1 * t2 * D);
  const d = mod(2n * z1 * z2);
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function mul(k, p) {
  let q = IDENTITY;
  while (k > 0n) {
    if (k & 1n) q = add(q, p);
    p = add(p, p);
    k >>= 1n;
  }
  return q;
}

const isIdentity = ([x, y, z]) => mod(x) === 0n && mod(y - z) === 0n;
const littleEndian = (bytes) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);

/** RFC 8032 §5.1.3, refusing non-canonical encodings (y ≥ p, or x = 0 with the sign bit set). */
function decode(bytes) {
  if (bytes.length !== 32) return null;
  const n = littleEndian(bytes);
  const sign = n >> 255n;
  const y = n & ((1n << 255n) - 1n);
  if (y >= P) return null;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  if (mod(v * x * x - u) !== 0n) {
    x = mod(x * SQRT_M1);
    if (mod(v * x * x - u) !== 0n) return null;
  }
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}

/** The canonical encoding of a point of order L: not the identity, no small-order component. */
export function isPrimeOrderPoint(bytes) {
  const point = decode(bytes);
  return point !== null && !isIdentity(point) && isIdentity(mul(L, point));
}

/** Attestations §5: A and R are canonical points of order L, and S < L. */
export function strictEncodings(publicKey, signature) {
  if (signature.length !== 64) return false;
  return littleEndian(signature.subarray(32)) < L && isPrimeOrderPoint(publicKey) && isPrimeOrderPoint(signature.subarray(0, 32));
}
