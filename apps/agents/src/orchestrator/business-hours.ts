import type { Weekday, WeeklyHours } from "../db/schema.ts";

export interface BusinessHoursRule {
  timezone: string;
  weekly: WeeklyHours;
  holidays: string[]; // YYYY-MM-DD en hora local del mercado
}

const WEEKDAYS: Record<string, Weekday> = {
  Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
};

export class InvalidBusinessHoursError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidBusinessHoursError"; }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEYS = new Set<string>(Object.values(WEEKDAYS));

export function parseWeeklyHours(input: unknown): WeeklyHours {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidBusinessHoursError("horario: se espera un objeto");
  const out: WeeklyHours = {};
  for (const [day, ranges] of Object.entries(input as Record<string, unknown>)) {
    if (!DAY_KEYS.has(day)) throw new InvalidBusinessHoursError(`horario: día desconocido ${day}`);
    if (!Array.isArray(ranges)) throw new InvalidBusinessHoursError(`horario.${day}: se espera una lista de rangos`);
    out[day as Weekday] = ranges.map((r, i) => {
      if (!Array.isArray(r) || r.length !== 2 || !r.every((t) => typeof t === "string" && HHMM.test(t))) {
        throw new InvalidBusinessHoursError(`horario.${day}[${i}]: se espera ["HH:MM","HH:MM"]`);
      }
      const [open, close] = r as [string, string];
      if (open >= close) throw new InvalidBusinessHoursError(`horario.${day}[${i}]: apertura debe ser anterior al cierre`);
      return [open, close] as [string, string];
    });
  }
  return out;
}

export function assertTimeZone(tz: string): void {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch {
    throw new InvalidBusinessHoursError(`zona horaria inválida: ${tz}`);
  }
}

function localParts(at: Date, timeZone: string): { weekday: Weekday; date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAYS[get("weekday")],
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

export function isWithinBusinessHours(rule: BusinessHoursRule, at: Date): boolean {
  const { weekday, date, time } = localParts(at, rule.timezone);
  if (rule.holidays.includes(date)) return false;
  return (rule.weekly[weekday] ?? []).some(([open, close]) => time >= open && time < close);
}

export function ruleFromRow(row: { zona_horaria: string; horario: unknown; festivos: string[] }): BusinessHoursRule {
  assertTimeZone(row.zona_horaria);
  return { timezone: row.zona_horaria, weekly: parseWeeklyHours(row.horario), holidays: row.festivos };
}
