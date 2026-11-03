// ===================================================================
// layer-labels.js -- the plain-language name of each optional layer,
// shared by every screen that lists them (the upload wizard, the
// Review & build page, the viewer's "What's on this map" panel), so a
// layer is never "Vegetation" on one page and "Parks & trees" on the
// next.
// ===================================================================
import { LAYER_ROLES } from './city-schema.js';

export const ROLE_LABELS = {
  [LAYER_ROLES.ROADS]: 'Roads',
  [LAYER_ROLES.RAILWAY]: 'Railways',
  [LAYER_ROLES.AMENITIES]: 'Stations & amenities',
  [LAYER_ROLES.LOCALITIES]: 'Neighbourhood names',
  [LAYER_ROLES.LANDUSE]: 'Land use',
  [LAYER_ROLES.VEGETATION]: 'Parks & trees',
  [LAYER_ROLES.WATER]: 'Water',
  [LAYER_ROLES.CITY_BOUNDARY]: 'City outline',
  [LAYER_ROLES.ADMIN_WARDS]: 'Wards',
  [LAYER_ROLES.ADMIN_ZONES]: 'Zones',
  [LAYER_ROLES.LANDMARKS]: 'Landmarks',
};

/** The roles every build downloads from OpenStreetMap (server/lib/osmSplitter.js's OSM_ROLES). */
export const OSM_ROLES = [LAYER_ROLES.ROADS, LAYER_ROLES.RAILWAY, LAYER_ROLES.AMENITIES, LAYER_ROLES.LOCALITIES, LAYER_ROLES.LANDUSE, LAYER_ROLES.VEGETATION, LAYER_ROLES.WATER];

/** The municipal layers OpenStreetMap doesn't reliably have -- only there if the uploader supplied them. */
export const MUNICIPAL_ROLES = [LAYER_ROLES.CITY_BOUNDARY, LAYER_ROLES.ADMIN_WARDS, LAYER_ROLES.ADMIN_ZONES, LAYER_ROLES.LANDMARKS];
