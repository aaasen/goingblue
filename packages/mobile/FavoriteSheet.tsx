import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { formatLatLon, type LatLon } from './coords';
import { palette } from './palette';

// Longest name a favorite takes. The name is drawn on the map and leads a past-forecast row, and
// both have room for a place name, not a sentence.
const NAME_MAX = 40;

interface Props {
  // The point being saved, shown under the title so the reader can see what the name will attach to.
  coord: LatLon;
  onSave: (name: string) => void;
  onClose: () => void;
}

// The sheet every favorite is saved through: the map's star opens it on the marked point. A card
// on a scrim rather than Alert.prompt, which exists on iOS only. A favorite needs a name, so Save
// stays off until there is one. Mounted only while open, so the field starts empty each time.
export default function FavoriteSheet({ coord, onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const canSave = name.trim().length > 0;
  const save = () => { if (canSave) onSave(name); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Neither Pressable is an accessibility element: one that was would swallow the field
            and buttons inside it. The card's own Pressable keeps a tap on the card from reaching
            the scrim under it. */}
        <Pressable style={styles.scrim} onPress={onClose} accessible={false}>
          <Pressable style={styles.card} accessible={false}>
            <Text style={styles.title}>Add favorite</Text>
            <Text style={styles.coords}>{formatLatLon(coord)}</Text>
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              accessibilityLabel="Name"
              maxLength={NAME_MAX}
              autoFocus
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
  coords: { marginTop: 2, fontSize: 13, color: palette.textSecondary, fontVariant: ['tabular-nums'] },
  label: { marginTop: 14, marginBottom: 6, fontSize: 13, fontWeight: '600', color: palette.textSecondary },
  input: {
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: palette.text,
    borderWidth: StyleSheet.hairlineWidth, borderColor: palette.cardRule, borderRadius: 8,
  },
  buttons: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 20 },
  button: { fontSize: 16, color: palette.link },
  save: { fontWeight: '600' },
  disabled: { color: palette.textTertiary },
});
