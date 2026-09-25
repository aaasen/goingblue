import { memo } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import Section from '../Section';
import { DEVICES, type Device } from '../devices';
import { palette, SEGMENT_PROPS, SWITCH_PROPS } from '../palette';

// The device selector, shared by the weather builder and the Avalanche tab. The multi-message
// switch is weather-only.
const DeviceSelector = memo(function DeviceSelector({
  device, onDevice, setDeviceInfo, multiMessageShown = false, twoMessages = false, onTwoMessagesChange,
}: {
  device: Device; onDevice: (device: Device) => void; setDeviceInfo: (open: boolean) => void;
  multiMessageShown?: boolean; twoMessages?: boolean; onTwoMessagesChange?: (on: boolean) => void;
}) {
  return (
    <Section label="Device" info={() => setDeviceInfo(true)}>
      <SegmentedControl
        {...SEGMENT_PROPS}
        values={DEVICES.map((d) => d.label)}
        selectedIndex={DEVICES.findIndex((d) => d.value === device)}
        onChange={(e) => onDevice(DEVICES[e.nativeEvent.selectedSegmentIndex].value)}
      />
      {/* A switch rather than an On/Off segment: this is one setting being turned on, not a
          choice between two things, and it is read far more often than it is changed. */}
      {multiMessageShown && (
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>Multi-message forecast</Text>
            <Text style={styles.switchHint}>Use multiple messages for more range and detail</Text>
          </View>
          <Switch
            {...SWITCH_PROPS}
            style={styles.switchAlign}
            value={twoMessages}
            onValueChange={onTwoMessagesChange}
            accessibilityLabel="Multi-message forecast"
            accessibilityHint="Use multiple messages for more range and detail"
          />
        </View>
      )}
    </Section>
  );
});

export default DeviceSelector;

const styles = StyleSheet.create({
  // A settings row: label left, switch right, the switch's own height setting the row's.
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginTop: 16,
  },
  switchText: { flexShrink: 1 },
  switchLabel: { fontSize: 15, color: palette.pageTitle },
  switchHint: { fontSize: 12, color: palette.pageTextTertiary, lineHeight: 17, marginTop: 2 },
  // Switch composes alignSelf: 'flex-start' into its own iOS style, which on a row means the
  // top rather than the start, and beats the row's alignItems.
  switchAlign: { alignSelf: 'center' },
});
