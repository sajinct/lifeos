import {
  ShoppingList,
  ShoppingItem,
  ShoppingListInput,
  ShoppingItemInput,
} from '../../core/models/domain';
import { csv } from './finance';
export function validateShoppingList(input: ShoppingListInput) {
  const v = { ...input, title: input.title.trim() };
  if (
    !v.title ||
    v.title.length > 200 ||
    v.title.includes('\0') ||
    !['grocery', 'shopping'].includes(v.kind) ||
    v.notes.length > 2000 ||
    v.notes.includes('\0') ||
    !['private', 'workspace'].includes(v.visibility)
  )
    throw new Error('Enter valid shopping list details.');
  return v;
}
export function validateShoppingItem(input: ShoppingItemInput) {
  const v = {
    ...input,
    name: input.name.trim(),
    category: input.category.trim(),
    unit: input.unit.trim(),
    quantity: input.quantity.trim(),
  };
  if (
    !v.name ||
    v.name.length > 200 ||
    !v.category ||
    v.category.length > 60 ||
    !v.unit ||
    v.unit.length > 30 ||
    [v.name, v.category, v.unit, v.notes].some((s) => s.includes('\0')) ||
    v.notes.length > 2000 ||
    !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,3})?$/.test(v.quantity) ||
    Number(v.quantity) <= 0 ||
    Number(v.quantity) > 1000000 ||
    typeof v.checked !== 'boolean' ||
    typeof v.archived !== 'boolean'
  )
    throw new Error('Enter valid item details and a positive quantity with up to three decimals.');
  return { ...v, quantity: Number(v.quantity) };
}
export function shoppingProgress(items: ShoppingItem[]) {
  const current = items.filter((i) => !i.archived),
    checked = current.filter((i) => i.checked).length;
  return {
    total: current.length,
    checked,
    remaining: current.length - checked,
    percent: current.length ? Math.round((checked / current.length) * 100) : 0,
  };
}
export function shoppingCsv(lists: ShoppingList[], items: ShoppingItem[]) {
  return csv(
    items
      .filter((i) => lists.some((l) => l.id === i.list_id && l.workspace_id === i.workspace_id))
      .map((i) => {
        const l = lists.find((l) => l.id === i.list_id)!;
        return {
          list: l.title,
          list_type: l.kind,
          sharing: l.visibility,
          list_archived: l.archived,
          item: i.name,
          category: i.category,
          quantity: i.quantity,
          unit: i.unit,
          notes: i.notes,
          checked: i.checked,
          checked_at: i.checked_at ?? '',
          item_archived: i.archived,
        };
      }),
  );
}
