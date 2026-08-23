#!/usr/bin/env bash
set -euo pipefail

install_root=/opt/blackbox-airspace
source_root=/usr/local/src/readsb-blackbox
run_root=/run/readsb-blackbox

sudo apt-get update
sudo apt-get install -y --no-install-recommends build-essential git libncurses-dev libzstd-dev pkg-config zlib1g-dev

if [[ ! -d "$source_root/.git" ]]; then
  sudo git clone --depth 20 https://github.com/wiedehopf/readsb.git "$source_root"
else
  sudo git -C "$source_root" fetch --depth 20 origin dev
  sudo git -C "$source_root" reset --hard origin/dev
fi
sudo make -C "$source_root" -j"$(nproc)"
sudo install -Dm755 "$source_root/readsb" "$install_root/bin/readsb"

sudo tee /etc/systemd/system/readsb-blackbox.service >/dev/null <<'UNIT'
[Unit]
Description=BlackBox receive-only ADS-B decoder
After=network.target

[Service]
Type=simple
ExecStart=/opt/blackbox-airspace/bin/readsb --net --net-only --net-bind-address=127.0.0.1 --net-ri-port=30001 --write-json=/run/readsb-blackbox --write-json-every=1
Restart=always
RestartSec=2
RuntimeDirectory=readsb-blackbox
RuntimeDirectoryMode=0755
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/run/readsb-blackbox

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now readsb-blackbox.service
systemctl --no-pager --full status readsb-blackbox.service
