export function assertInt(n, label = "value") {
    if (!Number.isSafeInteger(n))
        throw new Error(`${label} must be an integer`);
}
/** round(a*b/c) half-up for non-negative a,b and positive c, exact via BigInt. */
export function mulDiv(a, b, c) {
    assertInt(a, "a");
    assertInt(b, "b");
    assertInt(c, "c");
    if (c <= 0)
        throw new Error("divisor must be positive");
    const neg = a < 0 !== b < 0;
    const A = BigInt(Math.abs(a)), B = BigInt(Math.abs(b)), C = BigInt(c);
    const r = Number((2n * A * B + C) / (2n * C));
    return neg ? -r : r;
}
function parseDecimal(s, scale, label) {
    const t = s.trim().replace(/[₹,\s]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(t))
        throw new Error(`Invalid ${label}: "${s}"`);
    const neg = t.startsWith("-");
    const [i, f = ""] = t.replace("-", "").split(".");
    const digits = String(scale).length - 1; // 100 -> 2, 1000 -> 3
    const frac = (f + "0".repeat(digits)).slice(0, digits);
    // round half-up on the first dropped digit
    const roundUp = f.length > digits && f[digits] >= "5" ? 1 : 0;
    const v = Number(i) * scale + Number(frac || 0) + roundUp;
    return neg ? -v : v;
}
export const rupees = (s) => parseDecimal(String(s), 100, "amount");
export const qty = (s) => parseDecimal(String(s), 1000, "quantity");
/** Indian digit grouping: 1234567.5 -> ₹12,34,567.50 */
export function formatINR(p) {
    const neg = p < 0;
    const abs = Math.abs(p);
    const r = Math.floor(abs / 100), f = String(abs % 100).padStart(2, "0");
    let s = String(r);
    if (s.length > 3) {
        const last3 = s.slice(-3);
        const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
        s = rest + "," + last3;
    }
    return `${neg ? "-" : ""}₹${s}.${f}`;
}
export function formatQty(m) {
    const neg = m < 0, a = Math.abs(m);
    const f = String(a % 1000).padStart(3, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${Math.floor(a / 1000)}${f ? "." + f : ""}`;
}
