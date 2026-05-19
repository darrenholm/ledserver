import SunCalc from 'suncalc';

export interface SunEvents {
  sunrise: Date;
  sunset: Date;
}

/**
 * Sunrise and sunset for a given (lat, lng) on a given date (in UTC).
 * Returns Date objects in UTC; convert to a local zone at display time.
 */
export function sunEventsFor(latitude: number, longitude: number, date: Date = new Date()): SunEvents {
  const times = SunCalc.getTimes(date, latitude, longitude);
  return {
    sunrise: times.sunrise,
    sunset: times.sunset,
  };
}

/**
 * Given today's sunrise/sunset, an offset in minutes, and "now", decide whether
 * the device should currently be at day brightness or night brightness.
 *
 *   - offset > 0 means delay the transitions (e.g. +30 = stay bright 30 min past sunset)
 *   - offset < 0 means anticipate the transitions (e.g. -30 = start dimming 30 min before sunset)
 *
 * Returns 'day' if (now ≥ sunrise+offset) && (now < sunset+offset), else 'night'.
 */
export function isDayBrightness(
  sunrise: Date,
  sunset: Date,
  offsetMinutes: number,
  now: Date = new Date(),
): boolean {
  const offsetMs = offsetMinutes * 60 * 1000;
  const dayStart = sunrise.getTime() + offsetMs;
  const dayEnd = sunset.getTime() + offsetMs;
  const t = now.getTime();
  return t >= dayStart && t < dayEnd;
}
