// The app's colors by role. Every screen except the meteogram reads its colors from `palette`;
// the meteogram carries its own, tuned against its panels.
//
// Roles come in two families. `page*` colors sit directly on the page background; card/sheet
// colors sit on the white surfaces (lists, cards, the ⓘ sheets).

import type { StatusBarStyle } from 'expo-status-bar';

export interface Palette {
  // The bar style that reads against `page`.
  statusBar: StatusBarStyle;

  // Page ground and what sits on it directly.
  page: string;
  brand: string;
  // Screen titles and the bold run inside page copy.
  pageTitle: string;
  pageHeading: string;
  pageText: string;
  pageTextSecondary: string;
  pageTextTertiary: string;
  // A note under a control or section.
  pageNote: string;
  pageLabel: string;
  // The lighter uppercase heading the sheets use.
  pageLabelLight: string;
  pageLink: string;
  pageIcon: string;
  pageRule: string;
  pageRuleLight: string;
  // A quiet, flat control on the page (the Clear button beside Paste).
  pageChip: string;
  pageChipBorder: string;
  pageChipText: string;
  // The past-forecast row that is currently loaded.
  selectedRow: string;
  selectedRowBorder: string;

  // White surfaces: cards, list rows, the ⓘ sheets.
  card: string;
  cardInset: string;
  // A recessed well inside a card (the phone number box).
  cardWell: string;
  cardRule: string;
  sheet: string;
  text: string;
  textBody: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  textFaint: string;
  link: string;
  linkTint: string;

  // Filled buttons, on the page and in cards.
  primary: string;
  onPrimary: string;
  primaryDisabled: string;

  // The system segmented control's labels; the track and thumb stay the system's own.
  segmentText?: string;
  segmentSelectedText?: string;
  // The in-card toggle (PreferenceRows).
  toggleTrack: string;
  toggleSelected: string;
  toggleText: string;
  toggleSelectedText: string;
  // Switches.
  switchOn?: string;
  switchOff?: string;

  success: string;
  successTint: string;
  danger: string;
  dangerTint: string;
  // Destructive actions and invalid input.
  destructive: string;
  // The received-segment chips under a multi-message paste.
  collectTint: string;
  collectBorder: string;
  collectCheck: string;
}

// The iOS system grays and the original blue. Leaves the segmented controls and switches to the
// system, which is why those roles are optional.
const system: Palette = {
  statusBar: 'dark',
  page: '#f2f2f7',
  brand: '#2a6bb5',
  pageTitle: '#1c1c1e',
  pageHeading: '#6e6e73',
  pageText: '#3a3a3c',
  pageTextSecondary: '#636366',
  pageTextTertiary: '#8e8e93',
  pageNote: '#6e6e73',
  pageLabel: '#6e6e73',
  pageLabelLight: '#8e8e93',
  pageLink: '#2a6bb5',
  pageIcon: '#6e6e73',
  pageRule: '#d1d1d6',
  pageRuleLight: '#e5e5ea',
  pageChip: '#f2f2f7',
  pageChipBorder: '#d1d1d6',
  pageChipText: '#636366',
  selectedRow: '#e8f1fb',
  selectedRowBorder: '#c7dff5',
  card: '#ffffff',
  cardInset: '#fafafc',
  cardWell: '#f2f2f7',
  cardRule: '#d1d1d6',
  sheet: '#ffffff',
  text: '#1c1c1e',
  textBody: '#3a3a3c',
  textSecondary: '#6e6e73',
  textTertiary: '#8e8e93',
  textDisabled: '#aeaeb2',
  textFaint: '#c7c7cc',
  link: '#2a6bb5',
  linkTint: '#eef3fa',
  primary: '#2a6bb5',
  onPrimary: '#ffffff',
  primaryDisabled: '#aeaeb2',
  toggleTrack: '#e5e5ea',
  toggleSelected: '#ffffff',
  toggleText: '#6e6e73',
  toggleSelectedText: '#1c1c1e',
  success: '#2a8f5a',
  successTint: '#e8f5ec',
  danger: '#c03030',
  dangerTint: '#fde8e8',
  destructive: '#cc2222',
  collectTint: '#e8f6ec',
  collectBorder: '#34a853',
  collectCheck: '#2e8b48',
};

export const palette: Palette = system;

// Props that give the system segmented control the palette's text colors. Only the text: once
// the control is handed a track or tint color, iOS drops the inset, shadowed thumb and draws a
// flat one.
export const SEGMENT_PROPS = palette.segmentText && palette.segmentSelectedText
  ? { fontStyle: { color: palette.segmentText }, activeFontStyle: { color: palette.segmentSelectedText } }
  : {};

// Props that give a Switch the palette's colors.
export const SWITCH_PROPS = palette.switchOn && palette.switchOff
  ? { trackColor: { true: palette.switchOn, false: palette.switchOff }, ios_backgroundColor: palette.switchOff }
  : {};
