// Programmatic fixture media for the mock backend (no binary assets needed; works in static export).
const svg = (s: string) => 'data:image/svg+xml;utf8,' + encodeURIComponent(s.replace(/\n\s*/g, ' '));

export const challanPhoto = svg(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220">
  <defs>
    <radialGradient id="v" cx="50%" cy="45%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".55"/></radialGradient>
    <linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b4a36"/><stop offset="1" stop-color="#2f261c"/></linearGradient>
  </defs>
  <rect width="320" height="220" fill="url(#t)"/>
  <g transform="rotate(-4 160 110)">
    <rect x="46" y="18" width="232" height="188" fill="#f4eedf" stroke="#cbbf9f"/>
    <text x="60" y="40" font-family="Georgia" font-size="13" font-weight="bold" fill="#2a2a5a">DELIVERY CHALLAN</text>
    <text x="198" y="40" font-family="monospace" font-size="9" fill="#2a2a5a">No. DC-0417</text>
    <line x1="58" y1="47" x2="266" y2="47" stroke="#2a2a5a" stroke-width=".8"/>
    <text x="60" y="62" font-family="monospace" font-size="9" fill="#333">To: Example Customer Pvt Ltd</text>
    <text x="60" y="76" font-family="monospace" font-size="9" fill="#333">Ref:</text>
    <text x="86" y="77" font-family="cursive" font-size="13" fill="#1f3a8a">PO-184</text>
    <rect x="58" y="88" width="208" height="58" fill="none" stroke="#2a2a5a" stroke-width=".7"/>
    <line x1="58" y1="102" x2="266" y2="102" stroke="#2a2a5a" stroke-width=".7"/>
    <line x1="196" y1="88" x2="196" y2="146" stroke="#2a2a5a" stroke-width=".7"/>
    <text x="64" y="98" font-family="monospace" font-size="8" fill="#333">ITEM</text>
    <text x="202" y="98" font-family="monospace" font-size="8" fill="#333">QTY (boxes)</text>
    <text x="64" y="120" font-family="cursive" font-size="13" fill="#1f3a8a">Model X</text>
    <text x="212" y="122" font-family="cursive" font-size="18" fill="#1f3a8a">60</text>
    <path d="M70 180 q12 -16 22 0 t22 -4 t18 2" stroke="#1f3a8a" fill="none" stroke-width="1.4"/>
    <text x="60" y="196" font-family="monospace" font-size="7" fill="#666">Receiver's signature</text>
    <circle cx="236" cy="178" r="20" fill="none" stroke="#7a1f2b" stroke-width="1.6" opacity=".7"/>
    <text x="221" y="181" font-family="monospace" font-size="7" fill="#7a1f2b" opacity=".8">RECEIVED</text>
  </g>
  <rect width="320" height="220" fill="url(#v)"/>
</svg>`);

export function waveform(label = '0:07', seed = 7) {
  let bars = '';
  let s = seed;
  for (let i = 0; i < 46; i++) {
    s = (s * 9301 + 49297) % 233280;
    const h = 6 + (s / 233280) * 34 * Math.sin((i / 46) * Math.PI) + 4;
    bars += `<rect x="${58 + i * 5}" y="${55 - h / 2}" width="3" height="${h.toFixed(1)}" rx="1.5" fill="#E0303F" opacity="${(0.55 + (i % 3) * 0.15).toFixed(2)}"/>`;
  }
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="110" viewBox="0 0 320 110">
  <rect width="320" height="110" fill="#141821"/>
  <circle cx="32" cy="55" r="16" fill="#E0303F"/><path d="M27 46 L40 55 L27 64 Z" fill="#141821"/>
  ${bars}<text x="296" y="98" text-anchor="end" font-family="monospace" font-size="11" fill="#8A91A3">${label} · ogg/opus</text></svg>`);
}

export const poPdf = svg(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="#d9ccb0"/>
  <rect x="70" y="10" width="180" height="182" fill="#fff" stroke="#bbb"/>
  <text x="84" y="34" font-family="Georgia" font-size="12" font-weight="bold" fill="#111">PURCHASE ORDER</text>
  <text x="84" y="50" font-family="monospace" font-size="9" fill="#444">PO-184 · 02 Oct 2026</text>
  <text x="84" y="64" font-family="monospace" font-size="8" fill="#444">Example Customer Pvt Ltd</text>
  <line x1="84" y1="74" x2="236" y2="74" stroke="#999"/>
  <text x="84" y="90" font-family="monospace" font-size="8" fill="#222">Model X     100 x 1,000</text>
  <text x="84" y="104" font-family="monospace" font-size="8" fill="#222">Total       ₹1,00,000</text>
  <rect x="84" y="118" width="150" height="5" fill="#eee"/><rect x="84" y="130" width="120" height="5" fill="#eee"/>
  <rect x="84" y="142" width="138" height="5" fill="#eee"/>
  <text x="200" y="182" font-family="monospace" font-size="8" fill="#b7281f">PDF · 1p</text>
</svg>`);

export const bankStatement = svg(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" fill="#141821"/>
  ${[0, 1, 2, 3, 4].map((i) => `<rect x="14" y="${14 + i * 20}" width="292" height="14" fill="${i === 2 ? '#2a1a1e' : '#1b202b'}"/><text x="20" y="${24 + i * 20}" font-family="monospace" font-size="8" fill="#8A91A3">0${i + 3}-10 NEFT CR ${['KAVERI AGRO', 'SHARMA POLY', 'NO MATCH PO-184', 'DECCAN FAST', 'NIZAM STEEL'][i]}</text>`).join('')}
</svg>`);

/** Pseudo QR (visual only) with finder patterns; changes with seed so rotating QRs look real. */
export function fakeQr(seed: number) {
  const n = 29;
  const cell = 8;
  let s = seed * 7919 + 13;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let rects = '';
  const finder = (x: number, y: number) =>
    `<rect x="${x * cell}" y="${y * cell}" width="${7 * cell}" height="${7 * cell}" fill="#0B0D12"/>` +
    `<rect x="${(x + 1) * cell}" y="${(y + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#fff"/>` +
    `<rect x="${(x + 2) * cell}" y="${(y + 2) * cell}" width="${3 * cell}" height="${3 * cell}" fill="#0B0D12"/>`;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
      if (!inFinder && rnd() > 0.52) rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#0B0D12"/>`;
    }
  const size = n * cell;
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size + 32}" height="${size + 32}" viewBox="-16 -16 ${size + 32} ${size + 32}">
  <rect x="-16" y="-16" width="${size + 32}" height="${size + 32}" fill="#fff"/>${rects}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`);
}
