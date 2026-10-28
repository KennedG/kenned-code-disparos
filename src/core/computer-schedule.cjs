'use strict';

// Campaign execution follows the Windows clock. Stored timezones remain data
// (for original offers/source dates), never an alternative execution clock.
function computerTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
}

function computerDateKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function computerClockStatus(timestamp = Date.now()) {
  return { at: timestamp, dateKey: computerDateKey(timestamp), timezone: computerTimezone(), timeZoneOffsetMinutes: new Date(timestamp).getTimezoneOffset() };
}

function localSchedule(schedule = {}) {
  const { timezone: ignored, ...value } = schedule;
  return value;
}

function minuteValue(value, fallback = 0) {
  if (value === undefined || value === '') return fallback;
  const m = /^(\d{2}):(\d{2})$/.exec(String(value));
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : NaN;
}

// Return the first real slot, never a backlog. Each allowed window establishes
// its own grid (08:00, 08:10, ...), including windows crossing midnight.
function nextComputerRoundSlot(timestamp, schedule = {}, intervalMinutes = 10, { strictlyFuture = false, anchorAt = null } = {}) {
  const days = schedule.days ?? [0, 1, 2, 3, 4, 5, 6];
  const start = minuteValue(schedule.startTime), end = minuteValue(schedule.endTime);
  const intervalMs = Number(intervalMinutes) * 60000;
  if (!days.length || !Number.isFinite(timestamp) || !Number.isFinite(start) || !Number.isFinite(end) || !(intervalMs > 0)) return Infinity;
  const cursor = new Date(timestamp);
  cursor.setHours(0, 0, 0, 0);
  if (schedule.startDate && computerDateKey(cursor) < schedule.startDate) {
    const [y, m, d] = schedule.startDate.split('-').map(Number);
    cursor.setFullYear(y, m - 1, d);
  }
  cursor.setDate(cursor.getDate() - 1);
  for (let index = 0; index < 11; index++, cursor.setDate(cursor.getDate() + 1)) {
    const date = computerDateKey(cursor);
    if (schedule.endDate && date > schedule.endDate) break;
    if (!days.includes(cursor.getDay()) || schedule.startDate && date < schedule.startDate) continue;
    const opens = new Date(cursor), closes = new Date(cursor);
    opens.setHours(Math.floor(start / 60), start % 60, 0, 0);
    closes.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (end <= start) closes.setDate(closes.getDate() + 1);
    const base = Number.isFinite(anchorAt) ? anchorAt : opens.getTime();
    const earliest = Math.max(timestamp, opens.getTime(), base);
    const offset = Math.max(0, Math.ceil((earliest - base) / intervalMs));
    let slot = base + offset * intervalMs;
    if (strictlyFuture && slot <= timestamp) slot += intervalMs;
    if (slot >= timestamp && slot >= opens.getTime() && slot < closes.getTime()) return slot;
  }
  return Infinity;
}

module.exports = { computerTimezone, computerDateKey, computerClockStatus, localSchedule, nextComputerRoundSlot };
