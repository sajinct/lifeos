import { Component, input, computed } from '@angular/core';
const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  inbox: 'M4 4h16l2 12h-6l-2 3h-4l-2-3H2z',
  task: 'M9 5h12 M9 12h12 M9 19h12 M3 5l1 1 2-2 M3 12l1 1 2-2 M3 19l1 1 2-2',
  calendar: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 18h2',
  wallet: 'M3 5h16v15H3z M3 8h17v9h-6V8 M16 12h1',
  project: 'M3 7V4h7l2 3h9v13H3z',
  family:
    'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M16 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M2 20v-2a6 6 0 0 1 12 0v2 M16 13a5 5 0 0 1 6 5v2',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M9 13h6 M9 17h6',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  repeat: 'M3 8h15l-3-3 M21 16H6l3 3 M21 8v4 M3 16v-4',
  contacts: 'M4 3h16v18H4z M8 9a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M7 18a5 5 0 0 1 10 0',
  goal: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10 M12 11v2 M11 12h2',
  note: 'M5 3h14v18H5z M9 7h6 M9 11h6 M9 15h4',
  chart: 'M4 3v18h17 M8 16v-5 M13 16V6 M18 16v-8',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  bell: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 20h4',
  moon: 'M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  up: 'M6 16l10-10 M7 6h9v9',
  trend: 'M3 17l6-6 4 4 8-10 M15 5h6v6',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  logout: 'M10 3H4v18h6 M9 12h12 M17 8l4 4-4 4',
  spark: 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
  leaf: 'M20 3C7 2 2 9 5 16s16 6 15-13z M5 20L16 9',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
  dots: 'M5 12h.1 M12 12h.1 M19 12h.1',
  lock: 'M6 10h12v11H6z M8 10V7a4 4 0 0 1 8 0v3',
  coffee: 'M4 8h12v7a6 6 0 0 1-12 0z M16 8h2a3 3 0 0 1 0 6h-2 M3 22h15 M7 2v3 M12 2v3',
  arrowDown: 'M12 5v14 M7 14l5 5 5-5',
  trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  edit: 'M14 4l6 6 M4 20l4-1L21 6l-4-4L4 15z',
};
@Component({
  selector: 'app-icon',
  template:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path()"/></svg>',
  styles:
    ':host{display:inline-flex;width:20px;height:20px;flex-shrink:0}svg{width:100%;height:100%}',
})
export class Icon {
  readonly name = input('grid');
  readonly path = computed(() => paths[this.name()] ?? paths['grid']);
}
