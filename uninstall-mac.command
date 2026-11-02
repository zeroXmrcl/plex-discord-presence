#!/bin/sh
# Double-click in Finder to uninstall on macOS.
cd "$(dirname "$0")"
sh scripts/install.sh uninstall
echo
printf "Press Enter to close..."; read _
