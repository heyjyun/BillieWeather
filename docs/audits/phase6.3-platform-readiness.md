# Platform readiness, 2026-11-25

Sizes marked ~ are estimates from general knowledge, not measured here; check them before installing. Free space on this Mac: 44 GB of 460 GB. Nothing was installed or downloaded.

## Found on this Mac

Apple Silicon, macOS 27.2.1, Rosetta present. Rust 1.99.1 **from Homebrew** with only the `aarch64-apple-darwin` library and no rustup; Node 24.22.1; Xcode **Command Line Tools** only (macOS SDK, swiftc). No Xcode, no iOS SDK, no Java runtime (the `java` command is the macOS stub), no Android SDK or NDK, no NSIS, no Windows tools. Code-signing identities: 0.

| Platform | State | Missing here | Storage | Licence and cost | Then possible |
| --- | --- | --- | --- | --- | --- |
| macOS Apple Silicon | **built and tested** | only for distribution: Developer ID certificate, notary profile | – | Apple Developer Program, USD 99 a year | install on other Macs without warnings |
| macOS Intel | code ready | Rust library `x86_64-apple-darwin`: rustup | ~1.5 GB | free | build `x86_64` or universal here; run under Rosetta (not the same as an Intel Mac, so a device is needed for acceptance) |
| iOS | code changed, **never compiled** | full Xcode with the iOS platform; rustup targets `aarch64-apple-ios`, `aarch64-apple-ios-sim`; CocoaPods | Xcode and one simulator ~25–40 GB; targets ~1 GB | free for the simulator and 7-day installs on your own iPhone; Developer Program for TestFlight | simulator build, own-device test |
| Android | code changed, **never compiled** | JDK 17, SDK platforms 34 and 36, build tools, NDK 27, rustup's four Android targets | ~8–12 GB; emulator image ~4–8 GB | free (SDK licences to accept); Play account USD 25 once | debug APK, emulator or device |
| Windows | code changed, **never compiled** | a Windows 10/11 machine or VM with Visual C++ Build Tools, Rust MSVC, WebView2 | ~8–10 GB there | Build Tools free under their terms; a signing certificate is paid | NSIS and MSI installers |
| Web | built and tested (Chrome) | Safari and Firefox runs | – | – | – |

## Recommendation

1. **macOS Intel:** only if you own one. rustup next to Homebrew's Rust works if the rustup one comes first in `PATH`; the native build must then be accepted again.
2. **iOS:** Xcode fits into 44 GB only just; free 30 GB first. Then `rustup target add …`, `npm run ios:init`, simulator build, OCR and Keychain tests on a device.
3. Android and Windows: the workflow `.github/workflows/universal-client.yml` already describes both builds (manual run). It needs a push and runner minutes, so it was not used.

## Done without toolchains

- Undo and Redo are in the shared client: buttons with touch targets of 44 px on phones, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z on Windows, ⌘Z / ⇧⌘Z on Apple platforms (also iPad keyboards).
- SQLite is the same bundled 3.54 everywhere; the history SQL runs in a Rust test against it.
- Version: MSI knows no "-beta", so `bundle.windows.wix.version` is `0.9.0.1`, checked by a test. iOS stores need a plain `0.9.0`; decide at the first TestFlight build.
- Layouts checked headless at 320, 360, 390, 412, 820 and 1200 px in three languages.

No statement about iOS, Android, Windows or Intel goes beyond "code exists".
