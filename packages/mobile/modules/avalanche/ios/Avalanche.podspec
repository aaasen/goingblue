Pod::Spec.new do |s|
  s.name           = 'Avalanche'
  s.version        = '1.0.0'
  s.summary        = 'The avalanche forecast prose model (Rust, native/avalanche-ffi).'
  s.author         = ''
  s.homepage       = 'https://going.blue'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Built by native/build-mobile.sh.
  s.vendored_frameworks = 'Avalanche.xcframework'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
