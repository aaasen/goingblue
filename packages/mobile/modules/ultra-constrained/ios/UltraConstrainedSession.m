#import <Foundation/Foundation.h>
#import <React/RCTHTTPRequestHandler.h>

// Lets JS fetch run over carrier satellite links. URLSession keeps requests off ultra-constrained
// paths unless the session opts in, and React Native builds its session from the default
// configuration. A provider replaces React Native's own configuration wholesale, so its cookie
// settings are repeated here. Installed from +load so it is in place before the first request
// creates the session.
@interface UltraConstrainedSession : NSObject
@end

@implementation UltraConstrainedSession

+ (void)load
{
  RCTSetCustomNSURLSessionConfigurationProvider(^NSURLSessionConfiguration * {
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    [configuration setHTTPShouldSetCookies:YES];
    [configuration setHTTPCookieAcceptPolicy:NSHTTPCookieAcceptPolicyAlways];
    [configuration setHTTPCookieStorage:[NSHTTPCookieStorage sharedHTTPCookieStorage]];
    if (@available(iOS 26.1, *)) {
      configuration.allowsUltraConstrainedNetworkAccess = YES;
    }
    return configuration;
  });
}

@end
