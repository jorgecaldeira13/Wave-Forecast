// Beach definitions. Everything the app knows about a spot starts here.
//
// Local frame used everywhere (physics grid, three.js world):
//   +X  cross-shore, pointing INLAND   (bearing seawardBearing + 180)
//   +Z  alongshore                      (bearing seawardBearing - 90)
//   +Y  up, metres above mean sea level
// The origin sits on the waterline in the middle of the beach.

export const BEACHES = {
  'praia-nova': {
    id: 'praia-nova',
    name: 'Praia Nova',
    region: 'Costa da Caparica, Portugal',
    lat: 38.6373,
    lon: -9.2356,
    // Compass bearing you face when you stand on the sand and look at the sea.
    seawardBearing: 238,
    // Size of the modelled patch, metres.
    domain: { offshore: 1100, inland: 400, alongshore: 1500 },
    grid: { nx: 512, nz: 512 },
    timezone: 'Europe/Lisbon',
    // Median sand grain ~0.3 mm -> Dean profile scale fitted to EMODnet depths.
    deanA: 0.085,
    // Corrections from comparing the model with the real beach. 1 = uncalibrated.
    //   height:     multiplies the forecast wave height before it reaches the beach
    //   breakIndex: multiplies the height-to-depth ratio at which waves break
    calibration: { height: 1, breakIndex: 1 },
    // Public webcam at this beach (not ours; opens on its own site).
    webcam: {
      url: 'https://beachcam.meo.pt/livecams/costa-da-caparica-praia-nova/',
      note: 'MEO Beachcam at Praia Nova itself',
    },
  },
};

export const DEFAULT_BEACH = 'praia-nova';

const EARTH_M_PER_DEG = 111320;

/** Local metres (x inland, z alongshore) -> { lat, lon }. */
export function localToLatLon(beach, x, z) {
  const bx = ((beach.seawardBearing + 180) * Math.PI) / 180;
  const bz = ((beach.seawardBearing - 90) * Math.PI) / 180;
  const east = x * Math.sin(bx) + z * Math.sin(bz);
  const north = x * Math.cos(bx) + z * Math.cos(bz);
  return {
    lat: beach.lat + north / EARTH_M_PER_DEG,
    lon: beach.lon + east / (EARTH_M_PER_DEG * Math.cos((beach.lat * Math.PI) / 180)),
  };
}

/** { lat, lon } -> local metres { x, z }. */
export function latLonToLocal(beach, lat, lon) {
  const north = (lat - beach.lat) * EARTH_M_PER_DEG;
  const east = (lon - beach.lon) * EARTH_M_PER_DEG * Math.cos((beach.lat * Math.PI) / 180);
  const bx = ((beach.seawardBearing + 180) * Math.PI) / 180;
  const bz = ((beach.seawardBearing - 90) * Math.PI) / 180;
  return {
    x: east * Math.sin(bx) + north * Math.cos(bx),
    z: east * Math.sin(bz) + north * Math.cos(bz),
  };
}

/** Web-mercator fractional tile coordinates. */
export function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
  };
}

export const SATELLITE_TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const SATELLITE_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';
