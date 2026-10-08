/**
 * CSV for the admin exports. Two things a spreadsheet needs that plain text does not:
 *  - a cell that starts with = + - or @ is run as a formula by Excel and Google Sheets, so a customer who types "=HYPERLINK(...)" as their name could make
 *    an export do something when an admin opens it. Those cells are prefixed with a quote so they stay text.
 *  - a byte-order mark first, so Excel reads the file as UTF-8 (names in Marathi or Hindi stay readable).
 */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // a plain negative number is a number, not a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(columns: string[], rows: unknown[][], note?: string): string {
  const lines = [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  if (note) lines.push('', cell(note));
  return `﻿${lines.join('\r\n')}\r\n`;
}
