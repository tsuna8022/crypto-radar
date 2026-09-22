# Crypto Radar — Free PWA

A zero-server, read-only mobile dashboard for BTC/ETH long-term holders.

## What it does
- Reads Luno balances and Luno trade history with a **custom read-only API key**.
- Calculates a trade-derived BTC/ETH average cost and tracked P/L.
- Reads public BTC/ETH market data: price, 24h price move, open interest, OI change, funding and account long/short ratio.
- Reads public ETF flow when the public source is reachable (direct or a public CORS proxy fallback).
- Reads Bybit public liquidation WebSocket **only while the PWA is open**.
- Uses a deterministic rule engine; no AI API and no token cost.
- Stores the Luno key locally encrypted with PBKDF2 + AES-GCM using your PIN.
- Contains **no order, send, withdraw, or trading endpoint**.

## Important Luno permission setting
Create a **Custom** API key and enable only:
- View balance = 1
- View transactions = 2
- View orders = 32

Total mask = 35.
Do **not** enable Send, Create orders or Withdraw.

## Free iPhone use
A PWA must be served over HTTPS to install to the Home Screen. The files are static; there is no backend and no paid server requirement.

Free hosting choices include GitHub Pages or any other static HTTPS host. After deployment:
1. Open the HTTPS URL in Safari.
2. Share → Add to Home Screen.
3. Open Crypto Radar from the icon.

## Browser limitation to know
Luno private API uses HTTP Basic Authentication. If Luno does not permit browser CORS for authenticated requests, Safari will block direct Luno account access even though public market data continues to work. This is a browser/Luno restriction, not a billing issue. The PWA detects this and displays a clear message instead of exposing the key through a third-party proxy.

## Local test on a computer
```bash
python -m http.server 8080
```
Then open `http://localhost:8080`.

## Files
- `index.html` UI
- `app.js` APIs, cost basis, analysis and local encryption
- `styles.css` mobile-first UI
- `manifest.webmanifest` PWA metadata
- `sw.js` offline app-shell cache
