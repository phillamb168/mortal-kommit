# Replaceable fighter artwork

The renderer loads `/assets/claude.json`, `/assets/codex.json`, their PNGs, and `stage.png`. Artwork can be replaced without changing battle logic or rebuilding the app. Copy the complete bundled `assets` directory, replace your images/manifests, set `assetsDir` to that absolute directory, validate, and reload:

```sh
mortal-kommit assets validate /absolute/path/to/my-assets
mortal-kommit --demo
```

Each atlas is a transparent PNG with a JSON manifest describing exact image dimensions, frame rectangles, foot pivots relative to the frame, facing direction, and animation frame durations in milliseconds. Use PNG alpha, not a checkerboard painted into the image. The bundled atlases have 16 original cels in a 4×4 grid. Frames can be packed irregularly if the manifest is updated.

```json
{
  "version": 1,
  "name": "claude",
  "image": "claude.png",
  "width": 1024,
  "height": 1024,
  "facing": "right",
  "license": "MIT",
  "frames": [{ "x": 0, "y": 0, "w": 256, "h": 256, "pivotX": 128, "pivotY": 248 }],
  "animations": { "idle": { "frames": [0], "durations": [300], "loop": true } }
}
```

This abbreviated example illustrates the format; validation requires `idle`, `fatigue`, `attack`, `hit`, `block`, `parry`, `recoil`, `special`, `victory`, and `defeat`. The renderer also uses optional `kick`, `scouting`, and `finisher`. A finisher sequence supplies charge, contact, launch, and victory cels. Keep foot pivots aligned across cels and generous transparent gutters so weapon/hand motion does not bleed into adjacent cells. The current renderer mirrors the second fighter appropriately.

## Prompts for Grok Imagine or another image generator

Use a consistent character reference across generations. Request a single atlas or generate individual cels and assemble them with a sprite editor such as [Pixelorama](https://github.com/Orama-Interactive/Pixelorama), whose MIT-licensed editor can export sprite sheets. Generated sheets usually benefit from hand alignment and pivot adjustment.

**Claude fighter**

> Create an original arcade fighting-game sprite atlas, transparent background, 4 columns by 4 rows, equal square cells, full character entirely inside each cell with generous gutters. One consistent adult female martial artist, short auburn hair, ivory sleeveless jacket, amber sash, dark fitted trousers, amber armored gauntlets, confident expressive face. Strong silhouette, bold dark outlines, shaded hand-painted cel artwork, three-quarter side view facing right. Original design, no logos, no existing game character, no text. Fixed camera scale and foot baseline. Row 1: neutral guard, breathing guard rise, breathing guard fall, exhausted guard. Row 2: punch anticipation, extended straight punch, high roundhouse kick, recoil from impact. Row 3: crossed-arm block, sweeping parry, low stagger, rising energy uppercut. Row 4: energy charge, victory fist raised, composed victory salute, kneeling defeat. Keep costume, anatomy, colors, lighting, and proportions identical throughout. No backgrounds, no ground shadows, no labels or drawn grid.

**Codex fighter**

> Create an original arcade fighting-game sprite atlas, transparent background, 4 columns by 4 rows, equal square cells, full character entirely inside each cell with generous gutters. One consistent bulky cobalt robot technician, angular blue armor, cyan visor and illuminated joints, broad shoulders, industrial forearm guards, dark mechanical waist, heavy boots. Distinct readable silhouette, expressive body language, bold dark outlines, shaded hand-painted cel artwork, three-quarter side view facing right. Original design, no logos, no existing game character, no text. Fixed camera scale and foot baseline. Row 1: neutral guard, breathing guard rise, breathing guard fall, exhausted guard. Row 2: punch anticipation, extended straight punch, high roundhouse kick, recoil from impact. Row 3: crossed-arm block, sweeping parry, low stagger, rising energy uppercut. Row 4: energy charge, victory fist raised, composed victory salute, kneeling defeat. Keep armor plates, body construction, colors, lighting, and proportions identical throughout. No backgrounds, no ground shadows, no labels or drawn grid.

**Stage**

> Original widescreen arcade fighting stage, rain-soaked rooftop server temple at night. Huge circular amber-lit gateway in the center background, richly layered server racks and stone architecture, cables and lantern-like indicator lights, distant cyan futuristic city, moody indigo sky. Empty broad slate fighting floor across the lower third, level horizon, enough negative space for two large fighters at left and right. Hand-painted cel illustration, bold outlines, cinematic depth, warm amber against electric cyan, detailed but readable. No people, no characters, no logos, no text, no user interface. Landscape 3:2 or wider.

Update `docs/asset-licenses.md` when replacing art, including source, creator, license, and any attribution requirements. A game engine's code license does not automatically license its example characters or third-party art.

## Contact points and choreography

Frame records accept optional `contact: {x, y}` and `hurt: {x, y}` points in local cel coordinates. Put contact on the extended fist, palm, foot or blocking guard, and hurt on the receiving cel's face/upper body. These travel with the frame pivot, scale and facing direction. The renderer solves the approach positions from the two points, then places sparks and sound at their shared world position; it no longer relies on fixed lunge distances or unrelated screen coordinates. Replacement artwork without points uses a proportional fallback, but explicit points are recommended for accurate contact.

Both bundled manifests include calibrated points and a four-pose finisher sequence using the existing original cels. Finisher energy rings, thruster trails, launch/recoil, impact shapes and hit pauses are procedural Canvas effects. Their timing is deterministic in `src/web/choreography.ts`. No new bitmap generation is needed to change the move timing or replace the art.
