import {
  HealthInput,
  HealthAppointment,
  HealthDocument,
  Attachment,
} from '../../core/models/domain';
import { supportedDate } from './habits';
import { csv } from './finance';
export function emptyHealth(today: string): HealthInput {
  return {
    title: '',
    provider: '',
    location: '',
    appointment_on: today,
    appointment_time: '',
    notes: '',
    status: 'scheduled',
    document_ids: [],
  };
}
export function validateHealth(input: HealthInput, today: string) {
  const v = {
    ...input,
    title: input.title.trim(),
    provider: input.provider.trim(),
    location: input.location.trim(),
    document_ids: [...new Set(input.document_ids)],
  };
  if (
    !v.title ||
    v.title.length > 200 ||
    v.provider.length > 200 ||
    v.location.length > 300 ||
    v.notes.length > 4000 ||
    !supportedDate(v.appointment_on) ||
    (v.appointment_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.appointment_time)) ||
    !['scheduled', 'completed', 'cancelled'].includes(v.status) ||
    (v.status === 'completed' && v.appointment_on > today) ||
    v.document_ids.length > 50
  )
    throw new Error(
      'Enter a title, valid date/time and status with up to 50 documents. Completed visits cannot be in the future.',
    );
  return v;
}
export function healthDetails(v: HealthInput) {
  const { document_ids, ...fields } = v;
  void document_ids;
  return fields;
}
export function healthCsv(rows: HealthAppointment[], links: HealthDocument[], files: Attachment[]) {
  return csv(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      provider: r.provider,
      location: r.location,
      appointment_on: r.appointment_on,
      appointment_time: r.appointment_time,
      status: r.status,
      archived: r.archived,
      notes: r.notes,
      documents: links
        .filter(
          (l) =>
            l.appointment_id === r.id &&
            l.workspace_id === r.workspace_id &&
            l.owner_id === r.owner_id,
        )
        .map(
          (l) =>
            files.find(
              (f) =>
                f.id === l.attachment_id &&
                f.owner_id === r.owner_id &&
                f.workspace_id === r.workspace_id,
            )?.name ?? l.attachment_id,
        )
        .join('; '),
    })),
  );
}
