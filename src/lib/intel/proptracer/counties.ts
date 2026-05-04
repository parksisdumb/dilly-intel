import type { TennesseeCounty } from './types'

// All 95 Tennessee counties with approximate bounding boxes.
// Boxes are slightly over-sized to ensure full coverage; the quadtree
// handles border overlap via external_id dedup on upsert.

// Test subset for validating pipeline without a full 2-hour run.
// Covers the 4 major metros plus rural Pickett for terminal-case verification.
export const TENNESSEE_TEST_COUNTIES_NAMES = new Set([
  'Shelby',     // Memphis — densest
  'Davidson',   // Nashville — densest
  'Knox',       // Knoxville
  'Hamilton',   // Chattanooga
  'Pickett',    // rural, <30 results
])

export function filterCountiesForScope(
  counties: TennesseeCounty[],
  scope: 'all' | 'test'
): TennesseeCounty[] {
  if (scope === 'test') {
    return counties.filter(c => TENNESSEE_TEST_COUNTIES_NAMES.has(c.name))
  }
  return counties
}

export const TENNESSEE_COUNTIES: TennesseeCounty[] = [
  { name: 'Anderson', fips: '47001', minLat: 35.93, maxLat: 36.33, minLon: -84.35, maxLon: -84.00 },
  { name: 'Bedford', fips: '47003', minLat: 35.39, maxLat: 35.72, minLon: -86.64, maxLon: -86.25 },
  { name: 'Benton', fips: '47005', minLat: 35.94, maxLat: 36.28, minLon: -88.28, maxLon: -87.85 },
  { name: 'Bledsoe', fips: '47007', minLat: 35.48, maxLat: 35.84, minLon: -85.33, maxLon: -84.90 },
  { name: 'Blount', fips: '47009', minLat: 35.45, maxLat: 35.93, minLon: -84.20, maxLon: -83.60 },
  { name: 'Bradley', fips: '47011', minLat: 35.01, maxLat: 35.37, minLon: -84.98, maxLon: -84.65 },
  { name: 'Campbell', fips: '47013', minLat: 36.18, maxLat: 36.61, minLon: -84.34, maxLon: -83.89 },
  { name: 'Cannon', fips: '47015', minLat: 35.72, maxLat: 36.02, minLon: -86.28, maxLon: -85.92 },
  { name: 'Carroll', fips: '47017', minLat: 35.85, maxLat: 36.14, minLon: -88.70, maxLon: -88.26 },
  { name: 'Carter', fips: '47019', minLat: 36.08, maxLat: 36.44, minLon: -82.35, maxLon: -81.72 },
  { name: 'Cheatham', fips: '47021', minLat: 36.11, maxLat: 36.42, minLon: -87.22, maxLon: -86.83 },
  { name: 'Chester', fips: '47023', minLat: 35.27, maxLat: 35.55, minLon: -88.78, maxLon: -88.43 },
  { name: 'Claiborne', fips: '47025', minLat: 36.40, maxLat: 36.67, minLon: -83.85, maxLon: -83.36 },
  { name: 'Clay', fips: '47027', minLat: 36.52, maxLat: 36.68, minLon: -85.95, maxLon: -85.39 },
  { name: 'Cocke', fips: '47029', minLat: 35.76, maxLat: 36.09, minLon: -83.29, maxLon: -82.82 },
  { name: 'Coffee', fips: '47031', minLat: 35.24, maxLat: 35.67, minLon: -86.45, maxLon: -86.00 },
  { name: 'Crockett', fips: '47033', minLat: 35.69, maxLat: 35.97, minLon: -89.33, maxLon: -88.95 },
  { name: 'Cumberland', fips: '47035', minLat: 35.79, maxLat: 36.22, minLon: -85.22, maxLon: -84.59 },
  { name: 'Davidson', fips: '47037', minLat: 35.97, maxLat: 36.40, minLon: -87.05, maxLon: -86.52 },
  { name: 'Decatur', fips: '47039', minLat: 35.37, maxLat: 35.74, minLon: -88.24, maxLon: -87.89 },
  { name: 'DeKalb', fips: '47041', minLat: 35.89, maxLat: 36.27, minLon: -86.04, maxLon: -85.55 },
  { name: 'Dickson', fips: '47043', minLat: 35.98, maxLat: 36.39, minLon: -87.65, maxLon: -87.18 },
  { name: 'Dyer', fips: '47045', minLat: 35.91, maxLat: 36.29, minLon: -89.65, maxLon: -89.19 },
  { name: 'Fayette', fips: '47047', minLat: 34.99, maxLat: 35.29, minLon: -89.82, maxLon: -89.21 },
  { name: 'Fentress', fips: '47049', minLat: 36.17, maxLat: 36.60, minLon: -85.15, maxLon: -84.65 },
  { name: 'Franklin', fips: '47051', minLat: 34.99, maxLat: 35.45, minLon: -86.56, maxLon: -85.96 },
  { name: 'Gibson', fips: '47053', minLat: 35.80, maxLat: 36.22, minLon: -89.10, maxLon: -88.56 },
  { name: 'Giles', fips: '47055', minLat: 34.99, maxLat: 35.41, minLon: -87.24, maxLon: -86.64 },
  { name: 'Grainger', fips: '47057', minLat: 36.13, maxLat: 36.45, minLon: -83.78, maxLon: -83.33 },
  { name: 'Greene', fips: '47059', minLat: 35.95, maxLat: 36.32, minLon: -83.15, maxLon: -82.58 },
  { name: 'Grundy', fips: '47061', minLat: 35.20, maxLat: 35.55, minLon: -86.02, maxLon: -85.58 },
  { name: 'Hamblen', fips: '47063', minLat: 36.05, maxLat: 36.35, minLon: -83.45, maxLon: -83.07 },
  { name: 'Hamilton', fips: '47065', minLat: 34.98, maxLat: 35.35, minLon: -85.61, maxLon: -85.01 },
  { name: 'Hancock', fips: '47067', minLat: 36.45, maxLat: 36.66, minLon: -83.39, maxLon: -82.91 },
  { name: 'Hardeman', fips: '47069', minLat: 35.00, maxLat: 35.35, minLon: -89.19, maxLon: -88.66 },
  { name: 'Hardin', fips: '47071', minLat: 35.00, maxLat: 35.47, minLon: -88.36, maxLon: -87.90 },
  { name: 'Hawkins', fips: '47073', minLat: 36.31, maxLat: 36.67, minLon: -83.22, maxLon: -82.69 },
  { name: 'Haywood', fips: '47075', minLat: 35.40, maxLat: 35.75, minLon: -89.58, maxLon: -89.12 },
  { name: 'Henderson', fips: '47077', minLat: 35.38, maxLat: 35.70, minLon: -88.61, maxLon: -88.18 },
  { name: 'Henry', fips: '47079', minLat: 36.23, maxLat: 36.67, minLon: -88.57, maxLon: -88.07 },
  { name: 'Hickman', fips: '47081', minLat: 35.49, maxLat: 35.92, minLon: -87.70, maxLon: -87.24 },
  { name: 'Houston', fips: '47083', minLat: 36.12, maxLat: 36.44, minLon: -87.94, maxLon: -87.58 },
  { name: 'Humphreys', fips: '47085', minLat: 35.87, maxLat: 36.27, minLon: -87.91, maxLon: -87.44 },
  { name: 'Jackson', fips: '47087', minLat: 36.23, maxLat: 36.54, minLon: -86.03, maxLon: -85.51 },
  { name: 'Jefferson', fips: '47089', minLat: 35.91, maxLat: 36.24, minLon: -83.77, maxLon: -83.30 },
  { name: 'Johnson', fips: '47091', minLat: 36.40, maxLat: 36.60, minLon: -82.09, maxLon: -81.65 },
  { name: 'Knox', fips: '47093', minLat: 35.79, maxLat: 36.21, minLon: -84.26, maxLon: -83.69 },
  { name: 'Lake', fips: '47095', minLat: 36.21, maxLat: 36.50, minLon: -89.59, maxLon: -89.23 },
  { name: 'Lauderdale', fips: '47097', minLat: 35.57, maxLat: 35.94, minLon: -89.91, maxLon: -89.40 },
  { name: 'Lawrence', fips: '47099', minLat: 34.99, maxLat: 35.45, minLon: -87.68, maxLon: -87.17 },
  { name: 'Lewis', fips: '47101', minLat: 35.41, maxLat: 35.78, minLon: -87.75, maxLon: -87.32 },
  { name: 'Lincoln', fips: '47103', minLat: 34.99, maxLat: 35.35, minLon: -86.93, maxLon: -86.30 },
  { name: 'Loudon', fips: '47105', minLat: 35.58, maxLat: 35.91, minLon: -84.65, maxLon: -84.15 },
  { name: 'Macon', fips: '47111', minLat: 36.36, maxLat: 36.63, minLon: -86.20, maxLon: -85.77 },
  { name: 'Madison', fips: '47113', minLat: 35.44, maxLat: 35.79, minLon: -88.96, maxLon: -88.54 },
  { name: 'Marion', fips: '47115', minLat: 34.98, maxLat: 35.34, minLon: -85.93, maxLon: -85.37 },
  { name: 'Marshall', fips: '47117', minLat: 35.34, maxLat: 35.65, minLon: -87.07, maxLon: -86.57 },
  { name: 'Maury', fips: '47119', minLat: 35.44, maxLat: 35.86, minLon: -87.25, maxLon: -86.69 },
  { name: 'McMinn', fips: '47107', minLat: 35.25, maxLat: 35.62, minLon: -84.92, maxLon: -84.40 },
  { name: 'McNairy', fips: '47109', minLat: 34.99, maxLat: 35.36, minLon: -88.78, maxLon: -88.30 },
  { name: 'Meigs', fips: '47121', minLat: 35.38, maxLat: 35.74, minLon: -85.03, maxLon: -84.66 },
  { name: 'Monroe', fips: '47123', minLat: 35.22, maxLat: 35.66, minLon: -84.62, maxLon: -84.02 },
  { name: 'Montgomery', fips: '47125', minLat: 36.33, maxLat: 36.67, minLon: -87.57, maxLon: -87.06 },
  { name: 'Moore', fips: '47127', minLat: 35.18, maxLat: 35.43, minLon: -86.50, maxLon: -86.20 },
  { name: 'Morgan', fips: '47129', minLat: 35.90, maxLat: 36.32, minLon: -84.83, maxLon: -84.32 },
  { name: 'Obion', fips: '47131', minLat: 36.21, maxLat: 36.67, minLon: -89.45, maxLon: -88.85 },
  { name: 'Overton', fips: '47133', minLat: 36.15, maxLat: 36.52, minLon: -85.50, maxLon: -85.02 },
  { name: 'Perry', fips: '47135', minLat: 35.45, maxLat: 35.82, minLon: -87.98, maxLon: -87.58 },
  { name: 'Pickett', fips: '47137', minLat: 36.44, maxLat: 36.67, minLon: -85.25, maxLon: -84.81 },
  { name: 'Polk', fips: '47139', minLat: 34.98, maxLat: 35.38, minLon: -84.65, maxLon: -84.28 },
  { name: 'Putnam', fips: '47141', minLat: 36.00, maxLat: 36.35, minLon: -85.75, maxLon: -85.30 },
  { name: 'Rhea', fips: '47143', minLat: 35.35, maxLat: 35.77, minLon: -85.13, maxLon: -84.70 },
  { name: 'Roane', fips: '47145', minLat: 35.60, maxLat: 36.05, minLon: -84.87, maxLon: -84.35 },
  { name: 'Robertson', fips: '47147', minLat: 36.34, maxLat: 36.67, minLon: -87.22, maxLon: -86.60 },
  { name: 'Rutherford', fips: '47149', minLat: 35.67, maxLat: 36.06, minLon: -86.74, maxLon: -86.14 },
  { name: 'Scott', fips: '47151', minLat: 36.28, maxLat: 36.62, minLon: -84.72, maxLon: -84.26 },
  { name: 'Sequatchie', fips: '47153', minLat: 35.15, maxLat: 35.57, minLon: -85.60, maxLon: -85.29 },
  { name: 'Sevier', fips: '47155', minLat: 35.53, maxLat: 36.02, minLon: -83.87, maxLon: -83.32 },
  { name: 'Shelby', fips: '47157', minLat: 34.99, maxLat: 35.36, minLon: -90.31, maxLon: -89.73 },
  { name: 'Smith', fips: '47159', minLat: 36.05, maxLat: 36.39, minLon: -86.18, maxLon: -85.72 },
  { name: 'Stewart', fips: '47161', minLat: 36.31, maxLat: 36.67, minLon: -88.07, maxLon: -87.58 },
  { name: 'Sullivan', fips: '47163', minLat: 36.36, maxLat: 36.67, minLon: -82.63, maxLon: -82.00 },
  { name: 'Sumner', fips: '47165', minLat: 36.28, maxLat: 36.67, minLon: -86.67, maxLon: -86.15 },
  { name: 'Tipton', fips: '47167', minLat: 35.32, maxLat: 35.67, minLon: -90.08, maxLon: -89.56 },
  { name: 'Trousdale', fips: '47169', minLat: 36.32, maxLat: 36.52, minLon: -86.32, maxLon: -85.99 },
  { name: 'Unicoi', fips: '47171', minLat: 35.95, maxLat: 36.24, minLon: -82.56, maxLon: -82.16 },
  { name: 'Union', fips: '47173', minLat: 36.14, maxLat: 36.42, minLon: -83.93, maxLon: -83.61 },
  { name: 'Van Buren', fips: '47175', minLat: 35.52, maxLat: 35.85, minLon: -85.52, maxLon: -85.22 },
  { name: 'Warren', fips: '47177', minLat: 35.52, maxLat: 35.87, minLon: -85.93, maxLon: -85.48 },
  { name: 'Washington', fips: '47179', minLat: 36.14, maxLat: 36.44, minLon: -82.67, maxLon: -82.25 },
  { name: 'Wayne', fips: '47181', minLat: 34.99, maxLat: 35.43, minLon: -88.00, maxLon: -87.48 },
  { name: 'Weakley', fips: '47183', minLat: 36.19, maxLat: 36.58, minLon: -88.87, maxLon: -88.41 },
  { name: 'White', fips: '47185', minLat: 35.78, maxLat: 36.18, minLon: -85.58, maxLon: -85.16 },
  { name: 'Williamson', fips: '47187', minLat: 35.60, maxLat: 36.05, minLon: -87.18, maxLon: -86.62 },
  { name: 'Wilson', fips: '47189', minLat: 35.85, maxLat: 36.33, minLon: -86.57, maxLon: -86.03 },
]
