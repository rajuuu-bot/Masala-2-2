import * as E from "./engine.js";
import { rupees, qty as Q, formatINR as inr, formatQty, mulDiv } from "./money.js";
import { dashboard, profitAndLoss, customerLedger, supplierLedger, cashBook, productProfit, csv } from "./reports.js";
import { IdbAdapter, createBackup, parseBackup } from "./storage.js";
function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === "class")
            el.className = v;
        else if (k.startsWith("on"))
            el.addEventListener(k.slice(2), v);
        else if (v === true)
            el.setAttribute(k, "");
        else if (v !== false && v != null)
            el.setAttribute(k, String(v));
    }
    for (const c of kids.flat())
        if (c)
            el.append(c);
    return el;
}
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const rs = (p) => (p / 100).toFixed(2).replace(/\.00$/, "");
const ls = {
    get: (k) => { try {
        return localStorage.getItem(k);
    }
    catch {
        return null;
    } },
    set: (k, v) => { try {
        localStorage.setItem(k, v);
    }
    catch { /* ignore */ } },
};
const byName = (a, b) => a.name.localeCompare(b.name);
const pk = (s) => { if (!/^\d+$/.test(s.trim()))
    throw new Error("Packets must be a whole number"); return Number(s.trim()); };
const money = (s) => rupees(s.trim() || "0");
function toast(msg, bad = false) {
    const t = h("div", { class: "toast" + (bad ? " bad" : "") }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), bad ? 4500 : 1800);
}
const field = (label, input) => h("label", { class: "f" }, h("span", {}, label), input);
const num = (ph = "") => h("input", { type: "text", inputmode: "decimal", placeholder: ph, autocomplete: "off" });
const sel = (opts, value) => {
    const s = h("select");
    for (const [v, t] of opts)
        s.append(h("option", { value: v, selected: v === value }, t));
    return s;
};
const dateInput = (v = today()) => h("input", { type: "date", value: v });
const btn = (label, onclick, cls = "") => h("button", { type: "button", class: "btn " + cls, onclick }, label);
function table(head, rows) {
    return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ...head.map(x => h("th", {}, x)))), h("tbody", {}, ...rows.map(r => h("tr", {}, ...r.map(c => h("td", {}, c)))))));
}
function download(name, text, type = "text/plain") {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
}
// ---------- state + safe commit ----------
const db = new IdbAdapter();
let state = E.newState();
let route = "home";
let params = {};
let busy = false;
/** Apply a command, persist, and only then adopt it. Failure leaves state and storage untouched. */
async function run(fn, ok = "Saved ✓") {
    if (busy)
        return false;
    busy = true;
    try {
        const next = fn(state);
        await db.save(next);
        state = next;
        toast(ok);
        return true;
    }
    catch (e) {
        toast(e instanceof E.DuplicateTransactionError ? "Already saved - duplicate ignored" : (e?.message ?? String(e)), true);
        return false;
    }
    finally {
        busy = false;
    }
}
const guard = (fn) => async () => { try {
    await fn();
}
catch (e) {
    toast(e?.message ?? String(e), true);
} };
function seed() {
    let s = E.newState();
    s = E.addProduct(s, { id: "p-47", name: "47 Padiki" });
    s = E.addProduct(s, { id: "p-baghban138", name: "Baghban 138 Padiki" });
    for (const [id, name, unit] of [["m-sopari", "Sopari", "kg"], ["m-tamaku", "Tamaku", "kg"], ["m-chuno", "Chuno", "kg"], ["m-kagad", "Kagad", "kg"],
        ["m-rubber", "Rubber", "kg"], ["m-stickers", "Stickers", "pcs"], ["m-rolls", "Packaging rolls", "roll"], ["m-polybags", "Polybags", "pcs"]])
        s = E.addMaterial(s, { id, name, unit });
    return s;
}
function partySelect(which, label) {
    const el = h("select", { "aria-label": label });
    const fill = (v) => el.replaceChildren(...Object.values(state[which]).sort(byName).map(p => h("option", { value: p.id, selected: p.id === v }, p.name)));
    fill();
    const add = btn("＋ New", guard(async () => {
        const name = prompt(which === "customers" ? "Shop / customer name?" : "Supplier name?")?.trim();
        if (!name)
            return;
        const id = (which === "customers" ? "c-" : "s-") + uid();
        if (await run(s => E.addParty(s, which, { id, name })))
            fill(id);
    }), "small");
    return { el, wrap: h("div", { class: "f" }, h("span", {}, label), h("div", { class: "inline" }, el, add)) };
}
function payMode(onChange) {
    let mode = "cash";
    const modes = ["cash", "credit", "part"], names = { cash: "Cash (full)", credit: "Credit (udhar)", part: "Part paid" };
    const part = num("0");
    const partF = field("Paid now ₹", part);
    partF.hidden = true;
    const btns = modes.map(m => h("button", {
        type: "button", class: "seg" + (m === mode ? " on" : ""),
        onclick: () => { mode = m; btns.forEach((b, i) => b.classList.toggle("on", modes[i] === m)); partF.hidden = m !== "part"; onChange(); },
    }, names[m]));
    part.addEventListener("input", onChange);
    return { el: h("div", {}, h("div", { class: "segs" }, ...btns), partF), paid: (total) => mode === "cash" ? total : mode === "credit" ? 0 : money(part.value) };
}
// ---------- screens ----------
function home() {
    const d = dashboard(state, today());
    const tile = (l, v, cls = "") => h("div", { class: "tile " + cls }, h("small", {}, l), h("b", {}, inr(v)));
    const last = ls.get("lastBackup");
    const stale = !last || (Date.now() - Number(last)) > 7 * 864e5;
    return h("div", {}, stale && h("div", { class: "warn", onclick: () => go("backup") }, last ? "No backup in over 7 days. Tap to back up." : "No backup yet. Tap to back up your data."), h("div", { class: "grid" }, tile("Today's sales", d.todaySales), tile("Month sales", d.monthSales), tile("Cash received (month)", d.cashReceived, "good"), tile("Credit sales (month)", d.creditSales), tile("Customer udhar", d.customerUdhar, "bad"), tile("Supplier due", d.supplierOutstanding, "bad"), tile("Expenses (month)", d.expenses), tile("Est. profit (month)", d.estimatedProfit, d.estimatedProfit < 0 ? "bad" : "good"), tile("Cash in hand", d.cash)), d.lowStock.length > 0 && h("div", { class: "card warn" }, h("b", {}, "Low stock: "), d.lowStock.map(x => x.name).join(", ")), h("h3", {}, "Finished packets"), table(["Product", "In stock", "Value"], d.finishedStock.map(p => [p.name, String(p.qty), inr(p.value)])), h("h3", {}, "Raw materials"), table(["Material", "Stock", "Value"], Object.values(state.materials).sort(byName).map(m => [m.name, `${formatQty(m.qty)} ${m.unit}`, inr(m.value)])));
}
function sell() {
    const id = uid(), date = dateInput(), cust = partySelect("customers", "Shop / customer");
    const rows = [];
    const list = h("div"), totalEl = h("div", { class: "total" });
    const lineData = () => rows.map(r => ({ productId: r.p.value, qty: pk(r.q.value), price: money(r.pr.value), discount: money(r.d.value) }));
    const pm = payMode(update);
    function update() {
        try {
            const t = lineData().reduce((a, l) => a + l.qty * l.price - l.discount, 0), paid = pm.paid(t);
            totalEl.textContent = `Total ${inr(t)}  |  Paid ${inr(paid)}  |  Udhar ${inr(t - paid)}`;
        }
        catch {
            totalEl.textContent = "Total -";
        }
    }
    const prefill = (r) => {
        const p = state.products[r.p.value];
        const v = p?.prices[cust.el.value] ?? p?.prices["default"];
        if (v != null)
            r.pr.value = rs(v);
    };
    function addLine() {
        const p = sel(Object.values(state.products).sort(byName).map(x => [x.id, `${x.name} (${x.qty} in stock)`]));
        const q = num("0"), pr = num("0"), d = num("0");
        const r = { p, q, pr, d, el: h("div", { class: "card" }) };
        r.el.append(p, h("div", { class: "grid3" }, field("Packets", q), field("Price ₹/packet", pr), field("Discount ₹", d)), btn("Remove line", () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); update(); }, "small ghost"));
        p.addEventListener("change", () => { prefill(r); update(); });
        [q, pr, d].forEach(i => i.addEventListener("input", update));
        rows.push(r);
        list.append(r.el);
        prefill(r);
        update();
    }
    cust.el.addEventListener("change", () => { rows.forEach(prefill); update(); });
    addLine();
    return h("div", {}, h("h2", {}, "New sale"), field("Date", date), cust.wrap, list, btn("＋ Add another product", addLine, "ghost"), h("h3", {}, "Payment"), pm.el, totalEl, btn("Save sale", guard(async () => {
        if (!cust.el.value)
            throw new Error("Add a shop / customer first");
        const lines = lineData(), total = lines.reduce((a, l) => a + l.qty * l.price - l.discount, 0), paid = pm.paid(total), cid = cust.el.value;
        const ok = await run(s => {
            let n = E.recordSale(s, { id, day: date.value, customerId: cid, lines, paid });
            for (const l of lines) {
                n = E.setProductPrice(n, l.productId, cid, l.price);
                if (n.products[l.productId].prices["default"] == null)
                    n = E.setProductPrice(n, l.productId, "default", l.price);
            }
            return n;
        });
        if (ok)
            go("customer", { id: cid });
    }), "primary big"));
}
function newMaterial(after) {
    return btn("＋ New material", guard(async () => {
        const name = prompt("Material name?")?.trim();
        if (!name)
            return;
        const unit = prompt("Unit (kg, pcs, roll...)?", "kg")?.trim() || "kg";
        if (await run(s => E.addMaterial(s, { id: "m-" + uid(), name, unit })))
            after();
    }), "small ghost");
}
const matOptions = () => Object.values(state.materials).sort(byName).map(m => [m.id, `${m.name} (${formatQty(m.qty)} ${m.unit})`]);
function buy() {
    const id = uid(), date = dateInput(), sup = partySelect("suppliers", "Supplier");
    const rows = [];
    const list = h("div"), totalEl = h("div", { class: "total" });
    const lineData = () => rows.map(r => ({ materialId: r.m.value, qty: Q(r.q.value || "0"), cost: money(r.c.value) }));
    const pm = payMode(update);
    function update() {
        try {
            const t = lineData().reduce((a, l) => a + l.cost, 0), p = pm.paid(t);
            totalEl.textContent = `Total ${inr(t)}  |  Paid ${inr(p)}  |  Due ${inr(t - p)}`;
        }
        catch {
            totalEl.textContent = "Total -";
        }
    }
    function addLine() {
        const m = sel(matOptions()), q = num("0"), c = num("0");
        const r = { m, q, c, el: h("div", { class: "card" }) };
        r.el.append(m, h("div", { class: "grid2" }, field("Quantity", q), field("Total cost ₹", c)), btn("Remove line", () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); update(); }, "small ghost"));
        [q, c].forEach(i => i.addEventListener("input", update));
        rows.push(r);
        list.append(r.el);
        update();
    }
    addLine();
    const refreshMats = () => rows.forEach(r => { const v = r.m.value; r.m.replaceChildren(...matOptions().map(([x, t]) => h("option", { value: x, selected: x === v }, t))); });
    return h("div", {}, h("h2", {}, "Buy raw material"), field("Date", date), sup.wrap, list, h("div", { class: "inline" }, btn("＋ Add line", addLine, "ghost"), newMaterial(refreshMats)), h("h3", {}, "Payment"), pm.el, totalEl, btn("Save purchase", guard(async () => {
        if (!sup.el.value)
            throw new Error("Add a supplier first");
        const lines = lineData(), total = lines.reduce((a, l) => a + l.cost, 0);
        if (await run(s => E.recordPurchase(s, { id, day: date.value, supplierId: sup.el.value, lines, paid: pm.paid(total) })))
            go("supplier", { id: sup.el.value });
    }), "primary big"));
}
function make() {
    const id = uid(), date = dateInput();
    const prod = sel(Object.values(state.products).sort(byName).map(p => [p.id, p.name]));
    const rows = [];
    const list = h("div"), prev = h("div", { class: "total" });
    const labour = num("0"), pack = num("0"), good = num("0"), dmg = num("0");
    const used = () => rows.map(r => ({ materialId: r.m.value, qty: Q(r.q.value || "0") })).filter(u => u.qty > 0);
    function update() {
        try {
            let mat = 0;
            for (const u of used()) {
                const m = state.materials[u.materialId];
                if (u.qty > m.qty)
                    throw new Error();
                mat += u.qty === m.qty ? m.value : mulDiv(m.value, u.qty, m.qty);
            }
            const total = mat + money(labour.value) + money(pack.value), g = pk(good.value || "0");
            prev.textContent = `Material ${inr(mat)} + labour/packaging = ${inr(total)}` + (g > 0 ? `  →  ${inr(mulDiv(total, 1, g))} per packet` : "");
        }
        catch {
            prev.textContent = "Cost: check quantities (not more than stock)";
        }
    }
    function addLine() {
        const m = sel(matOptions()), q = num("0");
        const r = { m, q, el: h("div", { class: "card" }) };
        r.el.append(m, field("Quantity used", q), btn("Remove", () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); update(); }, "small ghost"));
        [m, q].forEach(i => i.addEventListener("input", update));
        rows.push(r);
        list.append(r.el);
        update();
    }
    [labour, pack, good, dmg].forEach(i => i.addEventListener("input", update));
    addLine();
    return h("div", {}, h("h2", {}, "Production batch"), field("Date", date), field("Product made", prod), h("h3", {}, "Raw materials used"), list, btn("＋ Add material", addLine, "ghost"), h("div", { class: "grid2" }, field("Labour (majuri) ₹", labour), field("Packaging ₹", pack), field("Good packets", good), field("Damaged packets", dmg)), prev, btn("Save batch", guard(async () => {
        const g = pk(good.value), d = pk(dmg.value || "0");
        if (await run(s => E.recordBatch(s, { id, day: date.value, productId: prod.value, used: used(), labour: money(labour.value), packaging: money(pack.value), good: g, damaged: d }), "Batch saved ✓"))
            go("home");
    }), "primary big"));
}
function expense() {
    const id = uid(), date = dateInput();
    const cat = sel(["Petrol", "Transport", "Repairs", "Rent / electricity", "Other"].map(x => [x, x]));
    const amt = num("0"), note = h("input", { type: "text", placeholder: "Optional note" });
    const month = today().slice(0, 7);
    const list = state.expenses.filter(e => e.day.startsWith(month)).sort((a, b) => b.day.localeCompare(a.day));
    return h("div", {}, h("h2", {}, "Expense (paid in cash)"), h("p", { class: "hint" }, "Do not enter raw-material purchases or batch labour/packaging here. They are already counted in Buy and Make."), field("Date", date), field("Category", cat), field("Amount ₹", amt), field("Note", note), btn("Save expense", guard(async () => { if (await run(s => E.recordExpense(s, { id, day: date.value, category: cat.value, amount: money(amt.value), note: note.value })))
        go("expense"); }), "primary big"), h("h3", {}, `This month: ${inr(list.reduce((a, e) => a + e.amount, 0))}`), table(["Date", "Category", "₹"], list.map(e => [e.day, e.category + (e.note ? ` - ${e.note}` : ""), inr(e.amount)])));
}
function partyList(which) {
    const cust = which === "customers";
    const items = Object.values(state[which]).sort(byName);
    return h("div", {}, h("h2", {}, cust ? "Customers (udhar)" : "Suppliers"), btn(cust ? "＋ New shop" : "＋ New supplier", guard(async () => {
        const name = prompt("Name?")?.trim();
        if (!name)
            return;
        if (await run(s => E.addParty(s, which, { id: (cust ? "c-" : "s-") + uid(), name })))
            go(route);
    }), "ghost"), ...items.map(p => {
        const b = cust ? E.customerBalance(state, p.id) : E.supplierBalance(state, p.id);
        return h("div", { class: "card row link", onclick: () => go(cust ? "customer" : "supplier", { id: p.id }) }, h("b", {}, p.name), h("span", { class: b > 0 ? "bad" : "good" }, b === 0 ? "Settled" : b > 0 ? (cust ? "Owes " : "We owe ") + inr(b) : "Advance " + inr(-b)));
    }), !items.length && h("p", { class: "hint" }, "None yet."));
}
function ledgerView(id, cust) {
    const party = (cust ? state.customers : state.suppliers)[id];
    if (!party)
        return h("p", {}, "Not found");
    const rows = cust ? customerLedger(state, id) : supplierLedger(state, id);
    const bal = rows.at(-1)?.balance ?? 0;
    const tid = uid(), date = dateInput(), amt = num("0"), adv = h("input", { type: "checkbox" });
    const sales = cust ? state.sales.filter(s => s.customerId === id).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 10) : [];
    return h("div", {}, btn("← Back", () => go(cust ? "customers" : "suppliers"), "small ghost"), h("h2", {}, party.name), h("div", { class: "tile " + (bal > 0 ? "bad" : "good") }, h("small", {}, cust ? "Balance (udhar)" : "We owe"), h("b", {}, inr(bal))), h("h3", {}, cust ? "Receive payment" : "Pay supplier"), h("div", { class: "card" }, field("Date", date), field("Amount ₹", amt), cust && h("label", { class: "chk" }, adv, " Advance (before a sale)"), btn("Save", guard(async () => {
        if (await run(s => cust ? E.receivePayment(s, { id: tid, day: date.value, customerId: id, amount: money(amt.value), advance: adv.checked })
            : E.paySupplier(s, { id: tid, day: date.value, supplierId: id, amount: money(amt.value) })))
            go(route, params);
    }), "primary")), h("h3", {}, "Ledger"), table(["Date", "Entry", "Debit", "Credit", "Balance"], rows.map(r => [r.day, r.label, r.debit ? inr(r.debit) : "", r.credit ? inr(r.credit) : "", inr(r.balance)])), cust && h("h3", {}, "Recent sales / returns"), ...sales.map(s => h("div", { class: "card" }, h("b", {}, `${s.day}  ${inr(s.total)}`), ...s.lines.map((l, i) => h("div", { class: "row" }, h("span", {}, `${l.qty} × ${state.products[l.productId].name}${l.returned ? ` (returned ${l.returned})` : ""}`), l.returned < l.qty && btn("Return", guard(async () => {
        const q = Number(prompt(`Return how many? (max ${l.qty - l.returned})`));
        if (!q)
            return;
        const good = confirm("Packets in good condition (put back in stock)?\nOK = yes, Cancel = damaged");
        const refund = money(prompt("Cash refunded now ₹ (0 if adjusting udhar)", "0") ?? "0");
        if (await run(st => E.recordSaleReturn(st, { id: uid(), day: today(), saleId: s.id, lines: [{ lineIndex: i, qty: q, good }], cashRefund: refund })))
            go(route, params);
    }), "small ghost"))))));
}
function stock() {
    const redo = () => go("stock");
    const adj = (kind, itemId, unit) => btn(kind === "material_wastage" ? "Wastage" : "Damaged", guard(async () => {
        const raw = prompt("Quantity lost?");
        if (!raw)
            return;
        const q = unit ? Q(raw) : pk(raw);
        if (await run(s => E.recordWastage(s, { id: uid(), day: today(), kind, itemId, qty: q })))
            redo();
    }), "small ghost");
    const alert = (kind, id, unit) => btn("Alert", guard(async () => {
        const raw = prompt("Warn me when stock falls to (0 = off)?");
        if (raw == null)
            return;
        if (await run(s => E.setLowStock(s, kind, id, unit ? Q(raw) : pk(raw))))
            redo();
    }), "small ghost");
    return h("div", {}, h("h2", {}, "Stock"), h("h3", {}, "Raw materials"), ...Object.values(state.materials).sort(byName).map(m => h("div", { class: "card" }, h("div", { class: "row" }, h("b", {}, m.name), h("span", { class: m.lowStock > 0 && m.qty <= m.lowStock ? "bad" : "" }, `${formatQty(m.qty)} ${m.unit}`)), h("small", {}, `Avg cost ${m.qty ? inr(mulDiv(m.value, 1000, m.qty)) : "-"}/${m.unit} · Value ${inr(m.value)}`), h("div", { class: "inline" }, adj("material_wastage", m.id, true), alert("material", m.id, true)))), newMaterial(redo), h("h3", {}, "Finished packets"), ...Object.values(state.products).sort(byName).map(p => h("div", { class: "card" }, h("div", { class: "row" }, h("b", {}, p.name), h("span", { class: p.lowStock > 0 && p.qty <= p.lowStock ? "bad" : "" }, `${p.qty} packets`)), h("small", {}, `Avg cost ${p.qty ? inr(mulDiv(p.value, 1, p.qty)) : "-"}/packet · Value ${inr(p.value)}`), h("div", { class: "inline" }, adj("product_damage", p.id, false), alert("product", p.id, false)))), btn("＋ New product", guard(async () => {
        const name = prompt("Product name?")?.trim();
        if (name && await run(s => E.addProduct(s, { id: "p-" + uid(), name })))
            redo();
    }), "small ghost"));
}
function reports() {
    const from = dateInput(today().slice(0, 8) + "01"), to = dateInput(), out = h("div");
    const draw = () => {
        const f = from.value, t = to.value, p = profitAndLoss(state, f, t), pp = productProfit(state, f, t), cb = cashBook(state, f, t);
        out.replaceChildren(h("h3", {}, "Profit & loss"), table(["", "₹"], [["Gross sales", inr(p.grossSales)], ["Less discounts", inr(-p.discounts)], ["Less returns", inr(-p.returns)], ["Net sales", inr(p.netSales)],
            ["Cost of goods sold", inr(p.cogs)], ["Gross profit", inr(p.grossProfit)], ["Operating expenses", inr(p.operatingExpenses)],
            ["Wastage / damage", inr(p.stockLosses)], ["Net profit", inr(p.netOperatingProfit)]]), h("h3", {}, "Profit by product"), table(["Product", "Sold", "Sales", "Cost", "Profit"], Object.entries(pp).map(([id, r]) => [state.products[id].name, String(r.sold), inr(r.sales), inr(r.cogs), inr(r.profit)])), h("h3", {}, `Cash book (opening ${inr(cb.opening)}, closing ${inr(cb.closing)})`), table(["Date", "Note", "₹", "Balance"], cb.rows.slice(-60).map(r => [r.day, r.note, inr(r.amount), inr(r.balance)])), h("h3", {}, "Export CSV"), h("div", { class: "inline wrap" }, btn("Sales", () => download(`sales-${f}_${t}.csv`, "﻿" + csv([["Date", "Customer", "Product", "Qty", "Price", "Discount", "Net", "Cost"],
            ...state.sales.filter(s => s.day >= f && s.day <= t).flatMap(s => s.lines.map(l => [s.day, state.customers[s.customerId].name, state.products[l.productId].name, l.qty, rs(l.price), rs(l.discount), rs(l.net), rs(l.cogs)]))]), "text/csv"), "small"), btn("Cash book", () => download(`cashbook-${f}_${t}.csv`, "﻿" + csv([["Date", "Note", "Amount", "Balance"], ...cb.rows.map(r => [r.day, r.note, rs(r.amount), rs(r.balance)])]), "text/csv"), "small"), btn("Customer udhar", () => download("udhar.csv", "﻿" + csv([["Customer", "Balance"], ...Object.values(state.customers).map(c => [c.name, rs(E.customerBalance(state, c.id))])]), "text/csv"), "small"), btn("Supplier due", () => download("suppliers.csv", "﻿" + csv([["Supplier", "Balance"], ...Object.values(state.suppliers).map(c => [c.name, rs(E.supplierBalance(state, c.id))])]), "text/csv"), "small"), btn("Stock", () => download("stock.csv", "﻿" + csv([["Item", "Qty", "Value"], ...Object.values(state.materials).map(m => [m.name, formatQty(m.qty), rs(m.value)]), ...Object.values(state.products).map(p => [p.name, p.qty, rs(p.value)])]), "text/csv"), "small")));
    };
    from.addEventListener("change", draw);
    to.addEventListener("change", draw);
    draw();
    return h("div", {}, h("h2", {}, "Reports"), h("div", { class: "grid2" }, field("From", from), field("To", to)), out);
}
function backup() {
    const file = h("input", { type: "file", accept: ".json,application/json" });
    const open = num(rs(state.openingCash));
    const last = ls.get("lastBackup");
    return h("div", {}, h("h2", {}, "Backup & restore"), h("p", { class: "hint" }, "Your data lives only on this phone. Back up often and save the file somewhere safe (WhatsApp to yourself, Google Drive, PC)."), h("p", {}, last ? "Last backup: " + new Date(Number(last)).toLocaleString() : "No backup yet."), btn("Download backup", guard(async () => { download(`masala-backup-${today()}.json`, await createBackup(state), "application/json"); ls.set("lastBackup", String(Date.now())); toast("Backup downloaded"); go("backup"); }), "primary big"), h("h3", {}, "Restore from backup"), file, btn("Restore (replaces current data)", guard(async () => {
        const f = file.files?.[0];
        if (!f)
            throw new Error("Choose a backup file first");
        const s = await parseBackup(await f.text());
        if (!confirm("This REPLACES all data on this phone with the backup. Continue?"))
            return;
        await db.save(s);
        state = s;
        toast("Restored ✓");
        go("home");
    }), "danger"), h("h3", {}, "Opening cash"), h("p", { class: "hint" }, "Cash in hand when you started using the app. Only editable before the first transaction."), h("div", { class: "inline" }, open, btn("Set", guard(async () => { if (await run(s => E.setOpeningCash(s, money(open.value))))
        go("backup"); }), "small")));
}
function more() {
    const link = (l, r) => h("div", { class: "card link", onclick: () => go(r) }, h("b", {}, l));
    return h("div", {}, h("h2", {}, "More"), link("Expenses", "expense"), link("Customers (udhar)", "customers"), link("Suppliers", "suppliers"), link("Stock & wastage", "stock"), link("Reports & CSV", "reports"), link("Backup & restore", "backup"));
}
// ---------- routing ----------
const screens = {
    home, sell, buy, make, more, expense, stock, reports, backup,
    customers: () => partyList("customers"), suppliers: () => partyList("suppliers"),
    customer: () => ledgerView(params.id, true), supplier: () => ledgerView(params.id, false),
};
const tabOf = (r) => ["home", "sell", "buy", "make"].includes(r) ? r : "more";
function go(r, p = {}) { route = r; params = p; render(); }
function render() {
    $("#app").replaceChildren(screens[route]());
    document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.r === tabOf(route)));
    window.scrollTo(0, 0);
}
async function init() {
    try {
        const saved = await db.load();
        if (saved)
            state = saved;
        else {
            state = seed();
            await db.save(state);
        }
        try {
            await navigator.storage?.persist?.();
        }
        catch { /* best effort */ }
        document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.r)));
        if ("serviceWorker" in navigator)
            navigator.serviceWorker.register("./sw.js").catch(() => { });
        render();
    }
    catch (e) {
        $("#app").replaceChildren(h("div", { class: "warn" }, "Cannot open local database: " + (e?.message ?? e) + ". Do not use private/incognito mode."));
    }
}
init();
