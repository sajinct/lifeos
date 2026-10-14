import { CalendarInput, CalendarSeries, CalendarEvent } from '../../core/models/domain';
import { recurrenceDate } from './finance';
import { supportedDate } from './habits';

export function wallParts(instant: string, timezone: string) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: string) => values.find((p) => p.type === type)!.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}:${part('second')}`,
  };
}
// Compare all offsets around the date; reject both gaps and folds, rather than
// silently moving the user's appointment when a country's clock changes.
export function calendarInstant(day: string, time: string, timezone: string) {
  if (!supportedDate(day) || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time))
    throw new Error('Choose a supported date and time.');
  time = time.length === 5 ? time + ':00' : time;
  const wall = Date.parse(`${day}T${time}Z`),
    offsets = new Set<number>();
  try {
    for (let h = -48; h <= 48; h += 6) {
      const sample = wall + h * 3600000,
        parts = wallParts(new Date(sample).toISOString(), timezone);
      offsets.add(Date.parse(`${parts.date}T${parts.time}Z`) - sample);
    }
  } catch {
    throw new Error('Choose a valid IANA time zone.');
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wall - offset).toISOString())
    .filter((instant) => {
      const p = wallParts(instant, timezone);
      return p.date === day && p.time === time;
    });
  if (candidates.length !== 1)
    throw new Error(
      'This local time is missing or ambiguous during a clock change; choose another time.',
    );
  return candidates[0];
}
export function calendarDates(input: CalendarInput) {
  if (
    !input.title.trim() ||
    input.title.trim().length > 200 ||
    input.location.length > 2000 ||
    !['daily', 'weekly', 'monthly', 'yearly'].includes(input.frequency) ||
    !Number.isInteger(input.count) ||
    input.count < 2 ||
    input.count > 120 ||
    !Number.isInteger(input.duration) ||
    input.duration < 1 ||
    input.duration > 10080 ||
    !['purple', 'green', 'orange', 'blue'].includes(input.color) ||
    !['private', 'workspace'].includes(input.visibility)
  )
    throw new Error('Enter valid event details and 2–120 occurrences.');
  return Array.from({ length: input.count }, (_, index) => {
    const date = recurrenceDate(input.date, input.frequency, index);
    const starts_at = calendarInstant(date, input.time, input.timezone);
    const ends_at = new Date(Date.parse(starts_at) + input.duration * 60000).toISOString();
    if (starts_at < '1900-01-01T00:00:00.000Z' || ends_at >= '2101-01-01T00:00:00.000Z')
      throw new Error('Repeat extends beyond the supported date range.');
    return { date, starts_at, ends_at, index };
  });
}
export function calendarSeriesInput(series: CalendarSeries, event: CalendarEvent): CalendarInput {
  const p = wallParts(event.starts_at, series.time_zone);
  return {
    title: event.title,
    date: p.date,
    time: p.time,
    duration: (Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60000,
    timezone: series.time_zone,
    frequency: series.frequency,
    count: series.occurrences,
    location: event.location,
    color: event.color,
    project: event.project_id ?? '',
    visibility: event.visibility,
  };
}
export function scheduledEvent(event: CalendarEvent) {
  return !event.event_state || event.event_state === 'scheduled';
}
