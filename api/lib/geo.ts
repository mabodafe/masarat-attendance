// Direct port of server/lib/geo.js — unchanged maths.
// This decides whether an employee is inside the fence, so it is deliberately
// the simplest possible correct implementation.

const EARTH_R = 6_371_000; // metres
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two WGS-84 points. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a))));
}

export function isValidCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0) // null island: almost always a broken fix
  );
}
