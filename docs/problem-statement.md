# Problem Statement

## Context

The author is a home coffee roaster with a Behmor 2000AB Plus electric drum roaster and a temperature monitoring rig consisting of:

- A K-type thermocouple probe installed through the chamber wall of the roaster, positioned in the bean mass area
- An Adafruit MAX31855 breakout board amplifying the thermocouple signal
- An Arduino Uno reading the MAX31855 over SPI and exposing temperature readings over USB serial
- An Artisan-compatible TC4 protocol sketch on the Arduino (responds to `READ`, `CHAN;xxxx`, `UNITS;x`, etc. over 115200 baud serial)

Today, the Arduino connects via USB to a laptop running Artisan, the de facto open-source roasting software. Artisan logs the temperature curve, computes Rate of Rise (RoR), and lets the roaster mark time-critical events (CHARGE, First Crack start, First Crack end, DROP) during the roast.

## Why a new app

Artisan works, but it is a desktop GUI application (Python/PyQt), not a web app. The best path to running it on an always-on Raspberry Pi is Pi + VNC + Artisan's built-in WebLCDs feature, which has real tradeoffs:

- Requires a VNC client on whatever device is used for roasting. Works on macOS via built-in Screen Sharing, workable on iPad, awkward on phone.
- No access from outside the home network without additional tooling.
- WebLCDs shows temperatures only — all actual roast control (CHARGE, FCs, DROP event marking, saving profiles, reviewing history) still requires the desktop GUI.
- Single-device-at-a-time control surface. Awkward to have temperatures visible on a phone while marking events on a laptop.

A native web application fixes all of this: accessible from any browser, trivial to reach from outside the LAN (via Tailscale), naturally multi-device, no client software to install anywhere.

No credible open-source web-native Artisan alternative exists as of this project's start. Prior art in this space is Artisan itself, Artisan-adjacent DIY microcontroller firmware, closed commercial platforms like Cropster, or small standalone roast loggers with no serious UI. There is a clear gap for something purpose-built for the web that handles the actual core workflow.

## Project nature

This is a hobby project. Explicitly:

- **Not a product.** At most, a public GitHub repo available to anyone enthusiastic or crazy enough to use it on a "buyer beware" basis.
- **Single-user, single-roaster.** No multi-tenancy, no accounts beyond what Tailscale provides for remote access.
- **Educational / edification focus.** The journey matters as much as the destination. Choosing tools that are enjoyable to work with is a legitimate criterion.
- **No ship pressure.** Weeknight and weekend hacking. Open-ended timeline.
- **Future roaster control is aspirational, not imminent.** The author is less comfortable on the hardware side than the software side.

## Project goal

Build a web application that reproduces the core functionality of Artisan needed for the author's home roasting workflow, deployed such that it is accessible over the internet from anywhere (via Tailscale, not public exposure).

"Core functionality" explicitly does not mean "all of Artisan." Artisan supports 200+ roaster/device configurations, PID control, Modbus, profile designers, Cropster imports, energy/CO2 tracking, and a dozen other features this project does not use. The goal is to replace the ~20% of Artisan actually touched during a home roast on a single roaster with a single thermocouple.

## Must-have functionality (MVP)

1. **Connect to the Arduino via serial, speaking the TC4 protocol**, and read temperature at ~1 Hz.
2. **Display a live temperature curve** (BT — Bean Temperature) that updates as the roast proceeds.
3. **Compute and display Rate of Rise (RoR)** — the derivative of the temperature curve, typically smoothed.
4. **Record the roast** with millisecond-precision timestamps from the moment the user hits CHARGE through the moment they hit DROP.
5. **Mark time-critical events** with button presses: CHARGE, DRY end, First Crack start (FCs), First Crack end (FCe), DROP. Latency from button press to recorded timestamp needs to be very low (<100 ms).
6. **Persist the roast profile** on the server side with metadata (coffee name, batch weight, notes, etc.).
7. **View historical roasts** as overlay/comparison to the current roast in progress (Artisan calls this "background profile").
8. **Be accessible from any browser on the LAN**, with a path to making it accessible over the internet.

## Nice-to-have

- Multiple simultaneous client sessions showing the same roast (temp readout on phone while marking events on laptop).
- Phase LCDs (drying/maillard/development time-in-phase stats during the roast).
- Audible/visual alarms at configurable temperature thresholds.
- Mobile-friendly layout for the control surface.

## Explicitly out of scope for v1

- **PID control of the roaster.** The Behmor does not expose heat control anyway; this would require hardware mods beyond current scope.
- **Support for roasters other than the Behmor** or thermocouple setups other than the one described.
- **Inventory / green bean tracking** (Artisan.plus territory).
- **Multi-user auth / sharing** (single-user / single-roaster for now).
- **Native mobile apps** (PWA is fine if needed; otherwise just responsive web).
- **Artisan `.alog` format export or import.** Explicitly dropped — not needed.
- **Public-internet exposure with proper auth, TLS, reverse proxies.** Tailscale solves remote access; no need for a public URL.

## Key constraints and non-negotiables

1. **Reliability during a live roast is paramount.** A roast takes 10–15 minutes and uses expensive green coffee. If the app crashes at minute 8, the roast is lost. This means: the serial-reading process must survive browser disconnects, connection drops must not interrupt data logging, and event markers must be recorded locally even if the UI is momentarily laggy.

2. **Time-critical event logging.** FCs happens in a ~10-second window and its exact timing matters for roast analysis. The path from button click → timestamp recorded must be fast and robust, even under bad network conditions. Events should be buffered client-side and reconciled if the connection blips.

3. **Safety considerations around internet exposure.** This app is connected (via the Pi/server) to hardware that is near a heat source and a fire hazard (coffee chaff is flammable). Even if v1 does not *control* the roaster, future versions might. The architecture must not make it easy to accidentally expose dangerous control surfaces to the public internet. Tailscale-only remote access is a deliberate choice that keeps the app unreachable from the open web.

4. **Offline-capable for the local LAN case.** The app must be usable during a roast even if the internet connection drops. The core loop (read temps, log events, display graph) must work entirely on the local network without any cloud dependency.

5. **Existing hardware must not be replaced.** The Arduino + MAX31855 + thermocouple is working and speaking the TC4 protocol. The web app speaks TC4 on the serial side; no re-flashing or re-wiring required.

## Available assets

- **Hardware:** Behmor 2000AB Plus, Arduino Uno + MAX31855 + K-type thermocouple, verified working with TC4 protocol sketch.
- **Compute:** Raspberry Pi 4B (4GB) available as the always-on host.
- **Network:** Home LAN, WiFi at the roasting location. Tailscale available for remote access.
- **Developer skill:** Experienced software engineer. Strong preference for TypeScript/Node; also fluent in Python. The project settled on end-to-end TypeScript — see `architecture.md` for the reasoning.

## Reference material

- **Artisan source code** (open source, Python): https://github.com/artisan-roaster-scope/artisan
- **TC4 serial protocol spec:** https://github.com/greencardigan/TC4-shield/blob/master/applications/Artisan/aArtisan/trunk/src/aArtisan/commands.txt
- **TC4 emulator example** (clean reference for the Arduino side): https://github.com/FilePhil/TC4-Emulator
