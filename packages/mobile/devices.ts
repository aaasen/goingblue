import type { ComponentProps } from 'react';
import type MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

// How the request leaves the phone, and how the reply comes back. The builder's single action
// button is whatever the selected device's `action` says, but the device is more than a button
// label: each route carries a different character set and a different amount of it, and that
// decides how the request and reply are encoded. Today every device shares the base-85 GSM-7
// alphabet (see protocol constants.ts) and a 160-character reply, which is the narrowest of the
// three — the safe common denominator. As the wider sets land (SMS can spend the full GSM-7 basic
// alphabet, iPhone messaging far more than that, ZOLEO up to ~240 characters per message), the
// alphabet and capacity belong on these entries, so the selection already made here picks them up.
export type Device = 'internet' | 'sms' | 'inreach';

export const DEVICES = [
  { value: 'internet', label: 'Internet', action: 'Get Forecast', icon: 'wifi' },
  { value: 'sms', label: 'SMS', action: 'Send SMS', icon: 'message-text' },
  { value: 'inreach', label: 'inReach', action: 'Copy Message', icon: 'satellite-variant' },
] as const satisfies readonly {
  value: Device;
  label: string;
  action: string;
  icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
}[];

export const DEFAULT_DEVICE: Device = 'internet';

export function isDevice(value: unknown): value is Device {
  return DEVICES.some((d) => d.value === value);
}
