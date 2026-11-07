import type { Weekday, WeeklyHours } from "../db/schema.ts";

export interface BusinessHoursRule {
  timezone: string;
  weekly: WeeklyHours;
  holidays: string[]; // YYYY-MM-DD en hora local del mercado
}

const WEEKDAYS: Record<string, Weekday> = {
  Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
};

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

export function ruleFromRow(row: { zona_horaria: string; horario: WeeklyHours; festivos: string[] }): BusinessHoursRule {
  return { timezone: row.zona_horaria, weekly: row.horario, holidays: row.festivos };
}
