import { assertInt, mulDiv } from "./money.js";
export const newState = (openingCash = 0) => ({
    version: 1, openingCash, cash: [], materials: {}, products: {}, customers: {}, suppliers: {},
    purchases: [], supplierPayments: [], batches: [], sales: [], returns: [],
    customerPayments: [], expenses: [], adjustments: [], txIds: {},
});
export class DuplicateTransactionError extends Error {
}
export class ValidationError extends Error {
}
const bad = (m) => { throw new ValidationError(m); };
/** Atomic command: clone, apply, replace. On any error the original state is untouched. */
function commit(s, id, fn) {
    if (!id)
        bad("transaction id required");
    if (s.txIds[id])
        throw new DuplicateTransactionError(`Duplicate transaction ${id}`);
    const d = structuredClone(s);
    fn(d);
    d.txIds[id] = true;
    return d;
}
const posInt = (n, l) => { assertInt(n, l); if (n <= 0)
    bad(`${l} must be > 0`); };
const nonNeg = (n, l) => { assertInt(n, l); if (n < 0)
    bad(`${l} must be >= 0`); };
const cashIn = (d, id, day, amount, note) => {
    if (amount !== 0)
        d.cash.push({ id: `${id}:cash${d.cash.length}`, day, amount, ref: id, note });
};
// ---------- masters ----------
export function addMaterial(s, m) {
    if (s.materials[m.id])
        bad("material exists");
    const d = structuredClone(s);
    d.materials[m.id] = { id: m.id, name: m.name, unit: m.unit, qty: 0, value: 0, lowStock: m.lowStock ?? 0 };
    return d;
}
export function addProduct(s, p) {
    if (s.products[p.id])
        bad("product exists");
    const d = structuredClone(s);
    d.products[p.id] = { id: p.id, name: p.name, qty: 0, value: 0, lowStock: p.lowStock ?? 0, prices: p.prices ?? {} };
    return d;
}
export function addParty(s, which, p) {
    if (s[which][p.id])
        bad("party exists");
    const d = structuredClone(s);
    d[which][p.id] = p;
    return d;
}
// ---------- purchases ----------
export function recordPurchase(s, t) {
    return commit(s, t.id, d => {
        if (!d.suppliers[t.supplierId])
            bad("unknown supplier");
        if (!t.lines.length)
            bad("no lines");
        let total = 0;
        for (const l of t.lines) {
            const m = d.materials[l.materialId] ?? bad("unknown material");
            posInt(l.qty, "qty");
            nonNeg(l.cost, "cost");
            m.qty += l.qty;
            m.value += l.cost;
            total += l.cost; // weighted average = value/qty
        }
        nonNeg(t.paid, "paid");
        if (t.paid > total)
            bad("paid exceeds purchase total; record extra as supplier payment");
        d.purchases.push({ id: t.id, day: t.day, supplierId: t.supplierId, lines: t.lines, total, paid: t.paid });
        cashIn(d, t.id, t.day, -t.paid, "purchase");
    });
}
export function paySupplier(s, t) {
    return commit(s, t.id, d => {
        if (!d.suppliers[t.supplierId])
            bad("unknown supplier");
        posInt(t.amount, "amount");
        d.supplierPayments.push({ ...t });
        cashIn(d, t.id, t.day, -t.amount, "supplier payment");
    });
}
// ---------- production ----------
export function recordBatch(s, t) {
    return commit(s, t.id, d => {
        const p = d.products[t.productId] ?? bad("unknown product");
        posInt(t.good, "good packets");
        nonNeg(t.damaged, "damaged packets");
        nonNeg(t.labour, "labour");
        nonNeg(t.packaging, "packaging");
        let materialCost = 0;
        const used = [];
        for (const u of t.used) {
            const m = d.materials[u.materialId] ?? bad("unknown material");
            posInt(u.qty, "material qty");
            if (u.qty > m.qty)
                bad(`insufficient ${m.name}`);
            const cost = u.qty === m.qty ? m.value : mulDiv(m.value, u.qty, m.qty); // exact value flow
            m.qty -= u.qty;
            m.value -= cost;
            materialCost += cost;
            used.push({ materialId: u.materialId, qty: u.qty, cost });
        }
        const totalCost = materialCost + t.labour + t.packaging;
        p.qty += t.good;
        p.value += totalCost; // damaged packets' cost is absorbed by good ones
        d.batches.push({
            id: t.id, day: t.day, productId: t.productId, used, labour: t.labour, packaging: t.packaging,
            materialCost, totalCost, good: t.good, damaged: t.damaged, costPerPacket: mulDiv(totalCost, 1, t.good),
        });
        // labour & packaging are paid in cash here and are production cost (NOT operating expense)
        cashIn(d, t.id, t.day, -(t.labour + t.packaging), "production labour/packaging");
    });
}
// ---------- sales ----------
export function recordSale(s, t) {
    return commit(s, t.id, d => {
        if (!d.customers[t.customerId])
            bad("unknown customer");
        if (!t.lines.length)
            bad("no lines");
        const lines = [];
        let total = 0, discount = 0;
        for (const l of t.lines) {
            const p = d.products[l.productId] ?? bad("unknown product");
            posInt(l.qty, "qty");
            nonNeg(l.price, "price");
            const disc = l.discount ?? 0;
            nonNeg(disc, "discount");
            const gross = l.qty * l.price;
            if (disc > gross)
                bad("discount exceeds line amount");
            if (l.qty > p.qty)
                bad(`insufficient stock: ${p.name}`);
            const cogs = l.qty === p.qty ? p.value : mulDiv(p.value, l.qty, p.qty);
            p.qty -= l.qty;
            p.value -= cogs;
            lines.push({ productId: l.productId, qty: l.qty, price: l.price, discount: disc, net: gross - disc, cogs, returned: 0 });
            total += gross - disc;
            discount += disc;
        }
        nonNeg(t.paid, "paid");
        // paid > total is allowed: the excess becomes customer advance (negative balance)
        d.sales.push({ id: t.id, day: t.day, customerId: t.customerId, lines, total, discount, paid: t.paid });
        cashIn(d, t.id, t.day, t.paid, "sale");
    });
}
export function recordSaleReturn(s, t) {
    return commit(s, t.id, d => {
        const sale = d.sales.find(x => x.id === t.saleId) ?? bad("unknown sale");
        const out = [];
        let value = 0;
        for (const r of t.lines) {
            const l = sale.lines[r.lineIndex] ?? bad("bad line");
            posInt(r.qty, "return qty");
            if (l.returned + r.qty > l.qty)
                bad("return exceeds sold quantity");
            // value is proportional share of net line (discount-aware); cumulative rounding keeps total exact
            const before = mulDiv(l.net, l.returned, l.qty), after = mulDiv(l.net, l.returned + r.qty, l.qty);
            const v = after - before;
            const cb = mulDiv(l.cogs, l.returned, l.qty), ca = mulDiv(l.cogs, l.returned + r.qty, l.qty);
            const cogsPart = ca - cb;
            l.returned += r.qty;
            if (r.good) {
                const p = d.products[l.productId];
                p.qty += r.qty;
                p.value += cogsPart;
            }
            out.push({ lineIndex: r.lineIndex, qty: r.qty, good: r.good, value: v, cogsRestored: r.good ? cogsPart : 0 });
            value += v;
        }
        const refund = t.cashRefund ?? 0;
        nonNeg(refund, "refund");
        if (refund > value)
            bad("cash refund exceeds return value");
        d.returns.push({ id: t.id, day: t.day, saleId: t.saleId, lines: out, value, cashRefund: refund });
        cashIn(d, t.id, t.day, -refund, "sale return refund");
    });
}
export function receivePayment(s, t) {
    return commit(s, t.id, d => {
        if (!d.customers[t.customerId])
            bad("unknown customer");
        posInt(t.amount, "amount");
        d.customerPayments.push({ id: t.id, day: t.day, customerId: t.customerId, amount: t.amount, advance: !!t.advance });
        cashIn(d, t.id, t.day, t.amount, "customer payment");
    });
}
// ---------- expenses & losses ----------
/** Operating expenses only (petrol, transport, repairs...). Do NOT enter material purchases or batch labour here. */
export function recordExpense(s, t) {
    return commit(s, t.id, d => {
        posInt(t.amount, "amount");
        d.expenses.push({ id: t.id, day: t.day, category: t.category, amount: t.amount, note: t.note ?? "" });
        cashIn(d, t.id, t.day, -t.amount, `expense: ${t.category}`);
    });
}
export function recordWastage(s, t) {
    return commit(s, t.id, d => {
        posInt(t.qty, "qty");
        const item = (t.kind === "material_wastage" ? d.materials[t.itemId] : d.products[t.itemId]) ?? bad("unknown item");
        if (t.qty > item.qty)
            bad("wastage exceeds stock");
        const loss = t.qty === item.qty ? item.value : mulDiv(item.value, t.qty, item.qty);
        item.qty -= t.qty;
        item.value -= loss;
        d.adjustments.push({ id: t.id, day: t.day, kind: t.kind, itemId: t.itemId, qty: t.qty, loss });
    });
}
// ---------- derived balances (never stored, so they can't drift) ----------
export const cashBalance = (s) => s.cash.reduce((a, c) => a + c.amount, s.openingCash);
export function customerBalance(s, id) {
    const sales = s.sales.filter(x => x.customerId === id);
    const saleIds = new Set(sales.map(x => x.id));
    const billed = sales.reduce((a, x) => a + x.total - x.paid, 0);
    const rets = s.returns.filter(r => saleIds.has(r.saleId)).reduce((a, r) => a + r.value - r.cashRefund, 0);
    const paid = s.customerPayments.filter(p => p.customerId === id).reduce((a, p) => a + p.amount, 0);
    return billed - rets - paid; // >0 customer owes us; <0 advance
}
export function supplierBalance(s, id) {
    const bought = s.purchases.filter(p => p.supplierId === id).reduce((a, p) => a + p.total - p.paid, 0);
    const paid = s.supplierPayments.filter(p => p.supplierId === id).reduce((a, p) => a + p.amount, 0);
    return bought - paid; // >0 we owe supplier
}
// ---------- master-data edits (not transactions; cannot change money/stock) ----------
export function setProductPrice(s, productId, key, price) {
    const d = structuredClone(s);
    (d.products[productId] ?? bad("unknown product")).prices[key] = price;
    return d;
}
export function setLowStock(s, kind, id, level) {
    nonNeg(level, "low-stock level");
    const d = structuredClone(s);
    const item = (kind === "material" ? d.materials[id] : d.products[id]) ?? bad("unknown item");
    item.lowStock = level;
    return d;
}
/** Only allowed before any cash movement, so history is never silently rewritten. */
export function setOpeningCash(s, amount) {
    assertInt(amount, "opening cash");
    if (s.cash.length)
        bad("opening cash can only be set before any transaction");
    return { ...structuredClone(s), openingCash: amount };
}
