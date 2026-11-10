# Wave Forecast — see the surf in 3D

A surf forecast you **watch** instead of read. It rebuilds a real beach in 3D — seabed, sand,
groynes, satellite photo — and runs the live swell, wind and tide forecast across it, so you can
see how the waves will bend, stand up and break at that exact spot, hour by hour for the next week.

First beach: **Praia Nova, Costa da Caparica, Portugal**.

![Praia Nova in 3D](docs/screenshot.jpg)
![Line-up, beach at sunset, drone and map views](docs/views.jpg)
![On foot: standing on the sand at eye level](docs/on-foot.jpg)

## Run it

```bash
npm install
npm run dev      # then open the address it prints
```

Other commands: `npm run build` (static site in `dist/`, host it anywhere), `npm test`,
`npm run bake` (rebuild the beach terrain from open data).

### Live site

Every change merged into `main` is tested, built and published to GitHub Pages by
`.github/workflows/deploy.yml`. One-off setup: repository **Settings → Pages → Source: GitHub
Actions**. The site then lives at `https://<your-github-user>.github.io/Wave-Forecast/`.

No API keys are needed.

## Using it

- **Timeline** (bottom): drag to scrub through 7 days. Bars are breaking-wave height, coloured by
  surf rating; the white line is the tide; dark bands are night. `←` `→` step an hour, `space` plays.
- **Cameras**: Drone, Line-up (you bob on the swell next to a surfer), Beach (a person stands at
  the swash line for scale), Groyne, Map. Drag to orbit, scroll or pinch to zoom.
- **On foot**: you, 1.7 m tall, standing on the sand. Drag to look around, tap the sand or the sea
  to go there (or walk with `W A S D`). Wade in and the readout tells you how deep you are and how
  big the waves are against your body; past your depth you float and rise with each wave.
- **Wind: Auto / Hi-res / Google AI** picks the wind forecast (see below). The wind panel always
  shows both, the AI's uncertainty (±km/h), and flags hours where the two disagree.
- **Live cam ↗** opens the nearest public webcam on its own site, to compare with reality.
- **Waves ×1 / ×1.5 / ×2** exaggerates wave height so it reads from far away. ×1 is true scale.
- The scene is lit for the forecast hour: real sun position, cloud cover, sunsets over the sea.

### Experiment mode

Override the conditions from the address bar to see what a given swell would do here:

```
?swell=1.5,13,290     height m, period s, direction it comes from
&wind=15,60           speed km/h, direction it comes from
&tide=0.5             metres above mean sea level
&cloud=10             percent
&cam=lineup           drone | walk | lineup | beach | groyne | top
&windsrc=google       auto | local | google
&hour=2026-11-14T16:00Z   which forecast hour to open
&sample               use the saved forecast instead of the live one
&ui=0                 hide the panels (clean screenshots)
```

## How it works

```
 Satellite photo ─┐
 (Esri imagery)   ├─► scripts/bake-beach.mjs ─► public/data/<beach>/  (height map + masks)
 EMODnet seabed ──┘         one-off, offline

 Open-Meteo marine + weather ─► src/data/forecast.js ─► one sea state per hour
                                         │
                                         ▼
                       src/physics/nearshore.js   (runs in the browser, ~0.1 s per hour)
                         1. Snell refraction + directional spreading from the forecast
                            point to the edge of the patch (sheltered directions lose energy)
                         2. Eikonal travel-time solve over the real seabed → curved, slowing crests
                         3. Energy-flux conservation → shoaling, focusing on bars, groyne shadows
                         4. Depth-limited breaking → where each wave breaks, and how big
                                         │
                                         ▼
                       src/scene/*   three.js: the fields become data textures; a shader
                                     animates every crest, set, bore, foam trail and swash
```

**Terrain from satellite.** The bake script reads the satellite tiles pixel by pixel: sea is
flood-filled in from offshore, the waterline is traced, and rock that sticks out past the natural
beach line is recognised as a groyne (it found all three in the patch). Depths come from the
EMODnet survey grid. Close to shore, where no open survey resolves sandbars, a Dean equilibrium
beach profile is blended in and nudged by where the photo shows white water (foam marks shallow
bars).

