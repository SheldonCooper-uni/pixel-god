# Pixel God — Sandbox (Prototype)

Pixel-basierte Falling-Sand/Ökosystem-Sandbox mit Wind/Druck-Feld, Pflanzenwachstum und einfachen Entities (Menschen/Vögel).

## Start (lokal)

Im Projektordner:

```bash
python3 -m http.server 8000
```

Dann im Browser öffnen:

`http://localhost:8000`

> Hinweis: OffscreenCanvas/Worker läuft zuverlässiger über HTTP/HTTPS als über `file://`.

## Controls

- Maus: malen/spawnen
- V: Visualize Wind (aus/Heatmap/Vektoren/Tracer)
- 1–9: Quick-Materials
- Shift: Linie (Linie wird beim Loslassen gesetzt)

## Tools

- Material: zeichnet Element
- Wind: malt Wind-Velocity (Angle-Slider oder Drag-Richtung)
- Druck: malt Pressure
- Temperatur: heiß/kalt (verbrennt/melt/freeze)
- Radierer: entfernt Zellen
- Mensch/Vogel: spawnt Entities (Sprites)

## Neu (Lebendigkeit)

- Subtiler "Ambient Wind" sorgt für leichte Bewegung auch ohne Input.
- Wasseroberflächen zeigen windgetriebene Wellen/Whitecaps (visual-only, sehr günstig).
- Menschen haben kleine Atem-Animation (Brustpixel + winzige Atemwolke).
