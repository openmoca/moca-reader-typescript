import { defaultSeverity, SEVERITY } from './codes.js';

/**
 * @typedef {object} Diagnostic
 * @property {string} code
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {string} [file] package-relative path
 * @property {number} [line] 1-based
 */

export class Diagnostics {
  /** @param {{ strict?: boolean }} [options] */
  constructor({ strict = false } = {}) {
    this.strict = strict;
    /** @type {Diagnostic[]} */
    this.items = [];
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {{ file?: string, line?: number }} [location]
   */
  add(code, message, location = {}) {
    let severity = defaultSeverity(code);
    if (this.strict && severity === SEVERITY.WARNING) severity = SEVERITY.ERROR;
    const entry = { code, severity, message };
    if (location.file !== undefined) entry.file = location.file;
    if (location.line !== undefined) entry.line = location.line;
    this.items.push(entry);
    return entry;
  }

  has(code) {
    return this.items.some((d) => d.code === code);
  }

  get hasErrors() {
    return this.items.some((d) => d.severity === SEVERITY.ERROR);
  }
}

/** @param {Diagnostic[]} items */
export function countBySeverity(items) {
  return items.reduce(
    (acc, d) => {
      acc[d.severity] = (acc[d.severity] ?? 0) + 1;
      return acc;
    },
    { error: 0, warning: 0, info: 0 },
  );
}
