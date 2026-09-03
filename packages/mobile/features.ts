// Feature flags: switches for parts of the app that are built but not on. Each one names what it
// gates and why it sits where it does, so turning one on (or into a Settings preference) is a
// one-line change here rather than a search through the screens.

// The coordinates field under the builder's map. Off: with a bundled basemap and regional
// downloads, the map is the way to pick a point, and the field cost every reader a row for a
// paste path few of them use. The field and its state stay wired so it can come back as-is, or
// as an optional feature.
export const SHOW_COORDINATES = false;
