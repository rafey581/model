# Android emulator reaches the host machine at 10.0.2.2.
# A phone on the same Wi-Fi needs this host's LAN address instead, then a rebuild:
#   VITE_API_ORIGIN=http://192.168.1.20:4000 pnpm --filter @snooker/client build:app
VITE_API_ORIGIN=http://10.0.2.2:4000
