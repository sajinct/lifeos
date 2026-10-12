import {
  Asset,
  AssetInput,
  AssetDocument,
  Attachment,
  MaintenancePlan,
  MaintenanceLog,
  MaintenanceInput,
  ServiceInput,
} from '../../core/models/domain';
import { validLoanDate } from './loans';
import { csv, recurrenceDate } from './finance';
export function assetMoney(v: string): number | null {
  if (!v.trim()) return null;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(v) || Number(v) >= 1000000000000)
    throw new Error('Use a non-negative amount with up to two decimal places.');
  return Number(v);
}
function date(value: string) {
  return validLoanDate(value) && value >= '1900-01-01' && value <= '2100-12-31';
}
export function validateAsset(input: AssetInput, today: string) {
  const v = {
    ...input,
    name: input.name.trim(),
    category: input.category.trim(),
    manufacturer: input.manufacturer.trim(),
    model: input.model.trim(),
    serial_number: input.serial_number.trim(),
    location: input.location.trim(),
    currency: input.currency.trim().toUpperCase(),
    document_ids: [...new Set(input.document_ids)],
  };
  if (
    !v.name ||
    v.name.length > 200 ||
    !v.category ||
    v.category.length > 100 ||
    v.manufacturer.length > 100 ||
    v.model.length > 100 ||
    v.serial_number.length > 100 ||
    v.location.length > 200 ||
    v.notes.length > 4000 ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    v.document_ids.length > 50
  )
    throw new Error(
      'Check the asset name, category, currency and details. Link up to 50 documents.',
    );
  if (
    (v.purchased_on && (!date(v.purchased_on) || v.purchased_on > today)) ||
    (v.warranty_until &&
      (!date(v.warranty_until) || (v.purchased_on && v.warranty_until < v.purchased_on)))
  )
    throw new Error('Purchase must be today or earlier, and warranty must follow purchase.');
  assetMoney(v.purchase_price);
  return v;
}
export function validateMaintenance(v: MaintenanceInput) {
  const r = { ...v, title: v.title.trim() };
  if (
    !r.asset_id ||
    !r.title ||
    r.title.length > 200 ||
    !date(r.next_on) ||
    !['once', 'monthly', 'yearly'].includes(r.frequency) ||
    r.notes.length > 2000
  )
    throw new Error('Choose an asset, service title, valid due date and frequency.');
  return r;
}
export function validateService(v: ServiceInput, today: string) {
  if (!date(v.performed_on) || v.performed_on > today || v.notes.length > 2000)
    throw new Error('Choose a service date today or earlier and notes up to 2,000 characters.');
  return assetMoney(v.cost);
}
export function nextService(p: MaintenancePlan) {
  const next =
    p.frequency === 'once'
      ? null
      : recurrenceDate(p.anchor_on, p.frequency, p.occurrence_count + 1);
  if (next && next > '2100-12-31')
    throw new Error('Next service date exceeds supported range; change to a one-time plan.');
  return next;
}
export function assetsCsv(assets: Asset[], links: AssetDocument[], files: Attachment[]) {
  return csv(
    assets.map((a) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      manufacturer: a.manufacturer,
      model: a.model,
      serial_number: a.serial_number,
      location: a.location,
      purchased_on: a.purchased_on,
      purchase_price: a.purchase_price,
      currency: a.currency,
      warranty_until: a.warranty_until,
      status: a.status,
      notes: a.notes,
      documents: links
        .filter((l) => l.asset_id === a.id)
        .map((l) => files.find((f) => f.id === l.attachment_id)?.name ?? l.attachment_id)
        .join('; '),
    })),
  );
}
export function maintenanceCsv(plans: MaintenancePlan[], logs: MaintenanceLog[], assets: Asset[]) {
  return csv([
    ...plans.map((p) => ({
      type: 'Schedule',
      id: p.id,
      asset: assets.find((a) => a.id === p.asset_id)?.name ?? p.asset_id,
      title: p.title,
      scheduled_on: p.next_on,
      performed_on: '',
      frequency: p.frequency,
      status: p.status,
      cost: '',
      currency: '',
      notes: p.notes,
    })),
    ...logs.map((l) => ({
      type: 'Service history',
      id: l.id,
      asset: assets.find((a) => a.id === l.asset_id)?.name ?? l.asset_id,
      title: l.title,
      scheduled_on: l.scheduled_on,
      performed_on: l.performed_on,
      frequency: '',
      status: 'recorded',
      cost: l.cost,
      currency: l.currency,
      notes: l.notes,
    })),
  ]);
}
