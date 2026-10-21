import { cashBalance, customerBalance, supplierBalance } from "./engine.js";
const inRange = (d, from, to) => d >= from && d <= to;
/** Purchases are NOT expenses (they become inventory). Batch labour/packaging flow via finished goods into COGS. */
export function profitAndLoss(s, from, to) {
    const sales = s.sales.filter(x => inRange(x.day, from, to));
    const net = sales.reduce((a, x) => a + x.total, 0);
    const discounts = sales.reduce((a, x) => a + x.discount, 0);
    const rets = s.returns.filter(x => inRange(x.day, from, to));
    const returns = rets.reduce((a, r) => a + r.value, 0);
    const cogsSold = sales.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.cogs, 0), 0);
    const cogsBack = rets.reduce((a, r) => a + r.lines.reduce((b, l) => b + l.cogsRestored, 0), 0);
    const cogs = cogsSold - cogsBack;
    const netSales = net - returns;
    const grossProfit = netSales - cogs;
    const operatingExpenses = s.expenses.filter(x => inRange(x.day, from, to)).reduce((a, x) => a + x.amount, 0);
    const stockLosses = s.adjustments.filter(x => inRange(x.day, from, to)).reduce((a, x) => a + x.loss, 0);
    return {
        grossSales: net + discounts, discounts, returns, netSales, cogs, grossProfit,
        operatingExpenses, stockLosses, netOperatingProfit: grossProfit - operatingExpenses - stockLosses,
    };
}
export function dashboard(s, today) {
    const month = today.slice(0, 7);
    const first = `${month}-01`, last = `${month}-31`;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const todays = profitAndLoss(s, today, today), monthly = profitAndLoss(s, first, last);
    const inv = (d) => d >= first && d <= last;
    const cashReceived = sum(s.cash.filter(c => c.amount > 0 && inv(c.day)).map(c => c.amount));
    const creditSales = sum(s.sales.filter(x => inv(x.day)).map(x => Math.max(0, x.total - x.paid)));
    return {
        todaySales: todays.netSales, monthSales: monthly.netSales, cashReceived, creditSales,
        customerUdhar: sum(Object.keys(s.customers).map(id => Math.max(0, customerBalance(s, id)))),
        supplierOutstanding: sum(Object.keys(s.suppliers).map(id => Math.max(0, supplierBalance(s, id)))),
        expenses: monthly.operatingExpenses, estimatedProfit: monthly.netOperatingProfit,
        cash: cashBalance(s),
        materialValue: sum(Object.values(s.materials).map(m => m.value)),
        finishedStock: Object.values(s.products).map(p => ({ id: p.id, name: p.name, qty: p.qty, value: p.value })),
        lowStock: [
            ...Object.values(s.materials).filter(m => m.lowStock > 0 && m.qty <= m.lowStock).map(m => ({ kind: "material", id: m.id, name: m.name })),
            ...Object.values(s.products).filter(p => p.lowStock > 0 && p.qty <= p.lowStock).map(p => ({ kind: "product", id: p.id, name: p.name })),
        ],
    };
}
/** Customer ledger: debit = sale billed, credit = payment/return. Balance >0 = customer owes. */
export function customerLedger(s, id) {
    const ev = [];
    for (const x of s.sales.filter(x => x.customerId === id)) {
        ev.push({ day: x.day, ref: x.id, label: "Sale", delta: x.total });
        if (x.paid)
            ev.push({ day: x.day, ref: x.id, label: "Paid at sale", delta: -x.paid });
    }
    const ids = new Set(s.sales.filter(x => x.customerId === id).map(x => x.id));
    for (const r of s.returns.filter(r => ids.has(r.saleId))) {
        ev.push({ day: r.day, ref: r.id, label: "Return", delta: -r.value });
        if (r.cashRefund)
            ev.push({ day: r.day, ref: r.id, label: "Cash refund", delta: r.cashRefund });
    }
    for (const p of s.customerPayments.filter(p => p.customerId === id))
        ev.push({ day: p.day, ref: p.id, label: p.advance ? "Advance" : "Payment", delta: -p.amount });
    ev.sort((a, b) => a.day.localeCompare(b.day));
    let bal = 0;
    return ev.map(e => { bal += e.delta; return { day: e.day, ref: e.ref, label: e.label, debit: Math.max(0, e.delta), credit: Math.max(0, -e.delta), balance: bal }; });
}
/** Supplier ledger: debit = payment (reduces what we owe), credit = purchase. Balance >0 = we owe supplier. */
export function supplierLedger(s, id) {
    const ev = [];
    for (const p of s.purchases.filter(p => p.supplierId === id)) {
        ev.push({ day: p.day, ref: p.id, label: "Purchase", delta: p.total });
        if (p.paid)
            ev.push({ day: p.day, ref: p.id, label: "Paid at purchase", delta: -p.paid });
    }
    for (const p of s.supplierPayments.filter(p => p.supplierId === id))
        ev.push({ day: p.day, ref: p.id, label: "Payment", delta: -p.amount });
    ev.sort((a, b) => a.day.localeCompare(b.day));
    let bal = 0;
    return ev.map(e => { bal += e.delta; return { day: e.day, ref: e.ref, label: e.label, debit: Math.max(0, -e.delta), credit: Math.max(0, e.delta), balance: bal }; });
}
export function cashBook(s, from, to) {
    const before = s.cash.filter(c => c.day < from).reduce((a, c) => a + c.amount, s.openingCash);
    let bal = before;
    const rows = s.cash.filter(c => inRange(c.day, from, to)).sort((a, b) => a.day.localeCompare(b.day))
        .map(c => { bal += c.amount; return { ...c, balance: bal }; });
    return { opening: before, rows, closing: bal };
}
/** Packet-wise profit for a period (by product). */
export function productProfit(s, from, to) {
    const out = {};
    const row = (id) => (out[id] ??= { sold: 0, sales: 0, cogs: 0, profit: 0 });
    for (const x of s.sales.filter(x => inRange(x.day, from, to)))
        for (const l of x.lines) {
            const r = row(l.productId);
            r.sold += l.qty;
            r.sales += l.net;
            r.cogs += l.cogs;
        }
    for (const x of s.returns.filter(x => inRange(x.day, from, to))) {
        const sale = s.sales.find(q => q.id === x.saleId);
        for (const l of x.lines) {
            const r = row(sale.lines[l.lineIndex].productId);
            r.sold -= l.qty;
            r.sales -= l.value;
            r.cogs -= l.cogsRestored;
        }
    }
    for (const r of Object.values(out))
        r.profit = r.sales - r.cogs;
    return out;
}
export const csv = (rows) => rows.map(r => r.map(c => { const t = String(c); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(",")).join("\n");
