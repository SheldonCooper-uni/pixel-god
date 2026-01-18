Pixel God Sandbox (Browser) – OffscreenCanvas + Worker

Starten:
1) In diesen Ordner wechseln.
2) Lokalen Server starten (wegen Worker):
   - Python:  python3 -m http.server 8000
   - Node:    npx serve .
3) Im Browser oeffnen:
   http://localhost:8000

Controls:
- Linke Maustaste: malen
- Shift halten: Linie
- V: Visualize (aus -> Heatmap -> Vektoren -> Tracer)
- 1..9: schnelle Materialwahl

Performance Tipps:
- simWorker.js: SIM_W/SIM_H in main.js hoch/runter. 1024x576 ist schon ordentlich.
- AIR_SCALE vergroessern (z.B. 6) fuer noch weniger Luftkosten.
- Wenn du MILLIONEN Zellen willst: WebGL-Rendering + WASM/SharedArrayBuffer lohnt sich.
