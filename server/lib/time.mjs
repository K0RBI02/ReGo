// Zeitwerkzeuge. Alles Fachliche läuft in Europe/Berlin.
export const TZ = 'Europe/Berlin';

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function split(ms) {
  const o = {};
  for (const p of parts.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** ms -> { date: '2026-10-10', time: '07:21' } in Berlin */
export function berlin(ms) {
  const p = split(ms);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** ISO oder ms -> "07:21" */
export function hhmm(v) {
  if (v == null) return '';
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(ms) ? '' : berlin(ms).time;
}

/** Berlin-Ortszeit ('2026-10-10', '07:15') -> ms (UTC) */
export function fromBerlin(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {            // Zeitzonenversatz nachziehen (Sommer-/Winterzeit)
    const p = split(guess);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return guess;
}

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export function weekday(ms) {
  const [y, m, d] = berlin(ms).date.split('-').map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "Mo 12.10." */
export function shortDate(ms) {
  const [, m, d] = berlin(ms).date.split('-');
  return `${weekday(ms)} ${d}.${m}.`;
}

export function minutesBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

export const toMin = (hhmmStr) => {
  const [h, m] = hhmmStr.split(':').map(Number);
  return h * 60 + m;
};
