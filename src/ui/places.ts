/** Curated viewpoints. heading: compass direction the camera faces; pitch: degrees down from horizontal. */
export interface Place { name: string; sub?: string; lon: number; lat: number; distance: number; heading: number; pitch: number; y?: number }

export const PLACES: Place[] = [
  { name: 'Overview', sub: 'Lower Manhattan from the harbour', lon: -74.0105, lat: 40.7095, distance: 3600, heading: 20, pitch: 30 },
  { name: 'One World Trade Center', sub: 'Financial District', lon: -74.0134, lat: 40.7130, distance: 900, heading: 35, pitch: 18, y: 250 },
  { name: 'Wall Street & NYSE', sub: 'Financial District', lon: -74.0105, lat: 40.7066, distance: 420, heading: 300, pitch: 42 },
  { name: 'The Battery', sub: 'Southern tip', lon: -74.0160, lat: 40.7030, distance: 1300, heading: 15, pitch: 24 },
  { name: 'Brooklyn Bridge', sub: 'Manhattan approach', lon: -73.9985, lat: 40.7082, distance: 1100, heading: 250, pitch: 22 },
  { name: 'Three bridges', sub: 'Brooklyn, Manhattan & Williamsburg', lon: -73.9880, lat: 40.7090, distance: 2600, heading: 330, pitch: 24 },
  { name: 'South Street Seaport', sub: 'Pier 17', lon: -74.0025, lat: 40.7058, distance: 650, heading: 280, pitch: 30 },
  { name: 'City Hall', sub: 'Civic Center', lon: -74.0060, lat: 40.7128, distance: 600, heading: 200, pitch: 40 },
  { name: 'Tribeca', sub: 'Hudson Square edge', lon: -74.0090, lat: 40.7190, distance: 700, heading: 140, pitch: 38 },
  { name: 'SoHo', sub: 'Cast-iron district', lon: -74.0005, lat: 40.7235, distance: 650, heading: 200, pitch: 40 },
  { name: 'Chinatown', sub: 'Canal & Mott', lon: -73.9980, lat: 40.7160, distance: 650, heading: 215, pitch: 40 },
  { name: 'Lower East Side', sub: 'Delancey & Essex', lon: -73.9880, lat: 40.7180, distance: 900, heading: 230, pitch: 35 },
  { name: 'Battery Park City', sub: 'Hudson River esplanade', lon: -74.0165, lat: 40.7110, distance: 900, heading: 95, pitch: 28 },
  { name: 'Governors Island', sub: 'Looking back at the skyline', lon: -74.0150, lat: 40.6900, distance: 1600, heading: 10, pitch: 15 },
  { name: 'Statue of Liberty', sub: 'Liberty Island', lon: -74.0445, lat: 40.6892, distance: 700, heading: 60, pitch: 25 },
  { name: 'Skyline from Jersey City', sub: 'Exchange Place waterfront', lon: -74.0255, lat: 40.7130, distance: 1500, heading: 85, pitch: 9, y: 80 },
  { name: 'Exchange Place', sub: 'Jersey City towers', lon: -74.0335, lat: 40.7160, distance: 900, heading: 250, pitch: 28 },
  { name: 'Newport', sub: 'Jersey City', lon: -74.0340, lat: 40.7275, distance: 1000, heading: 240, pitch: 30 },
  { name: 'Liberty State Park', sub: 'Jersey City', lon: -74.0540, lat: 40.7040, distance: 1600, heading: 60, pitch: 26 },
  { name: 'Journal Square', sub: 'Jersey City', lon: -74.0630, lat: 40.7325, distance: 900, heading: 60, pitch: 35 },
];
