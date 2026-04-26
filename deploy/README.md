# Starmaya Pi Deployment

Step-by-step guide for installing Starmaya on a Raspberry Pi 4B running Raspberry Pi OS 64-bit. Assumes the Pi has been freshly set up with SSH access.

## 1. System prerequisites

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git build-essential
```

`build-essential` is needed because `better-sqlite3` and `serialport` compile native bindings during `pnpm install`.

## 2. Install Node.js (LTS)

Use NodeSource's setup script — the version in Raspberry Pi OS's apt repos is too old.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # should report v22.x
```

This installs Node at `/usr/bin/node`, which is what the systemd units expect.

## 3. Install pnpm

```bash
sudo npm install -g pnpm
pnpm --version
```

## 4. Create the `roaster` system user and group

```bash
sudo groupadd --system roaster
sudo useradd --system --gid roaster --no-create-home --shell /usr/sbin/nologin roaster
sudo usermod -aG dialout roaster   # access to /dev/ttyUSB0, /dev/ttyACM0, etc.
```

The `dialout` group is the default group for serial devices on Debian-based systems. Without this, the daemon can't open the Arduino's tty even though the udev rule creates the symlink.

## 5. Clone and build

```bash
sudo mkdir -p /opt/starmaya
sudo chown $USER:$USER /opt/starmaya
git clone https://github.com/<your-user>/starmaya.git /opt/starmaya
cd /opt/starmaya
pnpm install
pnpm -r build
```

After build, the daemon's entry point is at `/opt/starmaya/packages/daemon/dist/main.js` and the server's at `/opt/starmaya/packages/server/dist/main.js` — both referenced by the systemd units.

Then transfer ownership to `roaster`:

```bash
sudo chown -R roaster:roaster /opt/starmaya
```

## 6. Create runtime directories

```bash
sudo mkdir -p /var/lib/roaster
sudo chown roaster:roaster /var/lib/roaster
```

`/run/roaster` is created automatically by systemd via the daemon unit's `RuntimeDirectory=` directive — no manual action needed.

## 7. Install the udev rule

Verify the Arduino's USB IDs first:

```bash
lsusb | grep -i arduino
# Example output: Bus 001 Device 005: ID 2341:0043 Arduino SA Uno (CDC ACM)
```

If your IDs aren't already in `99-behmor-arduino.rules`, edit the file to add a line. Then install:

```bash
sudo cp /opt/starmaya/deploy/udev/99-behmor-arduino.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Unplug and replug the Arduino, then verify:

```bash
ls -l /dev/behmor-arduino
# lrwxrwxrwx 1 root root 7 ... /dev/behmor-arduino -> ttyACM0
```

## 8. Install the systemd units

```bash
sudo cp /opt/starmaya/deploy/systemd/roaster-daemon.service /etc/systemd/system/
sudo cp /opt/starmaya/deploy/systemd/roaster-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roaster-daemon.service roaster-web.service
```

Verify both are running:

```bash
systemctl status roaster-daemon.service
systemctl status roaster-web.service
```

Tail the logs:

```bash
journalctl -u roaster-daemon -f
journalctl -u roaster-web -f
```

You should see the daemon's `device_status: connected` and the web server's `daemon_hello` and `server_listening` lines.

## 9. Smoke test from another machine on the LAN

Replace `<pi-ip>` with the Pi's LAN address (find it with `ip addr` on the Pi or check your router):

```bash
curl http://<pi-ip>:8080/api/roasts
# {"roasts":[]}
```

If you get the JSON response, open `http://<pi-ip>:8080/` in a browser. The live page should show the BT readout updating at 1 Hz from the real thermocouple.

## 10. Tailscale (for remote access)

This is optional for local-network use; required for accessing the Pi from outside the home.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Authenticate via the URL it prints. Once joined, the Pi is reachable at `http://<pi-name>.tailnet-name.ts.net:8080` from any other device on your tailnet (laptop, phone) — no public-internet exposure, no port forwarding.

If you want a friendlier URL, enable MagicDNS in the Tailscale admin console and use the short hostname.

## 11. Updating

```bash
cd /opt/starmaya
sudo -u roaster git pull
sudo -u roaster pnpm install
sudo -u roaster pnpm -r build
sudo systemctl restart roaster-daemon.service roaster-web.service
```

Restarting the daemon mid-roast will lose the in-flight reading buffer, but the web server's reconnect logic and the daemon's ring buffer minimize the gap. Restarting the web server mid-roast is safe — readings continue flowing into the daemon's ring buffer and replay on reconnect.

## Troubleshooting

**Daemon log shows `port_open_failed: ENOENT /dev/behmor-arduino`.**
The udev rule didn't fire. Check `lsusb` for the IDs, edit the rule file if needed, and run `sudo udevadm control --reload-rules && sudo udevadm trigger`. Then unplug and replug the Arduino.

**Daemon log shows `port_open_failed: EACCES`.**
The `roaster` user isn't in the `dialout` group. Fix with `sudo usermod -aG dialout roaster && sudo systemctl restart roaster-daemon`.

**Daemon log shows `read timeout after 2000ms` repeatedly.**
The Arduino isn't responding to `READ`. Either the wrong sketch is uploaded, or the post-open delay isn't long enough. Check the Arduino sketch via the IDE serial monitor (115200 baud, type `READ` and hit Enter — should return `ambient,bt,0.00,0.00`).

**Web server reports `protocol_version_too_new`.**
Daemon and web server are out of sync. Pull and rebuild on both, then restart both units.

**Browser can't reach the Pi.**
Confirm the web server is bound to `0.0.0.0:8080` (it is by default). Check that the Pi's firewall isn't blocking — Raspberry Pi OS has none by default, but UFW or iptables would. Verify with `ss -tlnp | grep 8080` on the Pi.
