# VSCode Nautilus Extension

This repo provides a visual studio code extension for Nautilus that provides a right-click context menu to open a recent folder or workspace in Visual Studio Code.

Provided are two extensions, a Nautilus extension and a GTK indicator extension. The Nautilus extension provides a right-click context menu to open a recent folder or workspace in Visual Studio Code. The GTK indicator extension provides a system tray icon that allows you to open a recent folder or workspace in Visual Studio Code.

## Install Extension

```bash
wget -qO- https://github.com/ZanzyTHEbar/vscode-nautilus/blob/main/install.sh | bash
```

## Uninstall Extension

```bash
rm -f ~/.local/share/bin/vscode-indicator/vscode_workspaces_indicator.py
rm -f ~/.local/share/nautilus-python/extensions/vscode_nautilus_workspaces.py
```
