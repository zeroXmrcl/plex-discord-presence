#!/bin/sh
# Double-click in Finder to install on macOS.
cd "$(dirname "$0")"
sh scripts/install.sh install
echo
printf "Press Enter to close..."; read _
