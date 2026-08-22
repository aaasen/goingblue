import type { ComponentProps } from 'react';
import type MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { DeviceCode } from '@weather/protocol';

// How the request leaves the phone, and how the reply comes back. The builder's single action
// button is whatever the selected device's `action` says, but the device is more than a button
// label: each route carries a different character set and a different amount of it, and that
// decides how the request and reply are encoded. The request says which route it came from in its
// `d:` token, and the server reads the alphabet and the reply budget straight off that — the
// numbers live in the protocol's DEVICE_TRANSPORT so both ends agree on one table.
//
// Every route now takes the widest alphabet its own unit allows, and the unit differs on each.
// Apple's satellite relay counts UTF-16 code units, so iPhone spends base32768. SMS counts
// septets, and a septet is a septet whether or not it is ASCII, so it spends the whole of GSM-7
// basic (base-124) in the same 160 characters. HTTP counts bytes, where ASCII is the densest
// thing UTF-8 carries, so internet spends every printable ASCII character (base-94) — and, having
// no length limit at all, the whole forecast rather than a fixed budget of it. inReach must be
// both GSM-7 and ASCII, so it keeps base-85. ZOLEO's gateway counts raw UTF-8 bytes — 240 to a
// message, measured — so it also keeps base-85 and spends the extra length instead. The
// protocol's devices.ts holds the measurements.
export type Device = 'internet' | 'sms' | 'inreach' | 'zoleo' | 'iphone';

export const DEVICES = [
  { value: 'internet', label: 'Internet', code: 'd', action: 'Get Forecast', icon: 'wifi' },
  { value: 'sms', label: 'SMS', code: 's', action: 'Send SMS', icon: 'message-text' },
  { value: 'inreach', label: 'inReach', code: 'g', action: 'Copy inReach Message', icon: 'satellite-variant' },
  { value: 'zoleo', label: 'ZOLEO', code: 'z', action: 'Copy ZOLEO Message', icon: 'satellite-variant' },
  { value: 'iphone', label: 'iPhone', code: 'i', action: 'Send Satellite Message', icon: 'cellphone-wireless' },
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

// The `d:` token to send. The reply budget that goes with it is no longer computed here: the
// server derives it from `d:` and `n:` off the same protocol table, so there is nothing for the
// client to state and no way for the two ends to disagree about it.
export function deviceCode(device: Device): DeviceCode {
  return DEVICES.find((d) => d.value === device)!.code;
}
