/**
 * Dates of birth arrive as "YYYY-MM-DD" (what a date picker gives) and are kept as a
 * plain date: no time, no time zone, so the same birthday compares equal everywhere.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** The date as UTC midnight, or null when it is not a real calendar date. */
export function parseDateOfBirth(value: string): Date | null {
  const m = DATE_PATTERN.exec(value.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  // 2001-02-30 rolls over to March; a real date comes back unchanged.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  if (y < 1900) return null
  return date
}

/** Whole years old on `now`. */
export function ageOn(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear()
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())
  if (beforeBirthday) age--
  return age
}

export function sameDate(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
}

/** Full names compare without regard to capitals or extra spaces. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Why a date of birth is refused at sign-up, or null when it is fine. */
export function dateOfBirthProblem(value: string, minAge: number, now: Date = new Date()): string | null {
  const dob = parseDateOfBirth(value)
  if (!dob) return 'Please enter a valid date of birth.'
  if (dob.getTime() > now.getTime()) return 'Date of birth cannot be in the future.'
  if (ageOn(dob, now) < minAge) return `You must be at least ${minAge} years old to create an account.`
  if (ageOn(dob, now) > 120) return 'Please enter a valid date of birth.'
  return null
}