**Waves.** Each wave train carries a travel-time field: a crest is simply a line of equal travel
time, so crests refract, slow and bunch up exactly as the seabed dictates. Waves arrive in sets;
bigger set waves break further out. The headline number is the breaking height in front of the
middle of the beach, with the breaker type from the Iribarren number.

**Rating.** `src/model/seaState.js → rate()` is a small, readable heuristic (size, period, wind
relative to the beach). Tune it to your taste.

## Data sources

| What | Source | Notes |
| --- | --- | --- |
| Swell, wind waves, tide, water temperature | [Open-Meteo Marine API](https://open-meteo.com/en/docs/marine-weather-api) | free, no key |
| Wind, air temperature, cloud | [Open-Meteo Weather API](https://open-meteo.com/) | free, no key |
| AI wind forecast | [Google WeatherNext 2 via Open-Meteo](https://open-meteo.com/en/docs/google-weathernext-api) | 64-member ensemble, 0.25°, free, no key |
| Seabed depth | [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) | ~115 m grid |
| Satellite imagery | Esri World Imagery | loaded live as map tiles, with attribution |

**Google's AI forecast.** WeatherNext 2 is Google DeepMind's AI weather model. It forecasts the
atmosphere (wind, temperature, pressure), not ocean waves, so here it drives the **wind**: the
rating, the chop on the water and the onshore/offshore call. It runs 64 possible futures; the app
uses their average and shows their spread as a confidence figure. It is a global model on a ~28 km
grid with 6-hourly steps, so it cannot see a local sea breeze. That is why *Auto* uses the
high-resolution regional model for the first two days and eases over to Google by day four, where
the AI's skill on the larger weather pattern matters more. Waves still come from physical wave
models (there is no public Google wave forecast).

**SwellCloud (api.swellcloud.net) — reviewed, not used.** It serves the same underlying wave
models Open-Meteo already gives us (GFS-Wave and Copernicus/CMEMS), with fewer variables (no swell
periods per partition, tide only for UK and Ireland), and it needs an API key that a browser-only
app would have to expose. It would be worth revisiting as a second opinion if this project gains a
small server.

**Webcams.** No Caparica webcam offers an open API, and their streams are not licensed for
automated capture, so the app links to the nearest one instead of ingesting it. With permission
from a camera owner, frames could be used to calibrate breaking height and re-map the sandbars.

**About Google and Starlink.** Starlink is an internet constellation; it has no imagery or terrain
API. Google's Photorealistic 3D Tiles do exist, but need a billed API key, and they model what is
above the water (buildings, dunes), not the seabed that shapes the waves. This version therefore
uses key-free sources. Google 3D Tiles would be a good optional layer for the town and dunes.

## Honest limits

- This is a physically based visualisation, not a calibrated spectral model such as SWAN. Expect
  the right behaviour and roughly the right size, not centimetre accuracy.
- Sandbars move every few weeks. The inner bars are an estimate from one satellite photo, so the
  exact position of peaks will drift from reality until the beach is re-baked from fresh imagery.
- Waves are a height field: they steepen, pitch forward and turn to white water, but there is no
  hollow tube.
- The forecast itself is only as good as the global wave model behind Open-Meteo.

## Adding a beach

1. Add an entry to `src/config/beaches.js` (coordinates, the compass bearing you face when looking
   at the sea, patch size).
2. `npm run bake -- <beach-id> --debug check.png` and look at `check.png`: yellow line = traced
   waterline, red = groynes, white = half-metre depth contours.
3. Open `/?beach=<beach-id>`.

## Ideas for next

- More Caparica peaks and a beach picker; then Ericeira, Peniche, Nazaré.
- Re-bake sandbars automatically from recent Sentinel-2 imagery.
- Google Photorealistic 3D Tiles for buildings and dunes (needs your API key).
- Wind-blown spray, a surfer riding the wave, rip-current arrows.
- Calibrate against a webcam (with the owner's permission) or a buoy.
- Show model agreement for waves too, by comparing ECMWF, Météo-France and GFS wave models.
