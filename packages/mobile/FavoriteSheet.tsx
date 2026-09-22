import { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { formatCoords, type LatLon, parseLatLon } from './coords';
import type { CoordFormat } from './settings';
import { palette } from './palette';

// Longest name a favorite takes. The name is drawn on the map and leads a past-forecast row, and
// both have room for a place name, not a sentence.
const NAME_MAX = 40;

interface Props {
  // The point to start from, written into the Coordinates field. Omitted, the field starts empty.
  coord?: LatLon | null;
  coordFormat: CoordFormat;
  onSave: (name: string, coord: LatLon) => void;
  onClose: () => void;
}

// The sheet every favorite is saved through: the map's star opens it on the marked point, the
// list's Add opens it empty. Either way the point can be typed over. A card on a scrim rather
// than Alert.prompt, which exists on iOS only. A favorite needs a name and a point, so Save stays
// off until it has both. Mounted only while open, so the fields start fresh each time.
export default function FavoriteSheet({ coord = null, coordFormat, onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const [initialText] = useState(() => (coord ? formatCoords(coord, coordFormat) : ''));
  const [coordsText, setCoordsText] = useState(initialText);
  const nameRef = useRef<TextInput>(null);
  const typed = useMemo(() => parseLatLon(coordsText), [coordsText]);
  const coordsInvalid = coordsText.trim().length > 0 && typed == null;
  // The written form is rounded, so an untouched field saves the exact point it was given and
  // the favorite lands on the pin rather than a hair off it.
  const point = coord && coordsText === initialText ? coord : typed;
  const canSave = name.trim().length > 0 && point != null;
  const save = () => { if (canSave) onSave(name, point); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Neither Pressable is an accessibility element: one that was would swallow the field
            and buttons inside it. The card's own Pressable keeps a tap on the card from reaching
            the scrim under it. */}
        <Pressable style={styles.scrim} onPress={onClose} accessible={false}>
          <Pressable style={styles.card} accessible={false}>
            <Text style={styles.title}>Add favorite</Text>
            <Text style={styles.label}>Coordinates</Text>
            <TextInput
              style={[styles.input, coordsInvalid && styles.inputInvalid]}
              value={coordsText}
              onChangeText={setCoordsText}
              accessibilityLabel="Coordinates"
              placeholder="lat, lon or UTM"
              placeholderTextColor={palette.textTertiary}
              keyboardType="numbers-and-punctuation"
              autoFocus={coord == null}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => nameRef.current?.focus()}
            />
            <Text style={styles.label}>Name</Text>
            {/* Focus lands on whichever field is still empty: the name when the point came in
                with the sheet, the coordinates otherwise. */}
            <TextInput
              ref={nameRef}
              style={styles.input}
              value={name}
              onChangeText={setName}
              accessibilityLabel="Name"
              maxLength={NAME_MAX}
              autoFocus={coord != null}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={save}
            />
            <View style={styles.buttons}>
              <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={HIT}>
                <Text style={styles.button}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={save} disabled={!canSave} accessibilityRole="button" hitSlop={HIT}>
                <Text style={[styles.button, styles.save, !canSave && styles.disabled]}>Save</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const HIT = { top: 10, bottom: 10, left: 8, right: 8 };

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 360, backgroundColor: palette.card, borderRadius: 14, padding: 18 },
  title: { fontSize: 17, fontWeight: '600', color: palette.text },
  label: { marginTop: 14, marginBottom: 6, fontSize: 13, fontWeight: '600', color: palette.textSecondary },
  input: {
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: palette.text,
    borderWidth: StyleSheet.hairlineWidth, borderColor: palette.cardRule, borderRadius: 8,
  },
  // Flagged the way the builder's field flags a bad entry: in the text, nothing resizes.
  inputInvalid: { color: palette.destructive },
  buttons: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 20 },
  button: { fontSize: 16, color: palette.link },
  save: { fontWeight: '600' },
  disabled: { color: palette.textTertiary },
});
