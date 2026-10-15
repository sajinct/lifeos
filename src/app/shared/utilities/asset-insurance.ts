import { AssetInsurance, AssetInsuranceInput } from '../../core/models/domain';
import { assetMoney } from './assets';
import { validLoanDate } from './loans';
import { csv } from './finance';
export function validateInsurance(input: AssetInsuranceInput) {
  const v = {
    ...input,
    title: input.title.trim(),
    provider: input.provider.trim(),
    policy_number: input.policy_number.trim(),
    currency: input.currency.trim().toUpperCase(),
    document_ids: [...new Set(input.document_ids)].sort(),
  };
  if (
    !v.asset_id ||
    !v.title ||
    v.title.length > 200 ||
    !v.provider ||
    v.provider.length > 200 ||
    v.policy_number.length > 200 ||
    v.notes.length > 4000 ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !['once', 'monthly', 'quarterly', 'yearly'].includes(v.premium_frequency) ||
    v.document_ids.length > 50 ||
    [v.title, v.provider, v.policy_number, v.notes].some((s) => s.includes('\0'))
  )
    throw new Error(
      'Check the policy title, provider, currency and details. Link up to 50 documents.',
    );
  if (
    ![v.starts_on, v.ends_on].every(
      (d) => validLoanDate(d) && d >= '1900-01-01' && d <= '2100-12-31',
    ) ||
    v.ends_on < v.starts_on
  )
    throw new Error('Choose ordered policy dates within 1900–2100.');
  const coverage_amount = assetMoney(v.coverage_amount.trim()),
    premium_amount = assetMoney(v.premium_amount.trim());
  if (coverage_amount !== null && coverage_amount <= 0)
    throw new Error('Coverage must be positive, or leave it blank.');
  return { ...v, coverage_amount, premium_amount };
}
export function insuranceStatus(p: AssetInsurance, today: string) {
  if (p.archived) return 'Archived';
  if (p.cancelled) return 'Marked cancelled';
  if (p.starts_on > today) return 'Upcoming';
  if (p.ends_on < today) return 'Ended';
  return 'Within recorded dates';
}
export function insuranceCsv(rows: AssetInsurance[], assetName: (id: string) => string) {
  return csv(
    rows.map((p) => ({
      asset: assetName(p.asset_id),
      title: p.title,
      provider: p.provider,
      policy_number: p.policy_number,
      starts_on: p.starts_on,
      ends_on: p.ends_on,
      coverage_amount: p.coverage_amount,
      premium_amount: p.premium_amount,
      currency: p.currency,
      premium_frequency: p.premium_frequency,
      cancelled: p.cancelled,
      archived: p.archived,
      notes: p.notes,
    })),
  );
}
