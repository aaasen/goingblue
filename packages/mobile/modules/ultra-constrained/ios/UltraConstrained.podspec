Pod::Spec.new do |s|
  s.name           = 'UltraConstrained'
  s.version        = '1.0.0'
  s.summary        = 'Reports whether the network path is ultra-constrained (carrier satellite).'
  s.author         = ''
  s.homepage       = 'https://going.blue'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
