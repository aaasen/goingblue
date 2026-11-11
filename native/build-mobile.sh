#!/bin/zsh
# Builds the app's avalanche library into the Expo module at packages/mobile/modules/avalanche:
# an xcframework (device + Apple silicon simulator) for iOS and an arm64 .so for Android. The
# outputs are committed, because EAS builds the app without a Rust toolchain.
# Usage: build-mobile.sh [ios|android]   (both by default)
set -eu
cd "$(dirname "$0")"
MODULE=../packages/mobile/modules/avalanche
LIB=libavalanche_ffi

ios() {
  # Matches the module's podspec.
  export IPHONEOS_DEPLOYMENT_TARGET=16.4
  for t in aarch64-apple-ios aarch64-apple-ios-sim; do
    cargo build --release -p avalanche-ffi --target $t
    # The libraries are committed; debug symbols more than double their size.
    strip -S target/$t/release/$LIB.a
  done
  rm -rf $MODULE/ios/Avalanche.xcframework
  xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/release/$LIB.a -headers avalanche-ffi/include \
    -library target/aarch64-apple-ios-sim/release/$LIB.a -headers avalanche-ffi/include \
    -output $MODULE/ios/Avalanche.xcframework
}

android() {
  export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}/ndk/27.1.12297006}
  cargo ndk -t arm64-v8a -P 24 -o $MODULE/android/src/main/jniLibs build --release -p avalanche-ffi
}

case "${1:-all}" in
  ios) ios ;;
  android) android ;;
  all) ios; android ;;
  *) echo "usage: $0 [ios|android]"; exit 1 ;;
esac
