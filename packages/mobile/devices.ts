import type { ComponentProps } from 'react';
import type MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { DEVICE_TRANSPORT, type DeviceCode } from '@weather/protocol';

// How the request leaves the phone, and how the reply comes back. The builder's single action
// button is whatever the selected device's `action` says, but the device is more than a button
// label: each route carries a different character set and a different amount of it, and that
// decides how the request and reply are encoded. The request says which route it came from in its
// `d:` token, and the server reads the alphabet and the reply budget straight off that — the
// numbers live in the protocol's DEVICE_TRANSPORT so both ends agree on one table.
//
// Two routes differ today, each because a field run said so. iPhone replies cross Apple's
// satellite relay, which is wide enough for base32768 to pay for itself. SMS replies are capped
// by the septet rather than the frame, so they spend the whole of GSM-7 basic (base-124) rather
// than only its intersection with ASCII — same 160 characters, more in each one. The protocol's
// devices.ts holds both measurements. Internet and inReach keep base-85, the safe common
// denominator; ZOLEO has a code reserved in the protocol table — it accepts ~240 characters — but
// is not offered here until that is measured.
export type Device = 'internet' | 'sms' | 'inreach' | 'iphone';

export const DEVICES = [
  { value: 'internet', label: 'Internet', code: 'd', action: 'Get Forecast', icon: 'wifi' },
  { value: 'sms', label: 'SMS', code: 's', action: 'Send SMS', icon: 'message-text' },
  { value: 'inreach', label: 'inReach', code: 'g', action: 'Copy inReach Message', icon: 'satellite-variant' },
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

// Only the iPhone route splits a reply across messages; for everything else the reply is one
// message and the choice would be meaningless, so the builder offers it nowhere else.
export function supportsMultiMessage(device: Device): boolean {
  return DEVICE_TRANSPORT[deviceCode(device)].alphabet === 'base32768';
}
