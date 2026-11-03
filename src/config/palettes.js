// ===================================================================
// Palette config -- the day and night colours of the scene. Pure data,
// zero logic: a new city can override any subset of this (see
// CityConfig.palette) without touching engine or worker code.
// ===================================================================

// MT3D palette: desaturated grays/whites; color is reserved for
// information (water, transit, alerts), never scenery.
export const DEFAULT_PALETTES = {
  day: {
    building:   0xf5ebde,
    buildingHi: 0xfdfcfc,
    ground:     0xfbfaf9,
    roadMajor:  0x7a8ba3,
    rail:       0xa97456,
    water:      0x9ebdff,
    veg:        0xbbe0b8,
    landuse:    0xebe4e0,
    fog:        0xf7fbfd,
    sky:        0xf7fbfd,
    buildingOutline: 0x6b6257,
  },
  night: {
    building:   0x2b3038,
    buildingHi: 0x3c4350,
    ground:     0x0d1013,
    roadMajor:  0x3b434f,
    rail:       0xc98f6b,
    water:      0x16354d,
    veg:        0x27372d,
    landuse:    0x1f242b,
    fog:        0x060e19,
    sky:        0x060e19,
  },
};
