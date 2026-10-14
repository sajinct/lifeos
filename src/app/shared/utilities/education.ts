import {
  EducationStudent,
  EducationFee,
  EducationPayment,
  EducationStudentInput,
  EducationFeeInput,
  EducationPaymentInput,
} from '../../core/models/domain';
import { cents, csv } from './finance';
export function educationDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= '1900-01-01' &&
    value <= '2100-12-31' &&
    !Number.isNaN(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  );
}
function money(value: string) {
  const v = value.trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(v) || Number(v) <= 0 || Number(v) > 1000000000)
    throw new Error('Enter a positive amount up to 1,000,000,000 with at most two decimals.');
  return Number(v);
}
function text(value: string, max: number, required = false) {
  if (value.includes('\0') || value.length > max || (required && !value.trim()))
    throw new Error('Enter valid text within the field limits.');
}
export function validateStudent(input: EducationStudentInput) {
  const v = {
    ...input,
    name: input.name.trim(),
    institution: input.institution.trim(),
    class_name: input.class_name.trim(),
    academic_year: input.academic_year.trim(),
  };
  text(v.name, 200, true);
  text(v.institution, 200, true);
  text(v.class_name, 100, true);
  text(v.academic_year, 60, true);
  text(v.notes, 2000);
  if (!['private', 'workspace'].includes(v.visibility))
    throw new Error('Choose valid student sharing.');
  return v;
}
export function validateFee(input: EducationFeeInput) {
  const v = { ...input, title: input.title.trim(), currency: input.currency.trim().toUpperCase() };
  text(v.title, 200, true);
  text(v.notes, 2000);
  if (!educationDate(v.due_on) || !/^[A-Z]{3}$/.test(v.currency))
    throw new Error('Enter a valid due date and three-letter currency.');
  return { ...v, amount: money(v.amount) };
}
export function validatePayment(input: EducationPaymentInput, today: string) {
  text(input.reference, 120);
  text(input.notes, 2000);
  if (!educationDate(input.paid_on) || input.paid_on > today)
    throw new Error('Payment date must be today or earlier.');
  return { ...input, amount: money(input.amount) };
}
export function feeBalance(fee: EducationFee, payments: EducationPayment[]) {
  const paid = payments
    .filter((p) => p.fee_id === fee.id && p.workspace_id === fee.workspace_id && !p.voided)
    .reduce((n, p) => n + cents(p.amount), 0);
  return { paid: paid / 100, remaining: Math.max(0, cents(fee.amount) - paid) / 100 };
}
export function educationTotals(fees: EducationFee[], payments: EducationPayment[], today: string) {
  const groups = new Map<
    string,
    { currency: string; amount: number; paid: number; remaining: number; overdue: number }
  >();
  for (const f of fees.filter((f) => !f.archived)) {
    const b = feeBalance(f, payments),
      g = groups.get(f.currency) ?? {
        currency: f.currency,
        amount: 0,
        paid: 0,
        remaining: 0,
        overdue: 0,
      };
    g.amount += cents(f.amount);
    g.paid += cents(b.paid);
    g.remaining += cents(b.remaining);
    if (f.due_on < today) g.overdue += cents(b.remaining);
    groups.set(f.currency, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((g) => ({
      currency: g.currency,
      amount: g.amount / 100,
      paid: g.paid / 100,
      remaining: g.remaining / 100,
      overdue: g.overdue / 100,
    }));
}
export function educationCsv(
  students: EducationStudent[],
  fees: EducationFee[],
  payments: EducationPayment[],
) {
  return csv(
    fees
      .filter((f) =>
        students.some((s) => s.id === f.student_id && s.workspace_id === f.workspace_id),
      )
      .map((f) => {
        const s = students.find((s) => s.id === f.student_id)!,
          b = feeBalance(f, payments);
        return {
          student: s.name,
          institution: s.institution,
          class: s.class_name,
          academic_year: s.academic_year,
          sharing: s.visibility,
          student_archived: s.archived,
          fee: f.title,
          due_on: f.due_on,
          currency: f.currency,
          scheduled: f.amount,
          paid: b.paid,
          outstanding: b.remaining,
          fee_archived: f.archived,
          notes: f.notes,
        };
      }),
  );
}
export function educationPaymentsCsv(fees: EducationFee[], payments: EducationPayment[]) {
  return csv(
    payments
      .filter((p) => fees.some((f) => f.id === p.fee_id && f.workspace_id === p.workspace_id))
      .map((p) => ({
        fee: fees.find((f) => f.id === p.fee_id)!.title,
        currency: fees.find((f) => f.id === p.fee_id)!.currency,
        amount: p.amount,
        paid_on: p.paid_on,
        reference: p.reference,
        notes: p.notes,
        voided: p.voided,
      })),
  );
}
