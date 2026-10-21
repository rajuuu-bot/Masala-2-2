import { cashBalance } from "./engine.js";
export class MemoryAdapter {
    data = null;
    async load() { return this.data ? JSON.parse(this.data) : null; }
    async save(s) { this.data = JSON.stringify(s); }
}
/** Browser persistence. One record, written in a single IndexedDB transaction (atomic). */
export class IdbAdapter {
    dbName;
    key;
    constructor(dbName = "masala-app", key = "state") {
        this.dbName = dbName;
        this.key = key;
    }
    open() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(this.dbName, 1);
            r.onupgradeneeded = () => r.result.createObjectStore("kv");
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async load() {
        const db = await this.open();
        return new Promise((res, rej) => {
            const q = db.transaction("kv").objectStore("kv").get(this.key);
            q.onsuccess = () => { db.close(); res(q.result ?? null); };
            q.onerror = () => { db.close(); rej(q.error); };
        });
    }
    async save(s) {
        const db = await this.open();
        return new Promise((res, rej) => {
            const tx = db.transaction("kv", "readwrite");
            tx.objectStore("kv").put(s, this.key);
            tx.oncomplete = () => { db.close(); res(); };
            tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
        });
    }
}
// ---------- backup / restore ----------
async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function createBackup(s) {
    const data = JSON.stringify(s);
    return JSON.stringify({ app: "masala-app", version: 1, exportedAt: new Date().toISOString(), sha256: await sha256(data), data });
}
/** Throws if the file is not a valid, untampered, internally consistent backup. */
export async function parseBackup(text) {
    let env;
    try {
        env = JSON.parse(text);
    }
    catch {
        throw new Error("Backup file is not valid JSON");
    }
    if (env?.app !== "masala-app" || typeof env.data !== "string")
        throw new Error("Not a Masala app backup");
    if ((await sha256(env.data)) !== env.sha256)
        throw new Error("Backup is corrupted (checksum mismatch)");
    const s = JSON.parse(env.data);
    const problems = verifyState(s);
    if (problems.length)
        throw new Error("Backup failed consistency check: " + problems.join("; "));
    return s;
}
/** Cross-checks that stored stock/value agree with the transaction history. */
export function verifyState(s) {
    const p = [];
    if (s.version !== 1)
        p.push("unsupported version");
    for (const m of Object.values(s.materials)) {
        if (m.qty < 0 || m.value < 0)
            p.push(`negative material ${m.id}`);
        const bought = s.purchases.flatMap(x => x.lines).filter(l => l.materialId === m.id);
        const inQ = bought.reduce((a, l) => a + l.qty, 0), inV = bought.reduce((a, l) => a + l.cost, 0);
        const useQ = s.batches.flatMap(b => b.used).filter(u => u.materialId === m.id).reduce((a, u) => a + u.qty, 0);
        const useV = s.batches.flatMap(b => b.used).filter(u => u.materialId === m.id).reduce((a, u) => a + u.cost, 0);
        const wQ = s.adjustments.filter(a => a.kind === "material_wastage" && a.itemId === m.id).reduce((a, x) => a + x.qty, 0);
        const wV = s.adjustments.filter(a => a.kind === "material_wastage" && a.itemId === m.id).reduce((a, x) => a + x.loss, 0);
        if (inQ - useQ - wQ !== m.qty)
            p.push(`material qty mismatch ${m.id}`);
        if (inV - useV - wV !== m.value)
            p.push(`material value mismatch ${m.id}`);
    }
    for (const pr of Object.values(s.products)) {
        if (pr.qty < 0 || pr.value < 0)
            p.push(`negative product ${pr.id}`);
        const made = s.batches.filter(b => b.productId === pr.id);
        const sold = s.sales.flatMap(x => x.lines).filter(l => l.productId === pr.id);
        const back = s.returns.flatMap(r => r.lines.filter(l => l.good).map(l => ({ l, pid: s.sales.find(x => x.id === r.saleId).lines[l.lineIndex].productId }))).filter(x => x.pid === pr.id);
        const dmg = s.adjustments.filter(a => a.kind === "product_damage" && a.itemId === pr.id);
        const q = made.reduce((a, b) => a + b.good, 0) - sold.reduce((a, l) => a + l.qty, 0) + back.reduce((a, x) => a + x.l.qty, 0) - dmg.reduce((a, x) => a + x.qty, 0);
        const v = made.reduce((a, b) => a + b.totalCost, 0) - sold.reduce((a, l) => a + l.cogs, 0) + back.reduce((a, x) => a + x.l.cogsRestored, 0) - dmg.reduce((a, x) => a + x.loss, 0);
        if (q !== pr.qty)
            p.push(`product qty mismatch ${pr.id}`);
        if (v !== pr.value)
            p.push(`product value mismatch ${pr.id}`);
    }
    if (!Number.isSafeInteger(cashBalance(s)))
        p.push("bad cash");
    return p;
}
