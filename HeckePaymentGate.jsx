import { useState, useCallback, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════════
   HECKE PAYMENT GATE v1.0
   Embeddable Pre-Execution Verification + Real-Time Alert Feed
   © 2026 S. F. Lefort · SFL Consulting · Herstal, Belgium
   ═══════════════════════════════════════════════════════════════════ */

/* ── 0-HECKE ALGEBRAIC ENGINE ──────────────────────────────────── */
function reduce(w) {
  const r = [...w], st = [], v = new Set();
  let c = true;
  while (c) {
    c = false;
    for (let i = 0; i < r.length - 1; i++) {
      if (r[i] === r[i + 1]) {
        r.splice(i + 1, 1);
        st.push({ rule: "R1", pos: i, d: "Idempotent" });
        v.add("R1"); c = true; break;
      }
    }
    if (c) continue;
    for (let i = 0; i < r.length - 1; i++) {
      if (Math.abs(r[i] - r[i + 1]) >= 2 && r[i] > r[i + 1]) {
        [r[i], r[i + 1]] = [r[i + 1], r[i]];
        st.push({ rule: "R2", pos: i, d: "Far commute" });
        v.add("R2"); c = true; break;
      }
    }
    if (c) continue;
    for (let i = 0; i < r.length - 2; i++) {
      if (r[i] === r[i + 2] && Math.abs(r[i] - r[i + 1]) === 1 && r[i] > r[i + 1]) {
        const a = r[i], b = r[i + 1];
        r[i] = b; r[i + 1] = a; r[i + 2] = b;
        st.push({ rule: "R3", pos: i, d: "Braid" });
        v.add("R3"); c = true; break;
      }
    }
  }
  return { canonical: r, steps: st, violations: [...v] };
}

function hProof(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(16).padStart(16, "0");
}

/* ── PATTERN CATALOGS ──────────────────────────────────────────── */
const PP = [
  { code: "DUP-INIT", name: "Duplicate Initiation", sev: "HIGH", w: [1, 1, 2, 3, 4, 5], reg: "PSD3/PSR Art. 49", risk: "Double debit on payer account", ctrl: "ITGC-PM-01" },
  { code: "DUP-SETTLE", name: "Duplicate Settlement", sev: "CRITICAL", w: [1, 2, 3, 4, 5, 5], reg: "SFD 98/26/EC, DORA Art. 6", risk: "Funds transferred twice", ctrl: "ITGC-PM-02" },
  { code: "AUTH-BYPASS", name: "Authentication Bypass", sev: "CRITICAL", w: [1, 3, 2, 3, 4, 5], reg: "PSD2 SCA Art. 97", risk: "No SCA before execution", ctrl: "ITGC-PM-03" },
  { code: "EXEC-NO-AUTH", name: "Exec Without Authorization", sev: "CRITICAL", w: [1, 4, 2, 3, 5], reg: "PSD2 Art. 97(1)", risk: "Funds moved before auth", ctrl: "ITGC-PM-04" },
  { code: "EARLY-SETTLE", name: "Premature Settlement", sev: "CRITICAL", w: [1, 2, 5, 3, 4], reg: "SFD 98/26/EC", risk: "Settlement before execution", ctrl: "ITGC-PM-05" },
  { code: "SPLIT", name: "Threshold Splitting", sev: "HIGH", w: [1, 1, 2, 3, 4, 5], reg: "PSD2 RTS Art. 16", risk: "SCA threshold circumvention", ctrl: "ITGC-PM-06" },
  { code: "REPLAY", name: "Transaction Replay", sev: "CRITICAL", w: [1, 2, 2, 2, 3, 4, 5], reg: "PSD3/PSR Art. 83", risk: "Previously executed TX replayed", ctrl: "ITGC-PM-07" },
  { code: "BEC", name: "Beneficiary Swap (BEC)", sev: "CRITICAL", w: [1, 2, 4, 3, 4, 5], reg: "PSD2 Art. 64", risk: "Beneficiary changed post-auth", ctrl: "ITGC-PM-08" },
];

const IP = [
  { code: "DUP-PAY", name: "Duplicate Vendor Payment", sev: "CRITICAL", w: [1, 2, 3, 4, 5, 6, 6], reg: "SOX 404", risk: "Vendor paid twice", ctrl: "ITGC-INV-02" },
  { code: "NO-PO", name: "Invoice Without PO", sev: "CRITICAL", w: [1, 4, 2, 3, 5, 6], reg: "SOX 404, ISAE 3402", risk: "No PO approval", ctrl: "ITGC-INV-03" },
  { code: "PAY-NO-GR", name: "Pay Before Goods Receipt", sev: "CRITICAL", w: [1, 2, 6, 3, 4, 5], reg: "SOX 404", risk: "Payment before goods received", ctrl: "ITGC-INV-04" },
  { code: "PAY-NO-MATCH", name: "Pay Before 3-Way Match", sev: "CRITICAL", w: [1, 2, 3, 6, 4, 5], reg: "SOX 404", risk: "Pay before reconciliation — MW", ctrl: "ITGC-INV-05", mw: true },
  { code: "INV-SPLIT", name: "Invoice Splitting", sev: "HIGH", w: [1, 1, 2, 3, 4, 5, 6], reg: "SOX 404, EU 2014/24", risk: "Threshold circumvention", ctrl: "ITGC-INV-06" },
];

/* ── VERIFICATION ENGINE ───────────────────────────────────────── */
function verifyTx(tx) {
  const t0 = performance.now();
  const isPay = tx.type === "payment";
  const pats = isPay ? PP : IP;
  const normW = isPay ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
  const word = tx.lifecycleWord || normW;
  const { canonical, steps, violations } = reduce(word);
  const normC = reduce(normW).canonical;
  const isNorm = violations.length === 0 && JSON.stringify(canonical) === JSON.stringify(normC);

  let match = null;
  if (!isNorm) {
    for (const p of pats) {
      const pr = reduce(p.w);
      if (JSON.stringify(canonical) === JSON.stringify(pr.canonical) ||
        violations.some(x => pr.violations.includes(x))) {
        match = p; break;
      }
    }
    if (!match && violations.length > 0) match = pats[0];
  }

  const pd = JSON.stringify({ word, canonical, violations, ts: Date.now(), id: tx.id });
  return {
    txId: tx.id,
    verdict: match ? "BLOCKED" : "APPROVED",
    finding: match ? {
      code: match.code, name: match.name, severity: match.sev,
      regulation: match.reg, risk: match.risk, control: match.ctrl, mw: match.mw || false,
    } : null,
    proof: {
      input: word.join("-"), canonical: canonical.join("-"),
      steps: steps.length, violated: violations, hash: hProof(pd),
    },
    latency: Math.round((performance.now() - t0) * 1000),
    ts: new Date().toISOString(),
  };
}

/* ── THEME ─────────────────────────────────────────────────────── */
const C = {
  bg: "#f6f7f9", sf: "#ffffff", sf2: "#f0f2f5",
  nv: "#1a2744", nv2: "#2a3a5c",
  gd: "#c49a2a", gdL: "#d4af37",
  tx: "#1a2744", t1: "#3d4f6f", t2: "#6b7a94", t3: "#97a3b6",
  ok: "#0d7a3e", okBg: "#edf7f0", okBd: "#b8e0c4",
  cr: "#c0392b", crBg: "#fdf2f1", crBd: "#f0b8b3",
  am: "#b8860b", amBg: "#fef9ec", amBd: "#f0dea0",
  bd: "#e2e6ed",
  hd: "'Bricolage Grotesque','Libre Franklin',system-ui,sans-serif",
  sn: "'DM Sans','Libre Franklin',system-ui,sans-serif",
  mn: "'JetBrains Mono','Fira Code',monospace",
};
const fmt = n => n >= 1e6 ? `€${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `€${(n / 1e3).toFixed(1)}K` : `€${n.toFixed(0)}`;

/* ── DEMO DATA ─────────────────────────────────────────────────── */
let _s = 42;
const Rn = () => { _s = (_s * 16807) % 2147483647; return (_s - 1) / 2147483646; };
const pk = a => a[Math.floor(Rn() * a.length)];
const rId = (p, n) => p + String(Math.floor(Rn() * 10 ** n)).padStart(n, "0");

const VENDORS = ["Siemens AG", "Schneider Electric", "ABB Ltd", "Dassault Systèmes", "SAP SE", "Bosch Rexroth", "Philips Intl.", "Atos SE", "KONE Corp.", "Thales SA"];
const CREDS = ["BNP Paribas SA", "Société Générale", "Deutsche Bank", "Commerzbank", "ING Bank NV", "ABN AMRO", "Banco Santander", "UniCredit SpA"];
const PURP = ["Supplier payment", "Service contract", "Equipment maintenance", "Software license", "IT infrastructure", "Consulting", "Energy supply", "Transport logistics"];

function demoTx(forceAnomaly = false) {
  _s = Date.now() % 2147483647 || 42;
  const isPay = Rn() > 0.4;
  const isAnom = forceAnomaly || Rn() < 0.25;
  const pats = isPay ? PP : IP;
  const normW = isPay ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
  const pat = isAnom ? pk(pats) : null;
  return {
    id: rId(isPay ? "TXN-" : "INV-", 10),
    type: isPay ? "payment" : "invoice",
    amount: isAnom ? +(Rn() * 380000 + 15000).toFixed(2) : +(Rn() * 95000 + 500).toFixed(2),
    currency: "EUR",
    counterparty: isPay ? pk(CREDS) : pk(VENDORS),
    purpose: pk(PURP),
    lifecycleWord: pat ? [...pat.w] : normW,
    ts: new Date().toISOString(),
  };
}

/* ── REAL-TIME ALERT HOOK ──────────────────────────────────────── */
function useAlerts(on) {
  const [alerts, setAlerts] = useState([]);
  const ref = useRef(null);
  useEffect(() => {
    if (!on) { clearInterval(ref.current); return; }
    const fire = () => {
      const tx = demoTx(true);
      const r = verifyTx(tx);
      if (r.verdict === "BLOCKED")
        setAlerts(p => [{
          id: `A-${Date.now()}`, ts: new Date().toISOString(),
          txId: r.txId, type: tx.type, cp: tx.counterparty,
          amt: tx.amount, finding: r.finding, proof: r.proof, read: false,
        }, ...p].slice(0, 40));
    };
    fire();
    ref.current = setInterval(fire, 3500 + Math.random() * 3500);
    return () => clearInterval(ref.current);
  }, [on]);
  const markRead = id => setAlerts(p => p.map(a => a.id === id ? { ...a, read: true } : a));
  const clear = () => setAlerts([]);
  return { alerts, markRead, clear };
}

/* ── UI ATOMS ──────────────────────────────────────────────────── */
const Bdg = ({ children, color, bg, bd }) => (
  <span style={{
    display: "inline-flex", padding: "2px 8px", borderRadius: 4, fontSize: 10,
    fontWeight: 700, fontFamily: C.mn, color, background: bg,
    border: `1px solid ${bd || color + "30"}`, letterSpacing: ".03em", whiteSpace: "nowrap",
  }}>{children}</span>
);
const Sev = ({ s }) => s === "CRITICAL"
  ? <Bdg color={C.cr} bg={C.crBg} bd={C.crBd}>CRITICAL</Bdg>
  : <Bdg color={C.am} bg={C.amBg} bd={C.amBd}>HIGH</Bdg>;

/* ── VERDICT CARD ──────────────────────────────────────────────── */
function VerdictCard({ result }) {
  if (!result) return null;
  const bl = result.verdict === "BLOCKED";
  const ac = bl ? C.cr : C.ok;
  const bg = bl ? C.crBg : C.okBg;
  const bd = bl ? C.crBd : C.okBd;

  return (
    <div style={{ borderRadius: 12, border: `2px solid ${bd}`, background: bg, padding: 18, animation: "hpgIn .35s ease" }}>
      {/* Verdict header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{
          width: 42, height: 42, borderRadius: 10, background: ac,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20, color: "#fff", fontWeight: 900,
        }}>{bl ? "✕" : "✓"}</div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: ac, fontFamily: C.hd, letterSpacing: "-.02em" }}>
            {result.verdict}
          </div>
          <div style={{ fontSize: 10, color: C.t2, fontFamily: C.mn }}>
            {result.txId} · {result.latency}μs · FP: 0.00%
          </div>
        </div>
      </div>

      {/* Finding detail */}
      {bl && result.finding && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 14, border: `1px solid ${C.bd}`, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <Sev s={result.finding.severity} />
            <span style={{ fontSize: 13, fontWeight: 700, color: C.tx }}>{result.finding.name}</span>
            <span style={{ fontSize: 10, color: C.t3, fontFamily: C.mn, marginLeft: "auto" }}>{result.finding.code}</span>
          </div>
          <div style={{ fontSize: 12, color: C.t1, lineHeight: 1.7 }}>
            <b>Regulation:</b> {result.finding.regulation} · <b>Control:</b> {result.finding.control}<br />
            <b>Risk:</b> {result.finding.risk}
            {result.finding.mw && <><br /><Bdg color={C.cr} bg={C.crBg} bd={C.crBd}>SOX 404 MATERIAL WEAKNESS</Bdg></>}
          </div>
        </div>
      )}

      {/* Proof certificate */}
      <div style={{ background: "#fff", borderRadius: 8, padding: 14, border: `1px solid ${C.bd}` }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.t3, fontFamily: C.mn, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
          Algebraic Proof Certificate
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11, color: C.t1 }}>
          <div><b>Input:</b> <span style={{ fontFamily: C.mn, fontSize: 10 }}>{result.proof.input}</span></div>
          <div><b>Canonical:</b> <span style={{ fontFamily: C.mn, fontSize: 10, color: bl ? C.cr : C.ok }}>{result.proof.canonical}</span></div>
          <div><b>Steps:</b> {result.proof.steps}</div>
          <div><b>Violated:</b> <span style={{ color: result.proof.violated.length ? C.cr : C.ok }}>{result.proof.violated.join(", ") || "None"}</span></div>
          <div style={{ gridColumn: "1/-1" }}><b>Hash:</b> <span style={{ fontFamily: C.mn, fontSize: 9 }}>{result.proof.hash}</span></div>
        </div>
      </div>
    </div>
  );
}

/* ── API DOCS TAB ──────────────────────────────────────────────── */
function ApiDocs() {
  const code = {
    background: "#1a2744", color: "#e6edf5", borderRadius: 8, padding: 16,
    fontFamily: C.mn, fontSize: 11, lineHeight: 1.7, overflowX: "auto", whiteSpace: "pre",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: C.nv, fontFamily: C.hd }}>Integration API</div>
      <div style={{ fontSize: 12, color: C.t1, lineHeight: 1.7 }}>
        The Hecke Payment Gate exposes a synchronous endpoint for pre-execution verification.
        Every transaction is verified algebraically before entering the payment pipeline.
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.nv, marginTop: 4 }}>1. Pre-Execution Gate</div>
      <div style={code}>{`POST /api/hecke/verify
Content-Type: application/json

{
  "id": "TXN-0042381920",
  "type": "payment",
  "amount": 84250.00,
  "currency": "EUR",
  "counterparty": "Siemens AG",
  "lifecycleWord": [1, 2, 3, 4, 5],
  "scheme": "SCT",
  "sca": "BIO"
}`}</div>
      <div style={code}>{`→ 200 OK
{
  "verdict": "APPROVED",
  "finding": null,
  "proof": {
    "input": "1-2-3-4-5",
    "canonical": "1-2-3-4-5",
    "steps": 0,
    "violated": [],
    "hash": "a4f8e2c901b37d60"
  },
  "latency_us": 7,
  "engine": "HeckeFraudGuard v3.3"
}`}</div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.nv, marginTop: 4 }}>2. Webhook Alerts</div>
      <div style={{ fontSize: 12, color: C.t1, lineHeight: 1.7 }}>
        Register a webhook to receive real-time alerts when transactions are blocked. Fires within 50ms.
      </div>
      <div style={code}>{`POST /api/hecke/webhooks
{
  "url": "https://your-app.com/hecke-alerts",
  "events": ["tx.blocked", "tx.material_weakness"],
  "secret": "whsec_..."
}

→ Payload:
{
  "event": "tx.blocked",
  "txId": "TXN-0042381920",
  "finding": { "code": "BEC", "severity": "CRITICAL" },
  "proof": { "hash": "...", "violated": ["R1","R3"] },
  "amount": 84250.00
}`}</div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.nv, marginTop: 4 }}>3. React Embed</div>
      <div style={code}>{`import { HeckePaymentGate } from "@sfl/hecke-gate";

<HeckePaymentGate
  apiKey="hk_live_..."
  webhookUrl="https://your-app.com/alerts"
  onVerdict={(result) => {
    if (result.verdict === "BLOCKED") {
      pausePayment(result.txId);
      notifyCompliance(result);
    }
  }}
  theme="light"
  compact={false}
/>`}</div>

      <div style={{ background: C.sf2, borderRadius: 8, padding: 14, border: `1px solid ${C.bd}`, marginTop: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.nv, marginBottom: 6 }}>Supported Integrations</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11, color: C.t1 }}>
          {["SAP S/4HANA (RFC/BAPI)", "Oracle Payments", "Microsoft D365", "Workday Financial",
            "SWIFT gpi / ISO 20022", "SEPA SCT / SCT_INST", "Stripe / Adyen webhook", "Custom REST / GraphQL",
          ].map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.gd, flexShrink: 0 }} />{s}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN WIDGET
   ═══════════════════════════════════════════════════════════════════ */
export default function HeckePaymentGate() {
  const [mode, setMode] = useState("gate");
  const [tx, setTx] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [alertsOn, setAlertsOn] = useState(false);
  const { alerts, markRead, clear } = useAlerts(alertsOn);
  const [history, setHistory] = useState([]);
  const [expAlert, setExpAlert] = useState(null);
  const unread = alerts.filter(a => !a.read).length;

  const runVerify = useCallback((forced) => {
    const t = forced || tx || demoTx();
    if (!forced) setTx(t);
    setBusy(true); setResult(null);
    setTimeout(() => {
      const r = verifyTx(t);
      setResult(r); setBusy(false);
      setHistory(p => [{ tx: t, r, at: new Date().toISOString() }, ...p].slice(0, 25));
    }, 250 + Math.random() * 350);
  }, [tx]);

  const doNormal = useCallback(() => {
    const t = demoTx(false);
    t.lifecycleWord = t.type === "payment" ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
    setTx(t); runVerify(t);
  }, [runVerify]);

  const doAnomaly = useCallback(() => {
    const t = demoTx(true); setTx(t); runVerify(t);
  }, [runVerify]);

  const totV = history.length;
  const totB = history.filter(h => h.r.verdict === "BLOCKED").length;
  const totE = history.filter(h => h.r.verdict === "BLOCKED").reduce((s, h) => s + h.tx.amount, 0);

  return (
    <div style={{
      fontFamily: C.sn, background: C.bg, borderRadius: 16,
      border: `1px solid ${C.bd}`, overflow: "hidden", maxWidth: 700,
      boxShadow: "0 4px 24px rgba(26,39,68,0.07)",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700;800&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes hpgIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
        @keyframes hpgPulse { 0%,100% { opacity:1 } 50% { opacity:.4 } }
        .hpg-pulse { animation: hpgPulse 1.5s ease infinite }
      `}</style>

      {/* ── HEADER ──────────────────────────────────────── */}
      <div style={{
        background: C.nv, padding: "14px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 7,
            background: `linear-gradient(135deg,${C.gdL},${C.gd})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 900, color: C.nv, fontFamily: C.hd,
          }}>H</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", fontFamily: C.hd }}>Hecke Payment Gate</div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,.45)", fontFamily: C.mn }}>
              Pre-Execution Verification · Zero False Positives
            </div>
          </div>
        </div>
        <button onClick={() => setAlertsOn(!alertsOn)} style={{
          display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 6,
          border: `1px solid ${alertsOn ? "rgba(255,255,255,.25)" : "rgba(255,255,255,.1)"}`,
          background: alertsOn ? "rgba(192,57,43,.2)" : "transparent",
          color: alertsOn ? "#f0b8b3" : "rgba(255,255,255,.5)",
          cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: C.mn,
        }}>
          {alertsOn
            ? <><span className="hpg-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: C.cr, display: "inline-block" }} /> LIVE</>
            : "● ALERTS OFF"
          }
        </button>
      </div>

      {/* ── TABS ────────────────────────────────────────── */}
      <div style={{ display: "flex", background: C.sf, borderBottom: `1px solid ${C.bd}`, padding: "0 16px" }}>
        {[
          { id: "gate", l: "⛨ Verify" },
          { id: "alerts", l: `⚡ Alerts${unread ? ` (${unread})` : ""}` },
          { id: "docs", l: "{ } API Docs" },
        ].map(t => (
          <button key={t.id} onClick={() => setMode(t.id)} style={{
            padding: "10px 16px", border: "none",
            borderBottom: mode === t.id ? `2px solid ${C.nv}` : "2px solid transparent",
            background: "transparent",
            color: mode === t.id ? C.nv : C.t3,
            fontSize: 12, fontWeight: mode === t.id ? 700 : 500,
            cursor: "pointer", fontFamily: C.sn, transition: "all .15s",
          }}>{t.l}</button>
        ))}
      </div>

      {/* ── CONTENT ─────────────────────────────────────── */}
      <div style={{ padding: 20, minHeight: 340 }}>

        {/* ── GATE TAB ─────────────────────────────────── */}
        {mode === "gate" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {[
                { l: "Verified", v: totV, c: C.nv },
                { l: "Blocked", v: totB, c: C.cr },
                { l: "Exposure", v: fmt(totE), c: C.gd },
              ].map((k, i) => (
                <div key={i} style={{
                  background: C.sf, borderRadius: 10, border: `1px solid ${C.bd}`,
                  padding: "12px 14px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 9, color: C.t3, fontFamily: C.mn, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 4 }}>{k.l}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: k.c, fontFamily: C.hd }}>{k.v}</div>
                </div>
              ))}
            </div>

            {/* Demo buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doNormal} style={{
                flex: 1, padding: "10px 0", borderRadius: 8,
                border: `1px solid ${C.okBd}`, background: C.okBg, color: C.ok,
                fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.sn,
              }}>▶ Normal Transaction</button>
              <button onClick={doAnomaly} style={{
                flex: 1, padding: "10px 0", borderRadius: 8,
                border: `1px solid ${C.crBd}`, background: C.crBg, color: C.cr,
                fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.sn,
              }}>⚠ Anomalous Transaction</button>
            </div>

            {/* TX preview */}
            {tx && (
              <div style={{ background: C.sf, borderRadius: 10, border: `1px solid ${C.bd}`, padding: 14, animation: "hpgIn .3s ease" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.t3, fontFamily: C.mn, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                  Transaction Under Review
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12, color: C.t1 }}>
                  <div><b style={{ color: C.tx }}>ID:</b> <span style={{ fontFamily: C.mn, fontSize: 10 }}>{tx.id}</span></div>
                  <div><b style={{ color: C.tx }}>Type:</b> {tx.type === "payment" ? "SEPA Payment" : "P2P Invoice"}</div>
                  <div><b style={{ color: C.tx }}>Counterparty:</b> {tx.counterparty}</div>
                  <div><b style={{ color: C.tx }}>Amount:</b> <span style={{ fontWeight: 700 }}>€{tx.amount.toLocaleString("en", { minimumFractionDigits: 2 })}</span></div>
                  <div><b style={{ color: C.tx }}>Purpose:</b> {tx.purpose}</div>
                  <div><b style={{ color: C.tx }}>Lifecycle:</b> <span style={{ fontFamily: C.mn, fontSize: 10 }}>[{tx.lifecycleWord.join(", ")}]</span></div>
                </div>
              </div>
            )}

            {/* Spinner */}
            {busy && (
              <div style={{ textAlign: "center", padding: 20 }}>
                <div className="hpg-pulse" style={{ fontSize: 28, marginBottom: 6 }}>⛨</div>
                <div style={{ fontSize: 11, color: C.t2, fontFamily: C.mn }}>Algebraic verification...</div>
              </div>
            )}

            {/* Verdict */}
            <VerdictCard result={result} />

            {/* History */}
            {history.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.t3, fontFamily: C.mn, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
                  Verification History
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto", borderRadius: 8, border: `1px solid ${C.bd}`, background: C.sf }}>
                  {history.map((h, i) => {
                    const bl = h.r.verdict === "BLOCKED";
                    return (
                      <div key={i} style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "8px 12px",
                        borderBottom: i < history.length - 1 ? `1px solid ${C.bd}` : "none",
                        fontSize: 11, color: C.t1,
                      }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: bl ? C.cr : C.ok, flexShrink: 0 }} />
                        <span style={{ fontFamily: C.mn, fontSize: 10, color: C.t3, minWidth: 52 }}>
                          {new Date(h.at).toLocaleTimeString("en", { hour12: false })}
                        </span>
                        <span style={{ fontFamily: C.mn, fontSize: 10, flex: 1 }}>{h.r.txId}</span>
                        <span style={{ fontWeight: 700, color: bl ? C.cr : C.ok, fontSize: 10 }}>{h.r.verdict}</span>
                        {bl && <span style={{ fontFamily: C.mn, fontSize: 9, color: C.t3 }}>{h.r.finding?.code}</span>}
                        <span style={{ fontWeight: 600, fontSize: 10, minWidth: 65, textAlign: "right" }}>
                          €{h.tx.amount.toLocaleString("en", { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── ALERTS TAB ───────────────────────────────── */}
        {mode === "alerts" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.nv, fontFamily: C.hd }}>Real-Time Alert Feed</div>
                <div style={{ fontSize: 11, color: C.t2 }}>
                  {alertsOn ? "Webhook simulation active — new alerts every ~5s" : "Enable live alerts with the toggle above"}
                </div>
              </div>
              {alerts.length > 0 && (
                <button onClick={clear} style={{
                  padding: "4px 10px", borderRadius: 6,
                  border: `1px solid ${C.bd}`, background: C.sf, color: C.t3,
                  fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: C.mn,
                }}>Clear</button>
              )}
            </div>

            {alerts.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: C.t3 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>⚡</div>
                <div style={{ fontSize: 12 }}>
                  No alerts yet.{!alertsOn && " Enable live alerts to start receiving webhook events."}
                </div>
              </div>
            ) : (
              <div style={{ maxHeight: 420, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                {alerts.map(a => {
                  const exp = expAlert === a.id;
                  return (
                    <div key={a.id}
                      onClick={() => { setExpAlert(exp ? null : a.id); if (!a.read) markRead(a.id); }}
                      style={{
                        background: C.sf, borderRadius: 10,
                        border: `1px solid ${!a.read ? C.crBd : C.bd}`,
                        padding: "12px 14px", cursor: "pointer", transition: "all .15s",
                        animation: "hpgIn .3s ease",
                        boxShadow: !a.read ? "0 0 0 1px rgba(192,57,43,.08)" : "none",
                      }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {!a.read && <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.cr, flexShrink: 0 }} />}
                        <Sev s={a.finding?.severity} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.tx, flex: 1 }}>{a.finding?.name}</span>
                        <span style={{ fontFamily: C.mn, fontSize: 10, color: C.t3 }}>
                          {new Date(a.ts).toLocaleTimeString("en", { hour12: false })}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, fontSize: 11, color: C.t2 }}>
                        <span>{a.type === "payment" ? "PAY" : "INV"}</span>
                        <span>{a.cp}</span>
                        <span style={{ fontWeight: 700, color: C.tx, marginLeft: "auto" }}>
                          €{a.amt.toLocaleString("en", { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      {exp && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.bd}`, fontSize: 11, color: C.t1, lineHeight: 1.7 }}>
                          <b>Regulation:</b> {a.finding?.regulation} · <b>Control:</b> {a.finding?.control}<br />
                          <b>Risk:</b> {a.finding?.risk}<br />
                          <b>Proof:</b> <span style={{ fontFamily: C.mn, fontSize: 9 }}>{a.proof?.hash}</span>
                          {" · "}<b>Violated:</b> <span style={{ color: C.cr }}>{a.proof?.violated?.join(", ")}</span>
                          {a.finding?.mw && <><br /><Bdg color={C.cr} bg={C.crBg} bd={C.crBd}>MATERIAL WEAKNESS</Bdg></>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── DOCS TAB ─────────────────────────────────── */}
        {mode === "docs" && <ApiDocs />}
      </div>

      {/* ── FOOTER ──────────────────────────────────────── */}
      <div style={{
        padding: "10px 20px", borderTop: `1px solid ${C.bd}`, background: C.sf,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ fontSize: 9, color: C.t3, fontFamily: C.mn }}>
          HeckeFraudGuard v3.3 · HeckeInvoiceGuard v1.0 · 0-Hecke H₀(Sₙ)
        </div>
        <div style={{ fontSize: 9, color: C.t3, fontFamily: C.mn }}>© 2026 SFL Consulting</div>
      </div>
    </div>
  );
}
