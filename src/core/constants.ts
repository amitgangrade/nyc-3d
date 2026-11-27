/** Vertical layout of ground layers (metres above water). Small gaps avoid z-fighting. */
export const Y = {
  water: 0,
  land: 1.0,
  plazas: 1.03,
  parks: 1.06,
  roads: 1.02,
  sidewalks: 1.16,
  paths: 1.09,
  inlandWater: 1.12,
  buildingBase: 1.0,
} as const;

/** Facade style codes shared by the geometry worker and the building shader. */
export const STYLE = { BRICK: 0, STONE: 1, CONCRETE: 2, GLASS: 3, PLAIN: 4 } as const;
