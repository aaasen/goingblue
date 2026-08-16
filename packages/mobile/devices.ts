import type { ComponentProps } from 'react';
import type MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { DEVICE_TRANSPORT, V2_HEADER_CHARS, maxCharsFor, type DeviceCode } from '@weather/protocol';

// How the request leaves the phone, and how the reply comes back. The builder's single action
// button is whatever the selected device's `action` says, but the device is more than a button
// label: each route carries a different character set and a different amount of it, and that
// decides how the request and reply are encoded. The request says which route it came from in its
// `d:` token, and the server reads the alphabet and the reply budget straight off that — the
// numbers live in the protocol's DEVICE_TRANSPORT so both ends agree on one table.
//
// Today iPhone is the only route that differs: its replies cross Apple's satellite relay, which
// is wide enough for base32768 to pay for itself (see the protocol's devices.ts for the field
// measurement). Everything else spends the base-85 GSM-7 alphabet and a 160-character reply, the
// narrowest of the routes and so the safe common denominator. ZOLEO has a code reserved in the
// protocol table — it accepts ~240 characters — but is not offered here until that is measured.
export type Device = 'internet' | 'sms' | 'inreach' | 'iphone';

export const DEVICES = [
  { value: 'internet', label: 'Internet', code: 'd', action: 'Get Forecast', icon: 'wifi' },
  { value: 'sms', label: 'SMS', code: 's', action: 'Send SMS', icon: 'message-text' },
  { value: 'inreach', label: 'inReach', code: 'g', action: 'Copy Message', icon: 'satellite-variant' },
  { value: 'iphone', label: 'iPhone', code: 'i', action: 'Send Message', icon: 'cellphone-wireless' },
] as const satisfies readonly {
  value: Device;
  label: string;
  code: DeviceCode;
  action: string;
  icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
}[];

export const DEFAULT_DEVICE: Device = 'internet';

export function isDevice(value: unknown): value is Device {
  return DEVICES.some((d) => d.value === value);
}

// The `d:` token to send, and the reply budget that goes with it. Both come from the one table
// the server reads, so a device can never ask for a length its route can't deliver.
export function deviceCode(device: Device): DeviceCode {
  return DEVICES.find((d) => d.value === device)!.code;
}

export function deviceMaxChars(device: Device, messages: number): number {
  return maxCharsFor(deviceCode(device), messages, V2_HEADER_CHARS);
}

// Only the iPhone route splits a reply across messages; for everything else the reply is one
// message and the choice would be meaningless, so the builder offers it nowhere else.
export function supportsMultiMessage(device: Device): boolean {
  return DEVICE_TRANSPORT[deviceCode(device)].alphabet === 'base32768';
}
