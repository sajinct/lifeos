import { ShoppingItem, ShoppingList } from '../../core/models/domain';
import { validateShoppingItem, validateShoppingList } from './shopping';
import { recordSourceId } from './record-json-import';
export const shoppingImportMaxBytes = 5 * 1024 * 1024;
export interface ShoppingImportRow {
  source_id: string;
  kind: ShoppingList['kind'];
  title: string;
  notes: string;
  archived: boolean;
  items: Pick<
    ShoppingItem,
    'position' | 'name' | 'category' | 'quantity' | 'unit' | 'notes' | 'checked' | 'archived'
  >[];
}
export interface ShoppingImportCandidate {
  index: number;
  title: string;
  row: ShoppingImportRow | null;
  error: string;
}
export interface ShoppingImportReview {
  source_id: string;
  state: 'ready' | 'duplicate' | 'invalid';
  message: string;
}
export interface ShoppingImportResult {
  lists_imported: number;
  items_imported: number;
  skipped: number;
}
export interface ShoppingImportSource {
  rows: ShoppingImportCandidate[];
  omitted: string[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, optional = false) {
  if (optional && (v === null || v === undefined)) return '';
  if (typeof v !== 'string' || v.includes('\0')) throw new Error('Use plain text fields.');
  return v;
}
export function validateShoppingImportRow(row: ShoppingImportRow): ShoppingImportRow {
  const source_id = recordSourceId(row.source_id);
  const list = validateShoppingList({
    title: row.title,
    kind: row.kind,
    notes: row.notes,
    visibility: 'private',
  });
  if (
    typeof row.archived !== 'boolean' ||
    !Array.isArray(row.items) ||
    row.items.length > 500 ||
    new Set(row.items.map((i) => i.position)).size !== row.items.length
  )
    throw new Error('Use an archive flag and up to 500 items with unique positions.');
  const items = row.items
    .map((i) => {
      if (!Number.isInteger(i.position) || i.position < 1 || i.position > 500)
        throw new Error('Item positions must be unique integers from 1 to 500.');
      const v = validateShoppingItem({ ...i, quantity: String(i.quantity) });
      return {
        position: i.position,
        name: v.name,
        category: v.category,
        quantity: v.quantity,
        unit: v.unit,
        notes: v.notes,
        checked: v.checked,
        archived: v.archived,
      };
    })
    .sort((a, b) => a.position - b.position);
  return {
    source_id,
    kind: list.kind,
    title: list.title,
    notes: list.notes,
    archived: row.archived,
    items,
  };
}
export function parseShoppingImport(value: string): ShoppingImportSource {
  if (new TextEncoder().encode(value).length > shoppingImportMaxBytes)
    throw new Error('Choose a UTF-8 JSON file no larger than 5 MiB.');
  let root: unknown;
  try {
    root = JSON.parse(value.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (
    !object(root) ||
    !Array.isArray(root['shoppingLists']) ||
    root['shoppingLists'].length < 1 ||
    root['shoppingLists'].length > 100
  )
    throw new Error('Use a shoppingLists array with 1–100 records.');
  if (root['shoppingItems'] !== undefined && !Array.isArray(root['shoppingItems']))
    throw new Error('shoppingItems must be an array.');
  const items = (root['shoppingItems'] ?? []) as unknown[];
  if (items.length > 500) throw new Error('Import up to 500 items in total.');
  const ids = new Map<string, number>();
  for (const list of root['shoppingLists'])
    if (object(list) && typeof list['id'] === 'string' && list['id'].trim()) {
      const id = list['id'].trim();
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
  if (
    items.some(
      (i) => !object(i) || typeof i['list_id'] !== 'string' || !ids.has(i['list_id'].trim()),
    )
  )
    throw new Error('Every item must refer to an included shopping list ID.');
  const rows = root['shoppingLists'].map((list, index) => {
    let title = `Shopping list ${index + 1}`;
    try {
      if (!object(list)) throw new Error('Shopping list must be an object.');
      title = text(list['title']);
      const source_id = recordSourceId(list['id']);
      if ((ids.get(source_id) ?? 0) > 1)
        throw new Error('Source shopping list IDs must be unique.');
      const children = items
        .filter((i) => object(i) && String(i['list_id']).trim() === source_id)
        .map((i) => {
          if (!object(i)) throw new Error('Item must be an object.');
          if (typeof i['quantity'] !== 'string' && typeof i['quantity'] !== 'number')
            throw new Error('Use a number or decimal string for quantities.');
          const v = validateShoppingItem({
            name: text(i['name']),
            category: text(i['category'] ?? 'Other'),
            quantity: String(i['quantity']),
            unit: text(i['unit']),
            notes: text(i['notes'], true),
            checked: (i['checked'] ?? false) as boolean,
            archived: (i['archived'] ?? false) as boolean,
          });
          return { ...v, position: i['position'] as number };
        });
      const row = validateShoppingImportRow({
        source_id,
        kind: list['kind'] as ShoppingList['kind'],
        title,
        notes: text(list['notes'], true),
        archived: (list['archived'] ?? false) as boolean,
        items: children,
      });
      return { index, title: row.title, row, error: '' };
    } catch (e) {
      return {
        index,
        title,
        row: null,
        error: e instanceof Error ? e.message : 'Invalid shopping list.',
      };
    }
  });
  return {
    rows,
    omitted: Object.keys(root).filter((k) => !['shoppingLists', 'shoppingItems'].includes(k)),
  };
}
export function shoppingImportTemplate() {
  return JSON.stringify(
    {
      shoppingLists: [
        {
          id: 'example-groceries',
          kind: 'grocery',
          title: 'Replace this grocery list',
          notes: '',
          archived: false,
        },
      ],
      shoppingItems: [
        {
          list_id: 'example-groceries',
          position: 1,
          name: 'Replace this item',
          category: 'Groceries',
          quantity: '1.250',
          unit: 'kg',
          notes: '',
          checked: false,
          archived: false,
        },
      ],
    },
    null,
    2,
  );
}
