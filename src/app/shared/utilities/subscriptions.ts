import { Subscription, SubscriptionInput } from '../../core/models/domain';
import { reminderClock } from './reminders';
export function subscriptionToday(zone: string) {
  try {
    return reminderClock(new Date(), zone).day;
  } catch {
    return reminderClock(new Date(), 'UTC').day;
  }
}
export function subscriptionTotals(rows: Subscription[]) {
  const totals = new Map<string, number>();
  for (const s of rows.filter((s) => s.status === 'active'))
    totals.set(
      s.currency,
      (totals.get(s.currency) ?? 0) +
        Math.round(Number(s.amount) * 100) * (s.frequency === 'monthly' ? 12 : 1),
    );
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, annual]) => ({
      currency,
      annual: annual / 100,
      monthly: Math.round(annual / 12) / 100,
    }));
}
export function validateSubscription(v: SubscriptionInput) {
  if (
    !v.title.trim() ||
    v.title.trim().length > 200 ||
    !v.category.trim() ||
    v.category.trim().length > 100
  )
    throw new Error('Enter a service name and category.');
  if (
    !/^\d{1,12}(\.\d{1,2})?$/.test(v.amount) ||
    !['monthly', 'yearly'].includes(v.frequency) ||
    !/^[A-Z]{3}$/.test(v.currency)
  )
    throw new Error('Enter a valid price, currency and billing frequency.');
  const date = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (
    !date(v.next_on) ||
    (v.status === 'trial' && (!date(v.trial_ends_on) || v.next_on < v.trial_ends_on))
  )
    throw new Error('First paid renewal must be on or after the trial end.');
  if (
    !['active', 'trial'].includes(v.status) ||
    !['track', 'create', 'existing'].includes(v.link_mode)
  )
    throw new Error('Choose a subscription status and expense link.');
  if (v.notes.length > 2000 || v.provider_url.length > 500)
    throw new Error('Shorten the provider URL or notes.');
  if (v.provider_url) {
    let url: URL;
    try {
      url = new URL(v.provider_url);
    } catch {
      throw new Error('Use a valid HTTPS provider URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || /\s/.test(v.provider_url))
      throw new Error('Use an HTTPS provider URL without credentials.');
  }
  return Number(v.amount);
}
